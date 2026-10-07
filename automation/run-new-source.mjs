/**
 * 自动抓取 + 生成发布清单（可选自动发布）—— 把 sources/galgame/ 下的新子站
 * 一键跑通：抓取 → 入库 candidates → 生成 queue 清单 → 逐条交给 publish-game.mjs。
 *
 * 用法（在哪个目录执行都一样，脚本内全部锚定 automation/）：
 *   node run-new-source.mjs                 按 auto-publish.config.json 行为（默认不发布）
 *   node run-new-source.mjs --publish       本次强制真实发布（覆盖配置里的 publish）
 *   node run-new-source.mjs --limit 2       临时覆盖每站条数
 *
 * 行为细节：
 *   1. 单个子站抓取失败不影响其它子站；全部失败以退出码 1 结束。
 *   2. candidates 合并规则与 fetch.mjs 一致（按 id 去重，旧的优先），可直接被 review.mjs 消费。
 *   3. 清单写到 queue/auto-<站点>-<hash>.json；同名文件已存在就跳过（可安全重跑）。
 *   4. panUrl 从候选 links 里按配置的域名优先级挑；一条链接都没有的候选直接跳过并记录
 *      （publish-game.mjs 要求 panUrl 必填，不生成必炸的清单）。
 *   5. 发布逐条进行（--file），一条失败不影响其它条；失败的清单**保留在 queue/ 里**
 *      （文件名不带 _ 前缀，下次可直接 `node publish-game.mjs --file queue/xxx.json` 重试）。
 *   6. 零 npm 依赖（Node 18+）。
 *
 * ⚠️ 本脚本不打印 config.json 的任何值；不删除任何文件。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AUTOMATION_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(AUTOMATION_DIR, 'auto-publish.config.json');
const CANDIDATES_DIR = join(AUTOMATION_DIR, 'candidates');
const QUEUE_DIR = join(AUTOMATION_DIR, 'queue');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowText() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- 配置 ----------
function loadConfig() {
  const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  // 命令行参数覆盖
  const argv = process.argv.slice(2);
  if (argv.includes('--publish')) raw.publish = true;
  const limitIdx = argv.indexOf('--limit');
  if (limitIdx !== -1 && argv[limitIdx + 1]) raw.limitPerSource = Number(argv[limitIdx + 1]) || raw.limitPerSource;
  return {
    sources: Array.isArray(raw.sources) && raw.sources.length ? raw.sources : [],
    limitPerSource: Math.max(1, Number(raw.limitPerSource) || 3),
    publish: raw.publish === true,
    notesMaxChars: Math.max(200, Number(raw.notesMaxChars) || 1200),
    panHostPriority: Array.isArray(raw.panHostPriority) ? raw.panHostPriority : [],
    noNeedCodeMark: String(raw.noNeedCodeMark || '无需'),
    genre: { default: 'galgame', ...(raw.genre || {}) },
    platform: { default: 'PC', ...(raw.platform || {}) },
  };
}

// ---------- 归一化（与 sources/galgame/index.mjs 的 normalizeItem 对齐） ----------
function normalizeItem(raw, siteName) {
  const images = Array.isArray(raw.images) ? raw.images.filter((x) => typeof x === 'string' && x) : [];
  const links = Array.isArray(raw.links) ? raw.links.filter((x) => typeof x === 'string' && x) : [];
  return {
    id: String(raw.id || '').trim(),
    source: 'galgame',
    site: siteName,
    name: String(raw.name || '').trim(),
    desc: typeof raw.desc === 'string' ? raw.desc : '',
    images,
    links,
    url: String(raw.url || '').trim(),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((x) => typeof x === 'string') : [],
    cover: images[0] || '',
    fetched_at: typeof raw.fetched_at === 'string' && raw.fetched_at ? raw.fetched_at : nowText(),
  };
}

// ---------- candidates 合并（与 fetch.mjs 的 mergeById 语义一致：旧的优先） ----------
function mergeCandidates(date, items) {
  mkdirSync(CANDIDATES_DIR, { recursive: true });
  const outFile = join(CANDIDATES_DIR, `galgame-${date}.json`);
  const existing = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : [];
  const list = Array.isArray(existing) ? existing : [];
  const seen = new Set(list.map((x) => x.id).filter(Boolean));
  let added = 0;
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    list.push(item);
    added += 1;
  }
  writeFileSync(outFile, `${JSON.stringify(list, null, 2)}\n`, 'utf8');
  return { outFile, added, total: list.length };
}

// ---------- panUrl 挑选 ----------
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function choosePanUrl(links, panHostPriority) {
  const httpLinks = links.filter((u) => /^https?:\/\//i.test(u));
  for (const suffix of panHostPriority) {
    const hit = httpLinks.find((u) => {
      const host = hostOf(u);
      return host === suffix || host.endsWith(`.${suffix}`) || host.includes(suffix);
    });
    if (hit) return hit;
  }
  return httpLinks[0] || '';
}

// ---------- 清单生成 ----------
function buildManifests(items, cfg, dateStamp) {
  mkdirSync(QUEUE_DIR, { recursive: true });
  const manifests = [];
  const skipped = [];
  for (const item of items) {
    if (!item.id || !item.name || !item.url) {
      skipped.push({ name: item.name || '(无名)', reason: '缺 id/name/url' });
      continue;
    }
    const panUrl = choosePanUrl(item.links, cfg.panHostPriority);
    if (!panUrl) {
      skipped.push({ name: item.name, reason: 'links 里没有任何 http(s) 链接（publish 要求 panUrl 必填）' });
      continue;
    }
    const isPan = cfg.panHostPriority.some((s) => hostOf(panUrl).includes(s));
    const isAndroid = item.tags.includes('安卓');

    const notes = [
      item.desc.slice(0, cfg.notesMaxChars),
      `来源：${item.site}｜原帖：${item.url}`,
    ]
      .filter(Boolean)
      .join('\n');

    const manifest = {
      name: item.name,
      panUrl,
      // 网盘链接 + 没有码 → 留空（publish 会走「暂缺」提示并记进 _no-code-warnings.json）
      // 直链（如 shinnku 的 B2）→ 明确填「无需」
      ...(isPan ? {} : { panCode: cfg.noNeedCodeMark }),
      genre: isAndroid ? cfg.genre['安卓'] || cfg.genre.default : cfg.genre.default,
      platform: isAndroid ? cfg.platform['安卓'] || cfg.platform.default : cfg.platform.default,
      tags: item.tags.slice(0, 6),
      notes,
      screenshots: item.cover ? [item.cover] : [],
    };

    const hash = createHash('sha256').update(item.id).digest('hex').slice(0, 8);
    const file = join(QUEUE_DIR, `auto-${item.site}-${hash}.json`);
    if (existsSync(file)) {
      console.log(`  · 清单已存在，跳过生成：${file}`);
      manifests.push({ file, existed: true });
      continue;
    }
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    console.log(`  · 生成清单：${file}`);
    manifests.push({ file, existed: false });
  }
  return { manifests, skipped };
}

// ---------- 发布（逐条 --file，一条失败不影响其它） ----------
function publishManifests(manifests, dryRun) {
  const results = [];
  for (const { file } of manifests) {
    const args = [join(AUTOMATION_DIR, 'publish-game.mjs'), '--file', file];
    if (dryRun) args.push('--dry-run');
    console.log(`\n===== publish-game.mjs ${dryRun ? '--dry-run' : ''} ${file} =====`);
    const r = spawnSync(process.execPath, args, {
      cwd: AUTOMATION_DIR,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    results.push({ file, ok: r.status === 0 });
  }
  return results;
}

// ---------- 主流程 ----------
async function main() {
  const cfg = loadConfig();
  if (cfg.sources.length === 0) {
    console.error('auto-publish.config.json 里 sources 为空，无事可做');
    process.exit(1);
  }

  console.log(`🚀 自动抓取+发布：源 [${cfg.sources.join(', ')}]，每站 ${cfg.limitPerSource} 条，publish=${cfg.publish ? '真实发布' : '仅 dry-run'}`);

  const date = nowText().slice(0, 10);
  const normalized = [];
  const sourceErrors = [];

  for (const site of cfg.sources) {
    const entry = join(AUTOMATION_DIR, 'sources', 'galgame', site, 'index.mjs');
    if (!existsSync(entry)) {
      sourceErrors.push(`${site}: sources/galgame/${site}/index.mjs 不存在`);
      continue;
    }
    console.log(`\n----- 抓取 ${site} -----`);
    try {
      const mod = await import(pathToFileURL(entry).href);
      if (typeof mod.fetchGames !== 'function') throw new Error('没有导出 fetchGames');
      const rawItems = await mod.fetchGames({ limit: cfg.limitPerSource });
      const items = (Array.isArray(rawItems) ? rawItems : []).map((x) => normalizeItem(x, site));
      console.log(`  ${site} 返回 ${items.length} 条`);
      normalized.push(...items);
    } catch (err) {
      const msg = `${site}: ${err && err.message ? err.message : err}`;
      sourceErrors.push(msg);
      console.warn(`  ⚠️ ${msg}`);
    }
    if (cfg.sources.indexOf(site) < cfg.sources.length - 1) await sleep(1000);
  }

  // 即使部分源失败，只要有数据就继续（「内容不全也要上传」）
  if (normalized.length === 0) {
    console.error('\n❌ 所有源都没有返回数据，无法生成清单。错误：\n  ' + sourceErrors.join('\n  '));
    process.exit(1);
  }

  const { outFile, added, total } = mergeCandidates(date, normalized);
  console.log(`\n📚 candidates 合并完成：新增 ${added} 条，文件共 ${total} 条 → ${outFile}`);

  // 只给「本次新抓到的」生成清单：重跑时 added 可能为 0，但清单文件已存在也会被复用
  const pool = added > 0 ? normalized : normalized; // 生成逻辑本身按 hash 幂等，直接全量喂
  const { manifests, skipped } = buildManifests(pool, cfg, date);
  if (skipped.length) {
    console.log('\n⚠️ 以下候选没有生成清单（保留在候选里，不影响其它条目）：');
    for (const s of skipped) console.log(`  · ${s.name}：${s.reason}`);
  }

  if (manifests.length === 0) {
    console.log('\n没有可发布的清单，结束（候选已入库）。');
    return;
  }

  console.log(`\n🧾 清单 ${manifests.length} 份（新增 ${manifests.filter((m) => !m.existed).length}），开始 ${cfg.publish ? '真实发布' : 'dry-run 预览'}…`);
  const results = publishManifests(manifests, !cfg.publish);

  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  console.log(`\n===== 汇总 =====`);
  console.log(`✅ 成功 ${ok.length} 条，❌ 失败 ${bad.length} 条`);
  for (const b of bad) console.log(`   失败（清单保留，可人工重试）：${b.file}`);
  if (sourceErrors.length) {
    console.log(`⚠️ 源错误（本次忽略）：${sourceErrors.join('；')}`);
  }
  if (bad.length > 0) process.exit(2);
}

main().catch((err) => {
  console.error('💥 运行异常：', err && err.stack ? err.stack : err);
  process.exit(1);
});
