// review.mjs - 复核工具
// 用法: node review.mjs <source> [--date YYYY-MM-DD] [--no-open]
// 输出: reports/<source>-<date>.html 和 reports/<source>-<date>.md

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

// ---- HTML ----
const cards = items.map((item, i) => {
  const cover = coverOf(item);
  const tags = Array.isArray(item.tags) ? item.tags : [];
  return `<div class="card" data-has-cover="${hasCover(item)}">
    <div class="cover">${cover ? `<img src="${esc(cover)}" loading="lazy" referrerpolicy="no-referrer">` : '<div class="no-img">无封面</div>'}</div>
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
  if (cover) md.push(`![cover](${cover})`, '');
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

if (autoOpen) exec(`firefox "${htmlPath}"`, err => { if (err) console.log(`⚠️ 手动打开: xdg-open "${htmlPath}"`); });
else console.log(`💡 手动打开: xdg-open "${htmlPath}"`);
