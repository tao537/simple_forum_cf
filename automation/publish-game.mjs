#!/usr/bin/env node
/**
 * 苦海 · 娱乐游戏 —— 一键自动发布游戏推荐帖
 * 流程：读取 queue/*.json → ollama 生成推荐文案 → 云端 AI 润色（可选）
 *       → 截图上传 KV（可选）→ 游戏站 API 发帖 → 归档到 published/
 * 运行：node publish-game.mjs
 * 环境：Node 18+（内置 fetch），无需安装依赖
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const QUEUE_DIR = join(ROOT, 'queue');
const PUB_DIR = join(ROOT, 'published');

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

// ---------- ollama 本地生成 ----------
async function ollamaGenerate(system, user) {
  const c = config.ollama;
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
async function uploadImage(forumToken, filePath) {
  const buf = readFileSync(filePath);
  const fd = new FormData();
  fd.append('file', new Blob([buf]), basename(filePath));
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

// ---------- 处理单个游戏 ----------
async function processGame(file) {
  const g = JSON.parse(readFileSync(file, 'utf8'));
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

  // 3. 截图上传（需要论坛管理员 token）
  const images = [];
  if (g.screenshots?.length) {
    process.stdout.write('  · 论坛管理员登录…');
    const forumToken = await forumLogin();
    console.log('完成');
    for (const shot of g.screenshots) {
      const p = shot.startsWith('/') ? shot : join(dirname(file), shot);
      if (!existsSync(p)) throw new Error(`截图不存在：${p}`);
      process.stdout.write(`  · 上传截图 ${basename(p)}…`);
      images.push(await uploadImage(forumToken, p));
      console.log('完成');
    }
    const block = `\n## 🖼 游戏截图\n\n${images.map((u) => `![](${u})`).join('\n\n')}\n`;
    content = insertScreenshots(content, block);
  }

  // 4. 游戏站门禁 + 管理员登录 + 发帖
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
const configPath = join(ROOT, 'config.json');
if (!existsSync(configPath)) {
  console.error('缺少 config.json：请先复制 config.example.json 为 config.json 并填写账号信息。');
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));
mkdirSync(QUEUE_DIR, { recursive: true });
mkdirSync(PUB_DIR, { recursive: true });

const files = readdirSync(QUEUE_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
if (!files.length) {
  console.log('queue 目录没有待发布游戏。把游戏清单（参考 queue/example-game.json）放进去后再跑。');
  process.exit(0);
}

console.log(`发现 ${files.length} 个待发布游戏，开始处理…`);
const results = [];
for (const f of files) {
  try {
    results.push(await processGame(join(QUEUE_DIR, f)));
  } catch (e) {
    console.error(`\n  ❌ 处理失败：${e.message}`);
    console.error('  已停止，后续游戏未处理。修复后重新跑本脚本即可（已发布的不会重复）。');
    process.exit(1);
  }
}
console.log(`\n🎉 全部完成，共发布 ${results.length} 篇。`);
