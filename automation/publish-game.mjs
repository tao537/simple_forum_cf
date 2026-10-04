#!/usr/bin/env node
/**
 * 苦海 · 娱乐游戏 —— 一键自动发布游戏推荐帖
 * 流程：读取 queue/*.json → ollama 生成推荐文案 → 云端 AI 润色（可选）
 *       → 截图上传 KV（可选）→ 游戏站 API 发帖 → 归档到 published/
 * 截图：screenshots 的每一项可以是 ——
 *       ① 本地路径（相对清单文件）：原有行为不变，缺失即中止本条；
 *       ② http(s) URL：先直连下载（10s），失败再走代理下载（30s）；
 *          代理优先级 .env 的 HTTPS_PROXY → config.json 的 network.proxy → 内置 7890；
 *          下载落在 /tmp/publish-game-cache/，单张失败只跳过不中止，每条最多 5 张。
 * 运行：node publish-game.mjs
 * 环境：Node 18+（内置 fetch），无需安装依赖
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const QUEUE_DIR = join(ROOT, 'queue');
const PUB_DIR = join(ROOT, 'published');
const CACHE_DIR = '/tmp/publish-game-cache';   // 远程截图下载缓存（临时产物，可随时删）
const DEFAULT_PROXY = 'http://127.0.0.1:7890'; // 与 fetch.mjs 的内置默认一致
const MAX_SHOTS = 5;                           // 每条清单最多上传多少张截图
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;       // 服务端 /api/posts/upload 的 5MB 上限
const DIRECT_TIMEOUT_MS = 10000;               // 远程图直连下载超时
const PROXY_TIMEOUT_MS = 30000;                // 远程图代理下载超时

// ---------- 通用 HTTP ----------
async function httpJson(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) {
    const msg = typeof data === 'string' ? data : (data?.message || `HTTP ${r.status}`);
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  return data;
}
const postJson = (url, body, headers = {}) =>
  httpJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

// ---------- 截图：本地路径 / 远程 URL ----------
const isRemoteShot = (shot) => /^https?:\/\//i.test(String(shot));
const hashOf = (url) => createHash('sha1').update(String(url)).digest('hex').slice(0, 12);

/** 读 .env 里的一个键（零依赖手写解析；.env 已被 .gitignore 忽略） */
function envValue(key) {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return '';
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.+?)\\s*$`, 'i');
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(re);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return '';
}

/** 代理地址优先级：.env 的 HTTPS_PROXY > config.json 的 network.proxy > 内置默认 */
function proxyUrl() {
  return envValue('HTTPS_PROXY') || (config.network && config.network.proxy) || DEFAULT_PROXY;
}

/** 按魔数判断图片类型（不依赖扩展名）；识别不出返回 null */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.subarray(0, 8).equals(pngMagic)) return { mime: 'image/png', ext: 'png' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return { mime: 'image/gif', ext: 'gif' };
  return null;
}

/** 校验一张图的二进制（类型按魔数、大小按服务端上限）；不可用返回 { error } */
function checkImage(buf) {
  if (!buf || !buf.length) return { error: '内容为空' };
  if (buf.length > MAX_IMAGE_BYTES) {
    return { error: `超过 5MB 上限（${(buf.length / 1024 / 1024).toFixed(1)}MB，服务端会拒绝）` };
  }
  const kind = sniffImage(buf);
  if (!kind) return { error: '魔数不是 jpg/png/webp/gif，无法确定图片类型' };
  return { ...kind, bytes: buf.length };
}

/** 直连下载（10s 超时） */
async function downloadDirect(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS), redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * 走代理下载（30s 超时）。
 * Node 只在「进程启动时」读 NODE_USE_ENV_PROXY，进程内 setenv 无效（2026-10-04 实测），
 * 所以这里用子进程 + 启动前注入环境变量，做法与 run-with-proxy.sh 一致。
 */
function downloadViaProxy(url, proxy) {
  const SRC = [
    'const [url, out] = process.argv.slice(1);',
    'try {',
    `  const r = await fetch(url, { signal: AbortSignal.timeout(${PROXY_TIMEOUT_MS}), redirect: 'follow' });`,
    "  if (!r.ok) { console.error('HTTP ' + r.status); process.exit(3); }",
    '  const buf = Buffer.from(await r.arrayBuffer());',
    "  if (!buf.length) { console.error('空响应'); process.exit(4); }",
    "  const fs = await import('node:fs');",
    '  fs.writeFileSync(out, buf);',
    '  process.stdout.write(String(buf.length));',
    '} catch (e) {',
    "  console.error((e && e.cause && e.cause.code) || (e && e.message) || String(e));",
    '  process.exit(5);',
    '}',
  ].join('\n');
  mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = join(CACHE_DIR, `${hashOf(url)}.download`);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', SRC, url, cacheFile], {
    encoding: 'utf8',
    timeout: PROXY_TIMEOUT_MS + 5000,
    env: {
      ...process.env,
      NODE_USE_ENV_PROXY: '1',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --dns-result-order=ipv4first`.trim(),
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
    },
  });
  if (r.error) throw new Error(`子进程启动失败：${r.error.message}`);
  if (r.status !== 0) {
    // 子进程失败时只回传一行（否则会把整段 Node 堆栈带进日志）
    const firstLine = (r.stderr || '').split('\n').map((line) => line.trim()).filter(Boolean)[0];
    throw new Error((firstLine || `退出码 ${r.status}`).slice(0, 120));
  }
  return readFileSync(cacheFile);
}

/** 取回远程图：先直连，失败再走代理（两段式） */
async function fetchRemoteShot(url) {
  try {
    return { ok: true, buf: await downloadDirect(url), via: '直连' };
  } catch (directErr) {
    const proxy = proxyUrl();
    try {
      return { ok: true, buf: downloadViaProxy(url, proxy), via: `代理 ${proxy}` };
    } catch (proxyErr) {
      return { ok: false, error: `直连失败（${directErr.message}）且代理失败（${proxyErr.message}）` };
    }
  }
}

/** 取回并校验一张截图（本地路径或远程 URL）；失败返回 { ok:false, error } */
async function loadShot(shot, listFile) {
  if (isRemoteShot(shot)) {
    const got = await fetchRemoteShot(shot);
    if (!got.ok) return got;
    const info = checkImage(got.buf);
    if (info.error) return { ok: false, error: `${info.error}（来源 ${got.via}）` };
    return { ok: true, buf: got.buf, ...info, via: got.via, name: `${hashOf(shot)}.${info.ext}` };
  }
  const path = shot.startsWith('/') ? shot : join(dirname(listFile), shot);
  if (!existsSync(path)) return { ok: false, error: `本地文件不存在：${path}` };
  const buf = readFileSync(path);
  const info = checkImage(buf);
  if (info.error) return { ok: false, error: info.error };
  return { ok: true, buf, ...info, via: '', name: basename(path) };
}

// ---------- ollama 本地生成 ----------
async function ollamaGenerate(system, user) {
  // --dry-run 允许没有 config.json，这时用内置默认值（本机 ollama 默认地址 + README 推荐模型）
  const c = config.ollama || { baseUrl: 'http://localhost:11434', model: 'qwen2.5:7b' };
  const d = await httpJson(`${c.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: c.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      stream: false,
      format: 'json',
      options: { temperature: 0.75 },
    }),
  });
  return d.message.content;
}

// ---------- 云端 AI 润色（OpenAI 兼容，可选）----------
async function cloudPolish(text) {
  const c = config.cloudAi;
  if (!c || !c.apiKey) return null;
  const d = await httpJson(`${c.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.apiKey}` },
    body: JSON.stringify({
      model: c.model,
      stream: false,
      messages: [
        {
          role: 'system',
          content: '你是游戏社区的资深编辑。请润色下面的游戏推荐文案：让开场更抓眼球、表达更流畅；严格保持 Markdown 结构、网盘链接与提取码原样不变，不得新增截图或编造版本号/文件大小等事实数据。直接输出润色后的正文，不要解释。',
        },
        { role: 'user', content: text },
      ],
    }),
  });
  return d.choices?.[0]?.message?.content?.trim() || null;
}

// ---------- 文案 Prompt ----------
const SYS_PROMPT = `你是"苦海 · 娱乐游戏"社区的资深游戏编辑，擅长写有吸引力、有信息量的游戏推荐帖。
输出必须是 JSON（不要输出 JSON 以外的内容）：
{"title":"帖子标题","content":"Markdown 正文"}

要求：
1. title：20 字以内，带游戏名，有吸引力，可加【游戏推荐】前缀。
2. content 用 Markdown，结构为：
   - 一两句抓眼球的开场推荐
   - ## 🎮 游戏简介（世界观/玩法/特色，3-5 个亮点）
   - ## 🕹 适合人群（或玩法点评）
   - ## 📥 下载信息（- 网盘链接：<链接>；- 提取码：<提取码>；- 平台：<平台>）
3. 网盘链接、提取码必须原样填入"下载信息"，不得改动。
4. 不要编造版本号、文件大小、发售日期等具体数据；信息不足处用模糊表达或省略。
5. 不要在正文里放截图（截图由脚本自动插入）。`;

function buildUserPrompt(g) {
  return [
    `游戏名：${g.name}`,
    g.genre ? `类型：${g.genre}` : '',
    g.platform ? `平台：${g.platform}` : '',
    g.tags?.length ? `标签：${g.tags.join('、')}` : '',
    g.notes ? `站长备注（可参考，不要原样照抄）：${g.notes}` : '',
    `网盘链接：${g.panUrl}`,
    g.panCode ? `提取码：${g.panCode}` : '提取码：无',
  ].filter(Boolean).join('\n');
}

// 从模型输出中提取 JSON（兼容 ```json 代码块包裹）
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('模型未返回 JSON 对象');
  return JSON.parse(raw.slice(start, end + 1));
}

// ---------- 网站 API ----------
async function forumLogin() {
  const d = await postJson(`${config.apiBase}/api/auth/login`, {
    username: config.forumAdmin.username,
    password: config.forumAdmin.password,
  });
  return d.token;
}
async function gameEnter() {
  const d = await postJson(`${config.apiBase}/api/game/enter`, { password: config.game.gatePassword });
  return d.token;
}
async function gameLogin(gateToken) {
  const d = await postJson(
    `${config.apiBase}/api/game/login`,
    { username: config.game.adminUsername, password: config.game.adminPassword },
    { Authorization: `Bearer ${gateToken}` }
  );
  return d.token;
}
async function uploadImage(forumToken, buf, mime, name) {
  const fd = new FormData();
  // Blob 必须带 MIME：后端要求 file.type 是 image/*，否则 400「只能上传图片」（2026-10-04 实测）
  fd.append('file', new Blob([buf], { type: mime }), name);
  const d = await httpJson(`${config.apiBase}/api/posts/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${forumToken}` },
    body: fd,
  });
  return d.url;
}
async function publishPost(gameToken, payload) {
  return postJson(`${config.apiBase}/api/game/posts`, payload, {
    Authorization: `Bearer ${gameToken}`,
  });
}

// 在"下载信息"前插入截图区块，没有则追加到末尾
function insertScreenshots(content, block) {
  const idx = content.search(/##\s*📥?\s*下载信息/);
  if (idx !== -1) return content.slice(0, idx) + block + '\n' + content.slice(idx);
  return content + block;
}

// ---------- 清单校验（正式发布与 --dry-run 共用同一套规则）----------
/** 返回清单里不合规的字段（空数组 = 通过）。processGame 与 previewGame 都调它，避免两套规则 */
function validateGame(g) {
  const problems = [];
  if (!g.name) problems.push('name（游戏名）');
  if (!g.panUrl) problems.push('panUrl（网盘链接）');
  if (g.screenshots !== undefined && !Array.isArray(g.screenshots)) problems.push('screenshots（必须是数组）');
  return problems;
}

/** 清单里的截图条目（本地路径或 URL，原样返回） */
function shotList(g) {
  return Array.isArray(g.screenshots) ? g.screenshots : [];
}

/** 只把「本地路径」条目解析成实际路径（相对清单文件所在目录）；URL 交给 loadShot */
function resolveScreenshots(g, listFile) {
  return shotList(g)
    .filter((shot) => !isRemoteShot(shot))
    .map((shot) => ({
      shot,
      path: shot.startsWith('/') ? shot : join(dirname(listFile), shot),
    }));
}

/** 本地不存在的截图（正式发布会中止，--dry-run 只提示）；URL 不参与本地检查 */
function missingScreenshots(g, listFile) {
  return resolveScreenshots(g, listFile).filter((s) => !existsSync(s.path));
}

// ---------- 命令行参数 ----------
// 手写解析，只认 --file / --dry-run / -h；未知参数打印用法并退出 1
const HELP_TEXT = `
苦海 · 娱乐游戏 —— 一键自动发布游戏推荐帖

用法：
  node publish-game.mjs                 发布 queue/ 里全部的清单
  node publish-game.mjs --file <路径>    只处理指定的一个清单
  node publish-game.mjs --dry-run       空跑：走完整流程但不发帖、不归档

可选参数：
  --file <路径>   相对 automation/ 或绝对路径；显式指定时不跳过 _ 开头的模板文件
  --dry-run       不登录、不上传截图、不调用云端 AI、不写 published/，
                  只打印每条清单的校验结果和将要说出的字段（本地模型照跑）
  -h, --help      显示本帮助

截图来源：
  清单里 screenshots 的每一项都可以是「本地路径（相对清单文件）」或「http(s) URL」。
  URL 先直连下载（10s），失败再走代理下载（30s）；代理取 .env 的 HTTPS_PROXY，
  其次 config.json 的 network.proxy，最后内置 ${DEFAULT_PROXY}；
  下载缓存在 ${CACHE_DIR}/。单张失败只跳过不中止；每条最多 ${MAX_SHOTS} 张。
  （本地文件缺失仍按原行为直接中止本条。）

示例：
  node publish-game.mjs
  node publish-game.mjs --dry-run
  node publish-game.mjs --file queue/_example-game.json --dry-run
`.trim();

function fail(message) {
  console.error(`\n❌ ${message}\n\n${HELP_TEXT}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { file: '', dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      args.help = true;
      continue;
    }
    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (token === '--file') {
      if (!argv[i + 1]) fail('--file 需要一个值，例如：--file queue/xxx.json');
      i += 1;
      args.file = argv[i];
      continue;
    }
    fail(`未知参数：${token}`);
  }
  return args;
}

// ---------- --dry-run 预览（体检 + 预览将要说出的字段，无任何副作用）----------
function resolveListFile(file) {
  return file.startsWith('/') ? file : join(ROOT, file);
}

async function previewGame(file) {
  const g = JSON.parse(readFileSync(file, 'utf8')); // 解析失败由调用方接住
  console.log(`\n▶ ${file}`);
  console.log(`  名称：${g.name || '(缺少 name)'}`);

  // 1. 字段校验：与正式发布同一套规则
  const problems = validateGame(g);
  console.log(
    `  · 字段校验：${problems.length ? `❌ 缺少/不合规 ${problems.join('、')}（正式发布会中止）` : '✅ name / panUrl 齐全'}`
  );
  console.log(`  · 网盘：${g.panUrl || '(空)'}${g.panCode ? `　提取码：${g.panCode}` : ''}`);

  // 2. 截图：本地只查文件是否存在；URL 不下载（--dry-run 保持零副作用）
  const allShots = shotList(g);
  const plannedPreview = allShots.slice(0, MAX_SHOTS);
  if (!allShots.length) {
    console.log('  · 截图：无（跳过上传）');
  } else {
    for (const shot of plannedPreview) {
      if (isRemoteShot(shot)) {
        console.log(`  · 截图 ${shot}：远程 URL（正式发布：先直连下载，失败走代理；不检查本地文件）`);
      } else {
        const path = shot.startsWith('/') ? shot : join(dirname(file), shot);
        console.log(`  · 截图 ${shot}：${existsSync(path) ? '✅ 存在（正式发布会上传）' : '❌ 文件不存在（正式发布会中止）'}`);
      }
    }
    if (allShots.length > MAX_SHOTS) {
      console.log(`  · 截图共 ${allShots.length} 张，超过上限，正式发布只会用前 ${MAX_SHOTS} 张`);
    }
  }

  // 3. 文案：本地模型照跑；云端润色会产生费用，空跑跳过
  process.stdout.write('  · 本地模型生成文案（--dry-run 跳过云端润色）…');
  let draft;
  try {
    draft = extractJson(await ollamaGenerate(SYS_PROMPT, buildUserPrompt(g)));
  } catch (e) {
    console.log(`❌ ${e.message}`);
    console.log('  提示：--dry-run 需要本地 ollama 在运行（ollama serve），且模型已下载（ollama list）');
    console.log('  · 将要说出的字段：无法生成（正式发布会在此中止）');
    return false;
  }
  if (!draft.title || !draft.content) {
    console.log('❌ 模型返回缺少 title/content');
    console.log('  · 将要说出的字段：无法生成（正式发布会在此中止）');
    return false;
  }
  console.log('完成');

  const body = String(draft.content);
  console.log('  · 将要说出的字段：');
  console.log(`      title   = ${draft.title}`);
  console.log(`      content = ${body.slice(0, 120).replace(/\n/g, '\n                ')}${body.length > 120 ? '…' : ''}`);
  console.log(`                （正文共 ${body.length} 字，此处截断预览）`);
  const effectiveShots = Math.min(allShots.length, MAX_SHOTS);
  console.log(`      images  = ${effectiveShots ? `${effectiveShots} 张（上传后替换为论坛地址）` : '(无)'}`);
  console.log('  · --dry-run：跳过 门禁 → 登录 → 发帖 → 归档，queue/ 与 published/ 均不改动');
  return true;
}

// ---------- 处理单个游戏 ----------
async function processGame(file) {
  const g = JSON.parse(readFileSync(file, 'utf8'));
  const problems = validateGame(g);
  if (problems.length) throw new Error(`清单缺少必需字段：${problems.join('、')}`);
  console.log(`\n▶ ${g.name}`);

  // 1. ollama 生成
  process.stdout.write('  · 本地模型生成文案…');
  const raw = await ollamaGenerate(SYS_PROMPT, buildUserPrompt(g));
  let draft;
  try {
    draft = extractJson(raw);
  } catch (e) {
    throw new Error(`文案解析失败（可重跑）：${e.message}`);
  }
  if (!draft.title || !draft.content) throw new Error('模型返回缺少 title/content');
  console.log('完成');

  // 2. 云端润色
  let content = draft.content;
  if (config.cloudAi?.apiKey) {
    process.stdout.write('  · 云端 AI 润色…');
    const polished = await cloudPolish(content);
    if (polished) content = polished;
    console.log('完成');
  }

  // 3. 截图：先把本地/远程都取回并校验，再决定是否登录上传
  //    本地缺文件仍按老规矩直接中止本条；远程单张失败只跳过（不中止）；每条最多 MAX_SHOTS 张
  const absent = missingScreenshots(g, file);
  if (absent.length) throw new Error(`截图不存在：${absent.map((s) => s.path).join('、')}`);

  const allShots = shotList(g);
  if (allShots.length > MAX_SHOTS) {
    console.log(`  · 截图共 ${allShots.length} 张，超过上限，只取前 ${MAX_SHOTS} 张`);
  }

  const ready = [];
  for (const shot of allShots.slice(0, MAX_SHOTS)) {
    const label = isRemoteShot(shot) ? shot : basename(shot);
    process.stdout.write(`  · 取回截图 ${label}…`);
    const got = await loadShot(shot, file);
    if (!got.ok) {
      console.log(`跳过（${got.error}）`);
      continue;
    }
    console.log(`完成（${got.via ? `${got.via}，` : ''}${got.mime} ${(got.bytes / 1024).toFixed(0)}KB）`);
    ready.push({ ...got, label });
  }

  const images = [];
  if (ready.length) {
    if (!config.forumAdmin || !config.forumAdmin.username) {
      throw new Error('config.json 缺少 forumAdmin（上传截图需要论坛管理员账号）');
    }
    process.stdout.write('  · 论坛管理员登录…');
    const forumToken = await forumLogin();
    console.log('完成');
    for (const shot of ready) {
      process.stdout.write(`  · 上传截图 ${shot.label}…`);
      images.push(await uploadImage(forumToken, shot.buf, shot.mime, shot.name));
      console.log('完成');
    }
    const block = `\n## 🖼 游戏截图\n\n${images.map((u) => `![](${u})`).join('\n\n')}\n`;
    content = insertScreenshots(content, block);
  } else if (allShots.length) {
    console.log('  · ⚠️ 没有可用截图（全部跳过），本条按无图发布');
  }

  // 4. 游戏站门禁 + 管理员登录 + 发帖
  const gameMissing = ['gatePassword', 'adminUsername', 'adminPassword'].filter(
    (k) => !config.game || !config.game[k]
  );
  if (gameMissing.length) {
    throw new Error(`config.json 缺少 game.${gameMissing.join(' / game.')}（发帖需要，请编辑 config.json）`);
  }
  process.stdout.write('  · 进入游戏站…');
  const gateToken = await gameEnter();
  const gameToken = await gameLogin(gateToken);
  console.log('完成');
  process.stdout.write('  · 发布帖子…');
  const res = await publishPost(gameToken, { title: draft.title, content, images });
  console.log(`完成（id=${res.id}）`);

  // 5. 归档（保留原始清单 + 追加发布结果）
  mkdirSync(PUB_DIR, { recursive: true });
  const dest = join(PUB_DIR, basename(file));
  renameSync(file, dest);
  const record = {
    ...g,
    publishedAt: new Date().toISOString(),
    postId: res.id,
    postUrl: `${config.siteBase}/game-post.html?id=${res.id}`,
  };
  writeFileSync(dest, JSON.stringify(record, null, 2), 'utf8');
  console.log(`  ✅ 已发布：${record.postUrl}`);
  return record;
}

// ---------- 主入口 ----------
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP_TEXT);
  process.exit(0);
}

const configPath = join(ROOT, 'config.json');
let config = {};
if (existsSync(configPath)) {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} else if (args.dryRun) {
  console.log('⚠️ 未找到 config.json（--dry-run 不需要它；正式发布前请先 cp config.example.json config.json 并填写账号）');
} else {
  console.error('缺少 config.json：请先复制 config.example.json 为 config.json 并填写账号信息。');
  process.exit(1);
}
mkdirSync(QUEUE_DIR, { recursive: true });
mkdirSync(PUB_DIR, { recursive: true });

let files;
if (args.file) {
  const target = resolveListFile(args.file);
  if (!existsSync(target)) fail(`--file 指定的清单不存在：${target}`);
  files = [target]; // 显式指定时不再跳过 _ 开头的模板文件
} else {
  files = readdirSync(QUEUE_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => join(QUEUE_DIR, f));
}

if (!files.length) {
  console.log('queue 目录没有待发布游戏。把游戏清单（参考 queue/_example-game.json）放进去后再跑。');
  process.exit(0);
}

if (args.dryRun) {
  console.log(`\n🔍 --dry-run 空跑：共 ${files.length} 个清单（不发帖 / 不上传截图 / 不归档 / 不调用云端 AI）`);
  let previewed = 0;
  for (const f of files) {
    try {
      if (await previewGame(f)) previewed += 1;
    } catch (e) {
      console.error(`\n▶ ${f}\n  ❌ 读取或解析失败：${e.message}`);
    }
  }
  console.log(`\n🔍 空跑结束：共 ${files.length} 个清单，其中 ${previewed} 个成功生成文案预览（空跑只体检、不阻断）`);
  process.exit(0);
}

console.log(`发现 ${files.length} 个待发布游戏，开始处理…`);
const results = [];
for (const f of files) {
  try {
    results.push(await processGame(f));
  } catch (e) {
    console.error(`\n  ❌ 处理失败：${e.message}`);
    console.error('  已停止，后续游戏未处理。修复后重新跑本脚本即可（已发布的不会重复）。');
    process.exit(1);
  }
}
console.log(`\n🎉 全部完成，共发布 ${results.length} 篇。`);
