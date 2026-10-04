#!/usr/bin/env node
/**
 * 苦海 · 自动化 —— 把 candidates/ 的封面回填到 queue/ 清单
 *
 * 只处理 queue/ 下「非 _ 开头」的 .json（不递归子目录），对每条清单：
 *   1) screenshots 为空数组                                   → 回填
 *   2) screenshots 非空，但每一条都是「不存在的本地文件」        → 回填（这些路径永远传不出去，换成远程 URL）
 *   3) screenshots 里只要有一条 http(s) URL 或一个真实存在的本地文件 → 不动（视为用户有意配置）
 *   4) 按 name 精确匹配 candidates/steam-*.json 匹配不到        → 保持原样并报告
 *
 * 回填口径：候选 cover 进 screenshots[0]，候选 screenshots（若有）去重后追加，总数 ≤ 5。
 * 写文件时只替换 "screenshots" 那一段文本（清单里非标准排版原样保留），替换后用 JSON
 * 重新解析做全量比对；比对不过退化为整文件重排，再不行报错不写并还原。
 *
 * 运行：node backfill-covers.mjs            真正回填
 *       node backfill-covers.mjs --dry-run  只打印「原值 → 新值」计划，不写文件
 * 环境：Node 18+，零依赖（只用 node: 内置模块）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const QUEUE_DIR = join(ROOT, 'queue');
const CAND_DIR = join(ROOT, 'candidates');
const MAX_SHOTS = 5;                                  // 与 publish-game.mjs 每条截图上限保持一致
const DRY_RUN = process.argv.includes('--dry-run');

const isRemote = (shot) => /^https?:\/\//i.test(String(shot));
const shotPath = (shot, listFile) => (shot.startsWith('/') ? shot : join(dirname(listFile), shot));
const brief = (arr) => `[${arr.map((s) => JSON.stringify(s)).join(', ')}]`;

/** 判定一条清单要不要回填 → { fill, why } */
function judge(list, listFile) {
  const raw = list.screenshots;
  const shots = Array.isArray(raw) ? raw : [];
  const note = raw !== undefined && !Array.isArray(raw) ? '（原 screenshots 不是数组，按空处理）' : '';
  if (!shots.length) return { fill: true, why: `screenshots 为空${note}` };
  const usable = shots.filter((s) => isRemote(s) || existsSync(shotPath(s, listFile)));
  if (usable.length) {
    return { fill: false, why: `${shots.length} 条里有 ${usable.length} 条可用（首条：${usable[0]}）→ 用户有意配置，不动` };
  }
  return { fill: true, why: `screenshots 非空但 ${shots.length} 条全是「不存在的本地文件」${note}` };
}

/** 扫 candidates/steam-*.json 建 name → 候选 索引（同名以文件名较晚的为准） */
function loadCandidates() {
  const files = readdirSync(CAND_DIR).filter((f) => /^steam-.*\.json$/i.test(f)).sort();
  const index = new Map();
  const dups = [];
  let bad = 0;
  for (const file of files) {
    let arr;
    try {
      arr = JSON.parse(readFileSync(join(CAND_DIR, file), 'utf8'));
    } catch (e) {
      bad += 1;
      console.log(`   ⚠️ 候选文件解析失败，跳过：${file}（${e.message}）`);
      continue;
    }
    if (!Array.isArray(arr)) {
      bad += 1;
      console.log(`   ⚠️ 候选文件不是数组，跳过：${file}`);
      continue;
    }
    for (const item of arr) {
      const name = item && typeof item.name === 'string' ? item.name.trim() : '';
      if (!name) continue;
      if (index.has(name)) dups.push(`${name}（${index.get(name).file} → ${file}，以后者为准）`);
      index.set(name, { item, file });
    }
  }
  return { files, index, dups, bad };
}

/** 由候选条目生成截图列表：cover 进 [0]，再追加候选 screenshots（去重，总数 ≤ MAX_SHOTS） */
function shotsFromCandidate(item) {
  const out = [];
  if (item.cover) out.push(String(item.cover));
  for (const s of Array.isArray(item.screenshots) ? item.screenshots : []) {
    const url = String(s || '');
    if (url && !out.includes(url) && out.length < MAX_SHOTS) out.push(url);
  }
  return out.slice(0, MAX_SHOTS);
}

/** 生成新文件内容：优先只替换 screenshots 那一段，并用 JSON 全量比对校验 */
function patchFile(raw, parsed, next) {
  const expected = JSON.stringify({ ...parsed, screenshots: next });
  const re = /("screenshots"\s*:\s*)\[[^\]]*\]/s;
  const m = raw.match(re);
  if (m) {
    const indent = (raw.match(/\n(\s*)"/) || [])[1] || '  '; // 顶层字段的缩进（通常是 2 空格）
    const body = next.length
      ? `[\n${next.map((s) => `${indent}  ${JSON.stringify(s)}`).join(',\n')}\n${indent}]`
      : '[]';
    const patched = raw.replace(re, (whole, head) => head + body);
    try {
      if (JSON.stringify(JSON.parse(patched)) === expected) return { text: patched, mode: '仅替换 screenshots 块' };
    } catch { /* 落到整文件重排 */ }
  }
  return { text: `${JSON.stringify({ ...parsed, screenshots: next }, null, 2)}\n`, mode: '整文件重排' };
}

// ---------- 主流程 ----------
console.log(`🔎 backfill-covers${DRY_RUN ? '（--dry-run：只打印计划，不写文件）' : ''}`);
console.log(`   清单目录：${QUEUE_DIR}`);
console.log(`   候选目录：${CAND_DIR}`);

const { files: candFiles, index, dups, bad: candBad } = loadCandidates();
console.log(`   候选：${candFiles.length} 个文件 → ${index.size} 个游戏名${candBad ? `（跳过 ${candBad} 个）` : ''}`);
for (const d of dups) console.log(`   ⚠️ 重名候选：${d}`);
console.log('');

const entries = readdirSync(QUEUE_DIR, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.json'));
const listFiles = entries.map((e) => e.name).filter((n) => !n.startsWith('_')).sort();
const skippedFiles = entries.map((e) => e.name).filter((n) => n.startsWith('_')).sort();

const stat = { filled: 0, kept: 0, nomatch: 0, nocover: 0, failed: 0 };

for (const name of listFiles) {
  const file = join(QUEUE_DIR, name);
  console.log(`▶ queue/${name}`);

  let raw;
  let list;
  try {
    raw = readFileSync(file, 'utf8');
    list = JSON.parse(raw);
  } catch (e) {
    stat.failed += 1;
    console.log(`   ❌ 读取/解析失败，跳过：${e.message}\n`);
    continue;
  }

  const { fill, why } = judge(list, file);
  console.log(`   名称：${typeof list.name === 'string' ? `「${list.name}」` : '（缺 name 字段）'}`);
  console.log(`   判定：${why}`);

  let hit = null;
  if (fill) hit = index.get(typeof list.name === 'string' ? list.name.trim() : '');
  if (!fill) {
    stat.kept += 1;
    console.log('   ⏭️ 不动\n');
    continue;
  }
  if (!hit) {
    stat.nomatch += 1;
    console.log(`   ⏭️ 未匹配到候选（candidates 里没有 name 完全等于「${list.name}」的条目）→ 保持原样\n`);
    continue;
  }

  const next = shotsFromCandidate(hit.item);
  const candShots = Array.isArray(hit.item.screenshots) ? hit.item.screenshots.length : 0;
  console.log(`   匹配：candidates/${hit.file} 的「${hit.item.name}」${hit.item.id ? `（${hit.item.id}）` : ''}`);
  console.log(`   候选图：cover ${hit.item.cover ? '1 张' : '无'} + screenshots 数组 ${candShots} 张 → 本次填 ${next.length} 张（上限 ${MAX_SHOTS}）`);
  if (!next.length) {
    stat.nocover += 1;
    console.log('   ⏭️ 候选既没有 cover 也没有 screenshots → 保持原样\n');
    continue;
  }

  console.log(`   原值：${list.screenshots === undefined ? '(无此字段)' : brief(Array.isArray(list.screenshots) ? list.screenshots : [list.screenshots])}`);
  console.log(`   新值：${brief(next)}`);

  const { text, mode } = patchFile(raw, list, next);
  if (DRY_RUN) {
    stat.filled += 1;
    console.log(`   ✍️ 待写入（${mode}；--dry-run 未落盘）\n`);
    continue;
  }
  try {
    writeFileSync(file, text);
    const back = JSON.parse(readFileSync(file, 'utf8'));
    if (JSON.stringify(back) !== JSON.stringify({ ...list, screenshots: next })) throw new Error('写后回读比对不一致');
    stat.filled += 1;
    console.log(`   ✅ 已回填（${mode}）\n`);
  } catch (e) {
    stat.failed += 1;
    try {
      writeFileSync(file, raw);
    } catch { /* 尽力还原 */ }
    console.log(`   ❌ 写入失败，已还原原内容：${e.message}\n`);
  }
}

// ---------- 汇总 ----------
console.log('── 汇总 ──');
console.log(`   扫描清单 ${listFiles.length} 条${skippedFiles.length ? `（跳过 ${skippedFiles.length} 条 _ 开头：${skippedFiles.join('、')}）` : ''}`);
console.log(`   回填 ${stat.filled} 条、已有可用截图跳过 ${stat.kept} 条、未匹配候选 ${stat.nomatch} 条、候选无图 ${stat.nocover} 条、失败 ${stat.failed} 条`);
if (DRY_RUN) console.log('   （--dry-run：上面的「原值 → 新值」只是计划，磁盘未改动）');

// ---------- queue/ 各清单最终 screenshots ----------
console.log('');
console.log('── queue/ 各清单最终 screenshots ──');
for (const name of listFiles) {
  try {
    const l = JSON.parse(readFileSync(join(QUEUE_DIR, name), 'utf8'));
    const shots = Array.isArray(l.screenshots) ? l.screenshots : [];
    console.log(`   ${shots.length} 张  ${name}${l.name && l.name !== name.replace(/\.json$/, '') ? `（name=「${l.name}」）` : ''}`);
    if (!shots.length) console.log('         （空）');
    for (const s of shots) console.log(`         ${s}`);
  } catch (e) {
    console.log(`   ??  ${name}  读取失败：${e.message}`);
  }
}

process.exit(stat.failed ? 1 : 0);


