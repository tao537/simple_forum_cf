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

const args = process.argv.slice(2);
const source = args[0];
if (!source) { console.error('用法: node review.mjs <source> [--date YYYY-MM-DD] [--no-open]'); process.exit(1); }
const dateIdx = args.indexOf('--date');
const dateArg = dateIdx !== -1 ? args[dateIdx + 1] : null;
const autoOpen = !args.includes('--no-open');
const localCovers = args.includes('--local-covers');

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
const cards = items.map((item, i) => {
  const cover = coverOf(item);
  const tags = Array.isArray(item.tags) ? item.tags : [];
  return `<div class="card" data-has-cover="${hasCover(item)}">
    <div class="cover">${cover ? coverImg(cover) : '<div class="no-img">无封面</div>'}</div>
    <div class="body">
      <div class="idx">#${i+1}</div>
      <h3>${esc(item.name)}</h3>
      <div class="tags">${tags.map(t => `<span>${esc(t)}</span>`).join('')}</div>
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
.card{background:#252525;border:1px solid #333;border-radius:8px;overflow:hidden;display:flex;flex-direction:column}
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
<header><h1>${esc(source)} 候选复核 · ${esc(date)}</h1><div class="stats">共 ${items.length} 条 · 无图 ${noCoverCount} 条</div></header>
<div class="filters">
<button class="active" onclick="flt(this,'all')">全部</button>
<button onclick="flt(this,'yes')">仅有图</button>
<button onclick="flt(this,'no')">仅无图</button>
</div><div class="grid">${cards}</div>
<script>
function copy(btn,t){navigator.clipboard.writeText(t).then(()=>{const o=btn.textContent;btn.textContent='✓';setTimeout(()=>btn.textContent=o,700)})}
function flt(btn,mode){
  document.querySelectorAll('.filters button').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.card').forEach(c=>{
    const h=c.dataset.hasCover==='true';
    c.style.display=mode==='all'?'':(mode==='yes'&&h)||(mode==='no'&&!h)?'':'none';
  });
}
</script></body></html>`;

// ---- Markdown ----
const md = [];
md.push(`# ${source} 候选复核 · ${date}`, '');
md.push(`- 共 **${items.length}** 条`);
if (noCoverCount > 0) md.push(`- ⚠️ 其中 **${noCoverCount}** 条无图，建议人工确认`);
md.push('', '| # | 名称 | 标签 | 链接 | id |', '|---|---|---|---|---|');
items.forEach((item, i) => {
  const tags = Array.isArray(item.tags) ? item.tags.join(' / ') : '';
  const name = String(item.name || '').replace(/\|/g, '\\|');
  md.push(`| ${i+1} | ${name} | ${tags} | [链接](${item.url}) | \`${item.id}\` |`);
});
md.push('', '---', '', '## 详细');
items.forEach((item, i) => {
  const cover = coverOf(item);
  md.push('', `### ${i+1}. ${item.name}`, '');
  if (cover) md.push(`![cover](${srcOf(cover)})`, '');
  else md.push('> ⚠️ **无封面图**', '');
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
console.log(`📊 共 ${items.length} 条，无图 ${noCoverCount} 条`);
if (localCovers) console.log(`🖼️  封面目录: ${join(REPORTS_DIR, COVERS_SUBDIR)}`);

if (autoOpen) exec(`firefox "${htmlPath}"`, err => { if (err) console.log(`⚠️ 手动打开: xdg-open "${htmlPath}"`); });
else console.log(`💡 手动打开: xdg-open "${htmlPath}"`);
