// review.mjs - 复核工具
// 用法: node review.mjs <source> [--date YYYY-MM-DD] [--no-open] [--local-covers]
// 输出: reports/<source>-<date>.html 和 reports/<source>-<date>.md
// --local-covers: 把封面下载到 reports/evidence/covers-<source>-<date>/ 再用本地路径显示。
//                 本地 file:// 页面发不出 Referer，遇到防盗链站点（如游戏鸟 pic1.youxiniao.com）图会 403 裂图。

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CANDIDATES_DIR = join(__dirname, 'candidates');
const REPORTS_DIR = join(__dirname, 'reports');
const PUB_DIR = join(__dirname, 'published');
const QUEUE_DIR = join(__dirname, 'queue');

const args = process.argv.slice(2);
const source = args[0];
if (!source) { console.error('用法: node review.mjs <source> [--date YYYY-MM-DD] [--no-open] [--local-covers] [--check-links]'); process.exit(1); }
const dateIdx = args.indexOf('--date');
const dateArg = dateIdx !== -1 ? args[dateIdx + 1] : null;
const autoOpen = !args.includes('--no-open');
const localCovers = args.includes('--local-covers');
// 在线检查详情页链接可达性（逐条限速 2s，慢，默认关闭）
const checkLinks = args.includes('--check-links');
// 把 pass 条目自动转成 queue 发布清单（配合 publish-game.mjs 实现全自动）
const toQueue = args.includes('--to-queue');

let filePath, date;
if (dateArg) {
  filePath = join(CANDIDATES_DIR, `${source}-${dateArg}.json`);
  if (!existsSync(filePath)) { console.error(`❌ 文件不存在: ${filePath}`); process.exit(1); }
  date = dateArg;
} else {
  if (!existsSync(CANDIDATES_DIR)) { console.error(`❌ candidates/ 不存在`); process.exit(1); }
  const files = readdirSync(CANDIDATES_DIR).filter(f => f.startsWith(`${source}-`) && f.endsWith('.json')).sort();
  if (files.length === 0) { console.error(`❌ 没有 ${source}-*.json`); process.exit(1); }
  const latest = files[files.length - 1];
  filePath = join(CANDIDATES_DIR, latest);
  date = latest.replace(`${source}-`, '').replace('.json', '');
}

const items = JSON.parse(readFileSync(filePath, 'utf8'));
if (!Array.isArray(items)) { console.error('❌ 文件不是数组'); process.exit(1); }
if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });

const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const cut = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; };
const coverOf = item => item.cover || (Array.isArray(item.images) ? item.images[0] : '') || '';
const hasCover = item => !!coverOf(item);
const noCoverCount = items.filter(i => !hasCover(i)).length;

// ================= 自动复核（auto-review） =================
// 目标：把"逐个人工看"变成"自动给每条打 pass/warn/reject + 列问题"，
// 只把 pass 交给发布脚本，warn 人工确认，reject 直接挡下。
// 不联网的静态规则（字段完整性 / 敏感词 / 重复）默认必跑；
// 链接可达性需 --check-links（逐条限速，慢）。

const VERDICT_RANK = { pass: 0, warn: 1, reject: 2 };
// 取一组问题里最严重的级别作为整条结论
function verdictOf(issues) {
  let v = 'pass';
  for (const it of issues) if (VERDICT_RANK[it.level] > VERDICT_RANK[v]) v = it.level;
  return v;
}

// 名称归一化：去空白、常见标点、版本后缀、统一小写，用于重复比对
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[《》【】\[\]（）()「」"'`'':：·・,，.。!！?？\-—_~～/\\|]/g, '')
    .replace(/(pc|windows|winlator|盖世|安卓|apk|汉化版|硬盘版|免安装版|官方版|正式版|最新版|完整版|v?\d+(\.\d+)*)$/g, '');
}

// ---- 合规词表（命中即按级别处理；保守，宁可多 warn 让人工看）----
// 成人/色情红线：直接 reject（合规风险最高，不发布）
const ADULT_WORDS = [
  'r18', '18禁', '成人', '色情', '情色', '绅士', 'h版', 'h游戏', 'h作', '调教', '凌辱', 'ntr',
  '纯爱', '少女×', '少女x', '萝莉', '御姐', '爆乳', '巨乳', '肉体', '做爱', '性爱', '春宫',
  '全彩本', '同人志', '里番', '无修', '无码', '有码', '羞羞', '涩涩', '工口', 'エロ', 'アダルト',
];
// 盗版/版权风险词：warn（需人工确认是否有授权，避免直接自动发布）
const PIRACY_WORDS = [
  '破解', '汉化', '硬盘版', '免安装', '绿色版', '学习版', '破解版', '补丁', 'crack', 'steamunlock',
  '未加密', '盗版', '白嫖', '白嫖版', '转存', '分流', '转载', '搬运',
];
// 常见网盘域名（仅记录，方便确认下载来源）
const PAN_DOMAINS = ['pan.baidu', 'pan.quark', 'aliyundrive', 'alipan', '123pan', 'lanzou', 'lanzoui', 'mega.nz', 'pan.115', 'cloud.189', 'drive.google'];

// ---- 构建历史名称集合（已发布 + 历史候选），用于跨批次去重 ----
const publishedNames = new Set();
try {
  for (const f of readdirSync(PUB_DIR).filter(f => f.endsWith('.json'))) {
    try {
      const d = JSON.parse(readFileSync(join(PUB_DIR, f), 'utf8'));
      if (d.name) publishedNames.add(normName(d.name));
    } catch { /* 单个坏文件不影响复核 */ }
  }
} catch { /* 无 published 目录 */ }

const historyNames = new Map(); // 归一化名 → 来源文件名
try {
  for (const f of readdirSync(CANDIDATES_DIR).filter(f => f.endsWith('.json') && f !== `${source}-${date}.json`)) {
    try {
      const arr = JSON.parse(readFileSync(join(CANDIDATES_DIR, f), 'utf8'));
      if (Array.isArray(arr)) for (const d of arr) if (d.name && !historyNames.has(normName(d.name))) historyNames.set(normName(d.name), f);
    } catch { /* 跳过坏历史文件 */ }
  }
} catch { /* 无 candidates 目录 */ }

// ---- 单条静态检查：不联网 ----
function staticCheck(item) {
  const issues = [];
  const name = String(item.name || '').trim();
  const url = String(item.url || '').trim();
  const desc = String(item.desc || '').trim();
  const hay = `${name} ${desc} ${Array.isArray(item.tags) ? item.tags.join(' ') : ''}`.toLowerCase();

  // 字段完整性（reject 级）
  if (!name || name.length < 2) issues.push({ level: 'reject', code: 'NO_NAME', msg: '缺少名称或名称过短' });
  if (!url || !/^https?:\/\//i.test(url)) issues.push({ level: 'reject', code: 'NO_URL', msg: '缺少有效链接（非 http/https）' });

  // 成人红线
  const adultHit = ADULT_WORDS.filter(w => hay.includes(w.toLowerCase()));
  if (adultHit.length) issues.push({ level: 'reject', code: 'ADULT', msg: `命中成人/色情内容词：${adultHit.slice(0, 4).join('、')}` });

  // 盗版/版权
  const piracyHit = PIRACY_WORDS.filter(w => hay.includes(w.toLowerCase()));
  if (piracyHit.length) issues.push({ level: 'warn', code: 'PIRACY', msg: `命中盗版/版权风险词，需确认授权：${piracyHit.slice(0, 4).join('、')}` });

  // 字段完整性（warn 级）
  if (!hasCover(item)) issues.push({ level: 'warn', code: 'NO_COVER', msg: '无封面图' });
  if (desc.length < 10) issues.push({ level: 'warn', code: 'SHORT_DESC', msg: `简介过短或缺失（${desc.length} 字）` });
  if (!Array.isArray(item.tags) || item.tags.length === 0) issues.push({ level: 'warn', code: 'NO_TAGS', msg: '无标签' });

  // 下载链接/网盘域名识别（links 可能是数组或字符串）
  const links = Array.isArray(item.links) ? item.links : (item.links ? [item.links] : []);
  if (links.length) {
    const panHit = links.map(l => String(l)).filter(l => PAN_DOMAINS.some(d => l.toLowerCase().includes(d)));
    if (panHit.length) issues.push({ level: 'pass', code: 'PAN_LINK', msg: `网盘链接：${panHit.length} 个` });
  }

  return issues;
}

// ---- 在线检查详情页链接可达性（限速 2s）----
async function linkCheck(item) {
  const issues = [];
  const url = String(item.url || '');
  if (!/^https?:\/\//i.test(url)) return issues;
  try {
    const r = await fetch(url, {
      method: 'GET', // 部分源不支持 HEAD，用 GET
      signal: AbortSignal.timeout(12000),
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; kuhai-automation/1.0)' },
    });
    if (r.status >= 200 && r.status < 400) issues.push({ level: 'pass', code: 'LINK_OK', msg: `链接可达 HTTP ${r.status}` });
    else if (r.status === 404) issues.push({ level: 'reject', code: 'LINK_DEAD', msg: `链接失效 HTTP ${r.status}` });
    else issues.push({ level: 'warn', code: 'LINK_BAD', msg: `链接返回 HTTP ${r.status}` });
  } catch (e) {
    issues.push({ level: 'warn', code: 'LINK_ERR', msg: `链接检查失败：${e.message}` });
  }
  return issues;
}

// ---- 跑全部复核 ----
const results = [];
const seenInBatch = new Map(); // 批次内归一化名 → 首次出现的序号
if (checkLinks) console.log(`🔗 在线检查链接（每条限速 2s，共 ${items.length} 条）…`);
for (let i = 0; i < items.length; i++) {
  const item = items[i];
  const issues = staticCheck(item);
  const nn = normName(item.name);

  // 批次内重复：第一条保留，之后的判重复
  if (nn) {
    if (seenInBatch.has(nn)) {
      issues.push({ level: 'reject', code: 'DUP_BATCH', msg: `与本批次第 ${seenInBatch.get(nn) + 1} 条重复` });
    } else {
      seenInBatch.set(nn, i);
    }
    // 已发布过
    if (publishedNames.has(nn)) issues.push({ level: 'reject', code: 'DUP_PUBLISHED', msg: '与已发布内容重复' });
    // 历史候选里出现过
    else if (historyNames.has(nn)) issues.push({ level: 'warn', code: 'DUP_HISTORY', msg: `与历史候选重复（${historyNames.get(nn)}）` });
  }

  if (checkLinks) {
    issues.push(...await linkCheck(item));
    await new Promise(r => setTimeout(r, 2000)); // 限速
  }

  const verdict = verdictOf(issues);
  results.push({ index: i, id: item.id, name: item.name, url: item.url, cover: coverOf(item), verdict, issues });
}

const countVerdict = v => results.filter(r => r.verdict === v).length;
const passCount = countVerdict('pass'), warnCount = countVerdict('warn'), rejectCount = countVerdict('reject');
console.log(`🧪 自动复核：✅ pass ${passCount}　⚠️ warn ${warnCount}　⛔ reject ${rejectCount}`);

// 机器可读结果，供发布脚本只取 pass（reports/<source>-<date>.review.json）
const reviewJsonPath = join(REPORTS_DIR, `${source}-${date}.review.json`);
writeFileSync(reviewJsonPath, JSON.stringify({
  source, date, generatedAt: new Date().toISOString(),
  total: items.length, pass: passCount, warn: warnCount, reject: rejectCount,
  linkChecked: checkLinks,
  results: results.map(r => ({
    index: r.index, id: r.id, name: r.name, url: r.url, cover: r.cover,
    verdict: r.verdict, issues: r.issues,
  })),
}, null, 2), 'utf8');
console.log(`✅ 复核结果（机器可读）: ${reviewJsonPath}`);

// ---- 可选：把 pass 条目自动转成 queue 发布清单 ----
if (toQueue) {
  if (!existsSync(QUEUE_DIR)) mkdirSync(QUEUE_DIR, { recursive: true });
  // 已在 queue 里的归一化名（避免重复入队）
  const queuedNames = new Set();
  for (const f of readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'))) {
    try { const d = JSON.parse(readFileSync(join(QUEUE_DIR, f), 'utf8')); if (d.name) queuedNames.add(normName(d.name)); } catch { /* skip */ }
  }
  let enqueued = 0;
  for (const r of results.filter(x => x.verdict === 'pass')) {
    const item = items[r.index];
    const nn = normName(item.name);
    if (queuedNames.has(nn) || publishedNames.has(nn)) continue; // 已在队列或已发布
    const links = Array.isArray(item.links) ? item.links : (item.links ? [item.links] : []);
    const panUrl = links.map(l => String(l)).find(l => PAN_DOMAINS.some(d => l.toLowerCase().includes(d))) || '';
    const tags = Array.isArray(item.tags) ? item.tags : [];
    // 平台推断（名称/标签里的关键词）
    const hay = `${item.name} ${tags.join(' ')}`;
    const platform = [/pc|windows|win|电脑/i.test(hay) ? 'PC' : '', /安卓|android|apk|手机|盖世/i.test(hay) ? '安卓' : ''].filter(Boolean).join(' / ');
    const queueItem = {
      name: item.name,
      panUrl,
      panCode: '',
      genre: tags.find(t => /RPG|SLG|ACT|AVG|GAL|冒险|动作|角色扮演|模拟|策略/i.test(t)) || '',
      platform,
      tags,
      notes: String(item.desc || '').slice(0, 300),
      screenshots: [],
    };
    const safeId = String(item.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(-24) || Date.now();
    const qf = join(QUEUE_DIR, `auto-${source}-${safeId}.json`);
    writeFileSync(qf, JSON.stringify(queueItem, null, 2), 'utf8');
    queuedNames.add(nn);
    enqueued += 1;
    console.log(`   ➡️  入队: ${item.name}${panUrl ? '' : '（⚠️ 未识别网盘链接，需人工补 panUrl）'}`);
  }
  console.log(`📥 已把 ${enqueued} 条 pass 自动转入 queue/（可直接跑 publish-game.mjs）`);
}

// ---- （可选）封面本地化：--local-covers ----
// 本地报告是 file:// 页面，发不出站点域名的 Referer，遇到 Referer 防盗链（游戏鸟实测 403）图全裂。
// 做法：带「图片自己 origin」当 Referer 下载到 reports/evidence/covers-<source>-<date>/，
// 报告改用相对路径引用；单张失败只警告并保留远程 URL，不影响其余条目。
const COVERS_SUBDIR = `evidence/covers-${source}-${date}`;
const coverSrc = new Map(); // 原始 URL → 报告里实际使用的 src

/** 猜图片扩展名：先看魔数，再退回 URL 后缀 */
function coverExt(buf, url) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.subarray(0, 8).equals(PNG)) return 'png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF') return 'webp';
  const m = String(url).match(/\.(jpe?g|png|webp|gif)(?:$|\?)/i);
  return m ? m[1].toLowerCase().replace(/^jpeg$/, 'jpg') : 'jpg';
}

/** 下载一张封面（10s 超时）；成功返回 Buffer，失败返回 { error } */
async function grabCover(url) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
      // 防盗链白名单基本就是站点自身域名，用图片自己的 origin 当 Referer 即可（游戏鸟实测 200）
      headers: { Referer: new URL(url).origin + '/' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) throw new Error('空响应');
    return buf;
  } catch (e) {
    return { error: e.message };
  }
}

const srcOf = url => coverSrc.get(url) || url;

if (localCovers) {
  const dir = join(REPORTS_DIR, COVERS_SUBDIR);
  mkdirSync(dir, { recursive: true });
  const urls = [...new Set(items.map(coverOf).filter(u => /^https?:\/\//i.test(u)))];
  console.log(`🖼️  封面本地化：${urls.length} 张 → ${dir}`);
  let ok = 0;
  for (const [i, url] of urls.entries()) {
    const buf = await grabCover(url);
    if (buf.error) { console.log(`   ⚠️ ${i + 1}/${urls.length} 失败（报告仍用远程 URL）：${buf.error}`); continue; }
    const file = `${String(i + 1).padStart(2, '0')}.${coverExt(buf, url)}`;
    writeFileSync(join(dir, file), buf);
    coverSrc.set(url, `${COVERS_SUBDIR}/${file}`);
    ok += 1;
    console.log(`   ✅ ${i + 1}/${urls.length} ${file}（${(buf.length / 1024).toFixed(0)} KB）`);
  }
  console.log(`🖼️  本地化完成：${ok}/${urls.length} 张，报告改用本地路径`);
}

/** 报告卡片里的封面图：本地化过的可点击看原图 */
const coverImg = cover => {
  if (!coverSrc.has(cover)) return `<img src="${esc(cover)}" loading="lazy" referrerpolicy="no-referrer">`;
  const src = esc(coverSrc.get(cover));
  return `<a href="${src}" target="_blank" title="点击看原图" style="display:block;width:100%;height:100%"><img src="${src}" loading="lazy"></a>`;
};

// ---- HTML ----
const VERDICT_META = {
  pass:   { label: '✅ 可发布', cls: 'v-pass' },
  warn:   { label: '⚠️ 待确认', cls: 'v-warn' },
  reject: { label: '⛔ 不发布', cls: 'v-reject' },
};
const cards = results.map((r, i) => {
  const item = items[i];
  const cover = coverOf(item);
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const vm = VERDICT_META[r.verdict];
  // 问题列表：reject 优先，再 warn，pass 级（如网盘/链接可达）折叠显示
  const order = { reject: 0, warn: 1, pass: 2 };
  const issueList = [...r.issues].sort((a, b) => order[a.level] - order[b.level])
    .map(x => `<li class="i-${x.level}">${esc(x.msg)}</li>`).join('');
  return `<div class="card ${vm.cls}" data-has-cover="${hasCover(item)}" data-verdict="${r.verdict}">
    <div class="cover">${cover ? coverImg(cover) : '<div class="no-img">无封面</div>'}<div class="badge">${vm.label}</div></div>
    <div class="body">
      <div class="idx">#${i+1}</div>
      <h3>${esc(item.name)}</h3>
      <div class="tags">${tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>
      <ul class="issues">${issueList || '<li class="i-pass">自动检查通过</li>'}</ul>
      <p class="desc">${esc(cut(item.desc, 120))}</p>
      <div class="meta">
        <div><code>${esc(item.id)}</code> <button onclick="copy(this,'${esc(item.id)}')">复制</button></div>
        <div><a href="${esc(item.url)}" target="_blank">${esc(cut(item.url, 55))}</a> <button onclick="copy(this,'${esc(item.url)}')">复制</button></div>
        <div style="color:#666">${esc(item.fetched_at || '')}</div>
      </div>
    </div>
  </div>`;
}).join('');

const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(source)} 候选复核 · ${esc(date)}</title>
<style>
body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#1a1a1a;color:#e0e0e0;margin:0;padding:20px}
header{border-bottom:1px solid #333;padding-bottom:12px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center}
h1{margin:0;font-size:17px}.stats{color:#999;font-size:13px}
.filters{margin-bottom:16px;display:flex;gap:8px}
.filters button{background:#2a2a2a;color:#ddd;border:1px solid #444;padding:5px 12px;border-radius:4px;cursor:pointer;font-size:13px}
.filters button.active{background:#4a90d9;border-color:#4a90d9;color:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px}
.card{background:#252525;border:1px solid #333;border-left:4px solid #555;border-radius:8px;overflow:hidden;display:flex;flex-direction:column}
.card.v-pass{border-left-color:#3fa65a}
.card.v-warn{border-left-color:#e0a53a}
.card.v-reject{border-left-color:#d9534f;opacity:.82}
.badge{position:absolute;right:8px;top:8px;background:rgba(0,0,0,.72);padding:2px 8px;border-radius:10px;font-size:11px}
.cover{position:relative}
.issues{list-style:none;margin:0 0 8px;padding:0;font-size:11.5px;line-height:1.55}
.issues li{padding:1px 0 1px 14px;position:relative}
.issues li::before{content:'•';position:absolute;left:2px}
.issues li.i-reject{color:#ff7a70}
.issues li.i-warn{color:#e8c070}
.issues li.i-pass{color:#7fc98f}
.cover{background:#111;height:170px;display:flex;align-items:center;justify-content:center;overflow:hidden}
.cover img{width:100%;height:100%;object-fit:cover}
.no-img{color:#666;font-size:13px}
.body{padding:12px;flex:1;display:flex;flex-direction:column}
.idx{color:#666;font-size:11px}
.body h3{margin:3px 0 6px;font-size:14px;color:#fff}
.tags{display:flex;flex-wrap:wrap;gap:3px;margin-bottom:6px}
.tags span{background:#3a3a3a;color:#999;padding:1px 7px;border-radius:9px;font-size:11px}
.desc{color:#999;font-size:12px;line-height:1.5;margin:4px 0 10px;flex:1}
.meta{font-size:11px;color:#888;line-height:1.7;border-top:1px solid #333;padding-top:6px}
.meta code{background:#111;padding:1px 4px;border-radius:3px;color:#7cb0e8}
.meta a{color:#7cb0e8;text-decoration:none}
.meta button{background:#333;color:#ccc;border:none;padding:0 5px;border-radius:3px;cursor:pointer;font-size:10px;margin-left:3px}
.meta button:hover{background:#4a90d9;color:#fff}
</style></head><body>
<header><h1>${esc(source)} 候选复核 · ${esc(date)}</h1>
<div class="stats">共 ${items.length} 条 ·
<span style="color:#3fa65a">✅ 可发布 ${passCount}</span> ·
<span style="color:#e0a53a">⚠️ 待确认 ${warnCount}</span> ·
<span style="color:#d9534f">⛔ 不发布 ${rejectCount}</span>
${checkLinks ? ' · 已查链接' : ''}</div></header>
<div class="filters">
<button class="active" onclick="flt(this,'all')">全部</button>
<button onclick="flt(this,'pass')">✅ 可发布</button>
<button onclick="flt(this,'warn')">⚠️ 待确认</button>
<button onclick="flt(this,'reject')">⛔ 不发布</button>
</div><div class="grid">${cards}</div>
<script>
function copy(btn,t){navigator.clipboard.writeText(t).then(()=>{const o=btn.textContent;btn.textContent='✓';setTimeout(()=>btn.textContent=o,700)})}
function flt(btn,mode){
  document.querySelectorAll('.filters button').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.card').forEach(c=>{
    c.style.display=(mode==='all'||c.dataset.verdict===mode)?'':'none';
  });
}
</script></body></html>`;

// ---- Markdown ----
const VERDICT_ICON = { pass: '✅ 可发布', warn: '⚠️ 待确认', reject: '⛔ 不发布' };
const md = [];
md.push(`# ${source} 候选复核 · ${date}`, '');
md.push(`- 共 **${items.length}** 条：✅ 可发布 **${passCount}** ｜ ⚠️ 待确认 **${warnCount}** ｜ ⛔ 不发布 **${rejectCount}**`);
if (checkLinks) md.push(`- 已在线检查链接可达性`);
md.push('', '| # | 结论 | 名称 | 问题 | 链接 | id |', '|---|---|---|---|---|---|');
results.forEach((r, i) => {
  const item = items[i];
  const name = String(item.name || '').replace(/\|/g, '\\|');
  const problems = r.issues.filter(x => x.level !== 'pass').map(x => x.msg).join('；').replace(/\|/g, '\\|') || '—';
  md.push(`| ${i+1} | ${VERDICT_ICON[r.verdict]} | ${name} | ${problems} | [链接](${item.url}) | \`${item.id}\` |`);
});
md.push('', '---', '', '## 详细');
results.forEach((r, i) => {
  const item = items[i];
  const cover = coverOf(item);
  md.push('', `### ${i+1}. ${item.name}　${VERDICT_ICON[r.verdict]}`, '');
  if (cover) md.push(`![cover](${srcOf(cover)})`, '');
  else md.push('> ⚠️ **无封面图**', '');
  if (r.issues.length) {
    md.push('**自动复核结果**：');
    r.issues.forEach(x => md.push(`- ${VERDICT_ICON[x.level] ? (x.level === 'pass' ? '✅' : x.level === 'warn' ? '⚠️' : '⛔') : ''} ${x.msg}`));
    md.push('');
  }
  md.push(`- **id**: \`${item.id}\``);
  md.push(`- **url**: ${item.url}`);
  if (item.tags && item.tags.length) md.push(`- **tags**: ${item.tags.join(', ')}`);
  if (item.desc) md.push('', '**简介**:', '', '> ' + String(item.desc).replace(/\n/g, '\n> '));
  md.push('', '---');
});
md.push('');

const htmlPath = join(REPORTS_DIR, `${source}-${date}.html`);
const mdPath = join(REPORTS_DIR, `${source}-${date}.md`);
writeFileSync(htmlPath, html, 'utf8');
writeFileSync(mdPath, md.join('\n'), 'utf8');

console.log(`📂 源文件: ${filePath}`);
console.log(`✅ HTML: ${htmlPath}`);
console.log(`✅ MD:   ${mdPath}`);
console.log(`📊 共 ${items.length} 条：✅ pass ${passCount} ⚠️ warn ${warnCount} ⛔ reject ${rejectCount}（无图 ${noCoverCount}）`);
if (localCovers) console.log(`🖼️  封面目录: ${join(REPORTS_DIR, COVERS_SUBDIR)}`);

if (autoOpen) exec(`firefox "${htmlPath}"`, err => { if (err) console.log(`⚠️ 手动打开: xdg-open "${htmlPath}"`); });
else console.log(`💡 手动打开: xdg-open "${htmlPath}"`);
