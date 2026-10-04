/**
 * 来源：galgame —— 聚合器（大文件夹）
 *
 * 目录结构：
 *   sources/galgame/
 *   ├── index.mjs        ← 本文件：扫描子文件夹，逐个调用它们的 fetchGames()
 *   ├── README.md        ← 怎么新增一个站点
 *   ├── siteA/           ← 每个站点一个文件夹
 *   │   ├── index.mjs    ← 导出 async function fetchGames(options)
 *   │   └── README.md
 *   └── siteB/ ...
 *
 * 行为：
 *   1. 扫描 sources/galgame/ 下的所有子目录（"." / "_" 开头的跳过，方便放模板）；
 *   2. 子目录里没有 index.mjs，或没导出 fetchGames → 打印 ⚠️ 跳过；
 *   3. 依次（串行，不并发）调用各子站点的 fetchGames()，合并结果并按 id 去重；
 *   4. 单个子站点抛错 / 返回非数组 → 只跳过它，其它站点照常；
 *   5. 没有任何有效子站点 → 打印提示并优雅返回 []。
 *
 * 新增站点不用改本文件，也不用改 fetch.mjs：新建文件夹 → 写 index.mjs → 就生效。
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GALGAME_DIR = dirname(fileURLToPath(import.meta.url));
const SUB_SITE_ENTRY = 'index.mjs';

/**
 * 兼容开关：
 *   true  → fetch.mjs 一行都不用改。聚合器把每条数据归一化成守门人要求的格式
 *           （source 只能写 "galgame"、必须带 cover / tags），子站点名写进 site 字段。
 *   false → 每条数据的 source 保持 "galgame/<站点名>"，也不需要 cover / tags；
 *           前提是 fetch.mjs 的校验放宽（见 sources/galgame/README.md 的「兼容模式」一节）。
 */
const COMPAT_WITH_VALIDATOR = true;

/** 把错误（含底层 cause 码）拼成一行 */
function errorText(err) {
  if (!err) return String(err);
  const code = err.cause && err.cause.code ? `（${err.cause.code}）` : '';
  return `${err.message || err}${code}`;
}

/** 本地时间 "YYYY-MM-DD HH:mm"，子站点没给 fetched_at 时兜底 */
function nowText() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 只留非空字符串并去重（images / links 用） */
function stringList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const one of value) {
    const text = typeof one === 'string' ? one.trim() : '';
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/**
 * 扫描子站点：只认「带 index.mjs 的子目录」。
 * 文件（index.mjs / README.md / sites.txt.example…）天然不会被当成站点；
 * "." / "_" 开头的目录跳过，所以可以把模板放在 _template/ 里。
 */
function listSubSites() {
  if (!existsSync(GALGAME_DIR)) return [];

  return readdirSync(GALGAME_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.') && !name.startsWith('_'))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      entry: join(GALGAME_DIR, name, SUB_SITE_ENTRY),
      valid: existsSync(join(GALGAME_DIR, name, SUB_SITE_ENTRY)),
    }));
}

/**
 * 把子站点返回的一条数据归一化成统一格式（顺便当守门人：格式不对就丢掉这一条）。
 *
 * 子站点应有的格式：
 *   { id, source, name, desc, images[], links[], url, fetched_at }
 */
function normalizeItem(raw, siteName, position) {
  const at = `${siteName} 第 ${position} 条`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('不是对象');

  const id = String(raw.id || '').trim();
  if (!id) throw new Error('缺少 id');
  if (!id.startsWith('galgame-')) {
    throw new Error(`id「${id}」必须以 galgame- 开头（建议 galgame-${siteName}-<唯一标识>）`);
  }

  const name = String(raw.name || '').trim();
  if (!name) throw new Error('缺少 name');

  const url = String(raw.url || '').trim();
  if (!/^https?:\/\//.test(url)) throw new Error(`url 必须是 http(s) 链接，实际：${raw.url}`);

  const images = stringList(raw.images);
  const links = stringList(raw.links);

  const item = {
    id,
    source: COMPAT_WITH_VALIDATOR ? 'galgame' : `galgame/${siteName}`,
    site: siteName, // 这条数据是哪一子站点抓的（兼容模式下 source 被归一为 galgame，靠 site 区分）
    name,
    desc: typeof raw.desc === 'string' ? raw.desc : String(raw.desc === undefined || raw.desc === null ? '' : raw.desc),
    images, // 帖子里的图片地址
    links,  // 帖子里出现的所有链接（不做类型判断，判断交给人）
    url,    // 原帖地址
    fetched_at: typeof raw.fetched_at === 'string' && raw.fetched_at ? raw.fetched_at : nowText(),
  };

  // ===== 兼容层：守门人 fetch.mjs 目前要求 source === 'galgame'，且必须有 cover / tags 字段 =====
  if (COMPAT_WITH_VALIDATOR) {
    item.cover = images[0] || '';                        // 取第一张图当封面（没有就是空串）
    item.tags = Array.isArray(raw.tags) ? raw.tags : []; // galgame 帖子本来没有标签，空数组
  }

  return item;
}

/**
 * 聚合入口（fetch.mjs 通过动态 import 调用本函数，和其它来源一样）。
 *
 * @param {{ source?: string, date?: string, automationDir?: string, candidatesDir?: string }} options
 * @returns {Promise<Array<object>>} 所有子站点合并后的统一格式数组
 */
export async function fetchGames(options = {}) {
  const sites = listSubSites();

  if (sites.length === 0) {
    console.log('[galgame] 还没有任何子站点。请按 sources/galgame/README.md 新建文件夹（例如 siteA/）+ index.mjs');
    return [];
  }

  console.log(`[galgame] 发现 ${sites.length} 个子站点：${sites.map((site) => site.name).join('、')}`);

  const merged = [];
  const seen = new Set();
  let failedSites = 0;
  let skippedItems = 0;
  let duplicateItems = 0;
  let noImageItems = 0; // 无图但照样入库的条数（人工复核用）

  for (const site of sites) {
    if (!site.valid) {
      failedSites += 1;
      console.warn(`[galgame] ⚠️ ${site.name}：目录里没有 ${SUB_SITE_ENTRY}，已跳过`);
      continue;
    }

    try {
      // 动态加载子站点
      const mod = await import(pathToFileURL(site.entry).href);
      if (typeof mod.fetchGames !== 'function') {
        throw new Error(
          `${SUB_SITE_ENTRY} 没有导出 fetchGames 函数（写：export async function fetchGames(options) { ... }）`,
        );
      }

      const raw = await mod.fetchGames({ ...options, site: site.name, galgameDir: GALGAME_DIR });
      if (!Array.isArray(raw)) throw new Error(`fetchGames 必须返回数组，实际返回 ${typeof raw}`);

      let added = 0;
      raw.forEach((item, index) => {
        let unified;
        try {
          unified = normalizeItem(item, site.name, index + 1);
        } catch (err) {
          skippedItems += 1;
          console.warn(`[galgame]   ⚠️ ${site.name} 第 ${index + 1} 条格式不合法，已跳过：${errorText(err)}`);
          return;
        }
        if (seen.has(unified.id)) {
          duplicateItems += 1;
          return; // 同一个 id 只保留第一条（fetch.mjs 也会拒绝重复 id）
        }
        seen.add(unified.id);
        merged.push(unified);
        added += 1;

        // 软警告：没图也照常入库，只提醒人工确认（不过滤、不丢弃）
        if (unified.images.length === 0) {
          noImageItems += 1;
          console.warn(`[galgame] ⚠️ ${site.name} ${unified.name} 无图，已入库（建议人工确认）`);
        }
      });

      console.log(`[galgame] ✅ ${site.name}：返回 ${raw.length} 条，入库 ${added} 条`);
    } catch (err) {
      // 单个子站点失败只跳过，不影响其它站点
      failedSites += 1;
      console.warn(`[galgame] ⚠️ ${site.name} 抓取失败，已跳过：${errorText(err)}`);
    }
  }

  const extras = [];
  if (skippedItems) extras.push(`丢弃格式不合法的 ${skippedItems} 条`);
  if (duplicateItems) extras.push(`跳过重复 id ${duplicateItems} 条`);
  if (noImageItems) extras.push(`无图 ${noImageItems} 条，建议人工确认`);
  console.log(
    `[galgame] 聚合结束：子站点 ${sites.length} 个（成功 ${sites.length - failedSites} 个，失败 ${failedSites} 个），` +
      `入库 ${merged.length} 条${extras.length ? `（${extras.join('，')}）` : ''}`,
  );

  return merged;
}

