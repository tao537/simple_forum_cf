/**
 * 来源：Steam 免费游戏
 *
 * 依赖两个官方公开接口（无需 key）：
 *   1. 分类接口 https://store.steampowered.com/api/featuredcategories?cc=CN&l=schinese
 *      → 返回 specials / new_releases / top_sellers / coming_soon / genres 等分类，每个分类里有 items
 *   2. 详情接口 https://store.steampowered.com/api/appdetails?appids=<appid>&cc=CN&l=schinese
 *      → 返回 short_description / header_image / genres（分类接口里没有类型标签，必须靠这里）
 *
 * 依据 fetch.mjs 的动态加载约定：本文件必须导出 fetchGames 函数，
 * 返回的每条数据都遵守统一格式（id/source/name/desc/url/cover/tags/fetched_at）。
 *
 * 实测（2026-10-04，cc=CN&l=schinese）：分类去重 52 款，判为免费 14 款，
 * 其中含 Demo 试玩版（例：Cats and Hats Demo），由下面的 SKIP_DEMO 开关决定是否入库。
 */
const FEATURED_URL = 'https://store.steampowered.com/api/featuredcategories?cc=CN&l=schinese';
const DETAIL_URL = (appid) => `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=CN&l=schinese`;

const REQUEST_INTERVAL = 2000; // 每次请求之间的间隔（毫秒），Steam 接口限流严格
const REQUEST_TIMEOUT = 20000; // 单次请求超时（毫秒），避免网络卡死时无限等待
const USER_AGENT = 'Mozilla/5.0 (compatible; kuhai-automation/1.0)';

// 是否跳过试玩版 Demo（判定依据：详情接口返回的 type === 'demo'），想收录试玩版改成 false
const SKIP_DEMO = true;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 本地时间 "YYYY-MM-DD HH:mm"，写进统一格式的 fetched_at */
function nowText() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 价格字段转数字；null / undefined / '' 视为「没有价格」，避免 Number(null) === 0 的误判 */
function toPrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** 免费判定：final_price 或 original_price 为 0（两个字段都没有价格则不算免费） */
function isFree(item) {
  const prices = [toPrice(item.final_price), toPrice(item.original_price)].filter((v) => v !== null);
  return prices.some((price) => price === 0);
}

/** 把错误（含底层 cause 码）拼成一行，便于排查 */
function errorText(err) {
  if (!err) return String(err);
  const code = err.cause && err.cause.code ? `（${err.cause.code}）` : '';
  return `${err.message || err}${code}`;
}

/** 带超时与 UA 的 JSON 请求，非 2xx 直接抛错（由调用方决定是否跳过） */
async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

/** 从分类接口响应里收集所有分类的条目，同一个 appid 只留一份 */
function collectFeaturedItems(json) {
  const map = new Map();

  for (const value of Object.values(json || {})) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.items)) continue;
    for (const item of value.items) {
      if (!item || typeof item.id !== 'number') continue;
      if (!map.has(item.id)) map.set(item.id, item);
    }
  }

  return [...map.values()];
}

/** 分类接口里的 genres 可能是 "Action;Indie" 这样的字符串，仅作兜底（正常类型来自详情接口） */
function tagsFromFeatured(item) {
  const raw = item.genres;
  if (Array.isArray(raw)) {
    return raw.map((g) => (typeof g === 'string' ? g : g && g.description)).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/** 去重并去掉空标签 */
function normalizeTags(list) {
  const out = [];
  for (const raw of list) {
    const tag = String(raw === null || raw === undefined ? '' : raw).trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}
/**
 * 抓取 Steam 免费游戏（fetch.mjs 通过动态 import 调用本函数）。
 *
 * @param {{ source?: string, date?: string, automationDir?: string, candidatesDir?: string }} options
 *        date 只用于 fetch.mjs 的输出文件名；fetched_at 始终记录真实抓取时间。
 * @returns {Promise<Array<object>>} 统一格式的数据数组
 */
export async function fetchGames(options = {}) {
  const fetchedAt = nowText();

  console.log(`[steam] 拉取分类接口：${FEATURED_URL}`);
  // 分类接口失败属于整批失败：直接抛错，由 fetch.mjs 统一报错退出
  const featured = await getJson(FEATURED_URL);

  const allItems = collectFeaturedItems(featured);
  const freeItems = allItems.filter(isFree);
  console.log(`[steam] 分类去重后 ${allItems.length} 款，其中免费 ${freeItems.length} 款`);

  if (freeItems.length === 0) return [];

  const games = [];
  let demoCount = 0;
  let failCount = 0;
  let noCoverCount = 0; // 无封面图但照样入库的款数（人工复核用）

  for (let index = 0; index < freeItems.length; index += 1) {
    const item = freeItems[index];
    const appid = item.id;
    const label = `[${index + 1}/${freeItems.length}] ${item.name || `App ${appid}`}（${appid}）`;

    try {
      const detail = await getJson(DETAIL_URL(appid));
      const entry = detail ? detail[String(appid)] : null;
      if (!entry || !entry.success || !entry.data) throw new Error('接口返回 success=false');

      const data = entry.data;

      if (SKIP_DEMO && String(data.type || '').toLowerCase() === 'demo') {
        demoCount += 1;
        console.log(`[steam]   ⏭️ ${label} 是试玩版 Demo，跳过`);
      } else {
        const game = {
          id: `steam-${appid}`,
          source: 'steam',
          name: data.name || item.name || `App ${appid}`,
          desc: String(data.short_description || '').trim(),
          url: `https://store.steampowered.com/app/${appid}/`,
          cover: data.header_image || item.header_image || '',
          tags: normalizeTags([
            ...((data.genres || []).map((genre) => genre && genre.description)),
            ...tagsFromFeatured(item),
          ]),
          fetched_at: fetchedAt,
        };

        games.push(game);
        console.log(`[steam]   ✅ ${label}`);

        // 软警告：没有封面图也照常入库，只提醒人工确认（不过滤、不丢弃）
        if (!game.cover) {
          noCoverCount += 1;
          console.warn(`[steam]   ⚠️ ${game.name} 无封面图，已入库（建议人工确认）`);
        }
      }
    } catch (err) {
      // 单个游戏失败只跳过，不影响整批（这是本来源唯一允许的容错）
      failCount += 1;
      console.warn(`[steam]   ⚠️ ${label} 获取详情失败，已跳过：${errorText(err)}`);
    }

    if (index < freeItems.length - 1) await sleep(REQUEST_INTERVAL); // 请求间隔 2 秒
  }

  console.log(
    `[steam] 详情抓取结束：入库 ${games.length} 款（跳过试玩版 ${demoCount} 款、详情失败 ${failCount} 款、无封面图 ${noCoverCount} 款）`,
  );
  return games;
}
