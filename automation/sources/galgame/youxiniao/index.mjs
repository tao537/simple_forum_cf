/**
 * 子站点：youxiniao（游戏鸟手游网 · 安卓频道）
 *
 * 站点：https://www.youxiniao.com/android/
 * 抓取流程：列表页（.rank_loop 里的详情页链接）→ 详情页（h1 / .cont / 截图）
 *           → 再请求一次下载接口 /downs/detail/<id>/<type> 拿真实下载地址。
 *
 * ⚠️ 本站与模板原版的 3 个关键差异（改错就抓不到东西）：
 *   1. 详情页没有 og:title / og:image，标题只能取 <h1>；
 *   2. 下载地址不在静态 HTML 里（按钮是 href="javascript:;"），必须调下载接口；
 *      → 所以 parsePost() 改成了 async，fetchGames() 里调用处要 await；
 *   3. 图片有 Referer 防盗链（不带 Referer 一律 403），拿图的地方要带上站点 Referer。
 *
 * 列表页没有翻页器（28 条/页）；如需更多条，可把 LIST_URL 换成
 * 'https://www.youxiniao.com/new/Game_1.html'（时间倒序，Game_N.html 可翻页）。
 */
import { createHash } from 'node:crypto';

// ==================== 站点配置（改这里） ====================
const SITE_NAME = 'youxiniao';                   // 与文件夹名保持一致
const LIST_URL = 'https://www.youxiniao.com/android/'; // 安卓频道列表页（实测 28 条/页，无翻页器）
const SITE_ORIGIN = 'https://www.youxiniao.com';       // 下载接口与 Referer 用
const DOWNLOAD_API = `${SITE_ORIGIN}/downs/detail`;    // 下载接口：/downs/detail/<id>/<type>
const MAX_POSTS = 10;                            // 单次最多抓几个帖子
const REQUEST_INTERVAL = 2000;                   // 每次请求之间的间隔（毫秒）
const API_INTERVAL = 1000;                       // 同一条内「详情页 → 下载接口」之间的间隔（毫秒）
const REQUEST_TIMEOUT = 20000;                   // 单次请求超时（毫秒）
const USER_AGENT = 'Mozilla/5.0 (compatible; kuhai-automation/1.0)'; // 实测本站接受这个 UA

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(err) {
  if (!err) return String(err);
  const code = err.cause && err.cause.code ? `（${err.cause.code}）` : '';
  return `${err.message || err}${code}`;
}

function nowText() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 帖子 URL → 稳定唯一 id（同一帖子永远同一个 id，重复抓取时 fetch.mjs 会自动去重） */
function idFromUrl(url) {
  return `galgame-${SITE_NAME}-${createHash('sha256').update(url).digest('hex').slice(0, 12)}`;
}

// ==================== 通用工具（一般不用改） ====================
function parseAttrs(text) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    attrs[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4];
  }
  return attrs;
}

/** 收集所有 <meta>：property / name 作键，content 作值 */
function collectMeta(html) {
  const meta = {};
  const re = /<meta\s+([^>]+?)\/?>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const attrs = parseAttrs(match[1]);
    const key = String(attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content !== undefined) meta[key] = attrs.content;
  }
  return meta;
}

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&mdash;/gi, '—')
    .replace(/&hellip;/gi, '…')
    .replace(/&amp;/gi, '&');
}

/** 去掉所有标签，压成单行文本（用于标题） */
function cleanText(text) {
  return decodeEntities(String(text === null || text === undefined ? '' : text).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把 HTML 转成「保留段落换行」的纯文本（用于正文 desc） */
function htmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ') // 脚本、样式丢掉
      .replace(/<br\s*\/?>/gi, '\n')                         // 换行标签 → \n
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')           // 块级标签结束 → \n
      .replace(/<[^>]*>/g, ''),                              // 其余标签丢掉
  )
    .replace(/[ \t\u00a0]+/g, ' ') // 行内多余空白压成一个空格
    .replace(/\n{3,}/g, '\n\n')    // 最多保留一个空行
    .trim();
}

/** 相对地址 → 绝对地址；不是 http(s) 就返回空串 */
function absoluteUrl(href, baseUrl) {
  try {
    const url = new URL(String(href || '').trim(), baseUrl).href;
    return /^https?:\/\//i.test(url) ? url : '';
  } catch {
    return '';
  }
}

/** 编码嗅探：中文站点常见 gbk / gb2312 */
function detectCharset(res, buffer) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(res.headers.get('content-type') || '');
  if (fromHeader) return fromHeader[1].toLowerCase();
  const head = buffer.subarray(0, 2048).toString('latin1');
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  return fromMeta ? fromMeta[1].toLowerCase() : '';
}

/** 抓一个页面并解码成字符串（Node 内置 fetch / Buffer / TextDecoder，无依赖） */
async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const charset = detectCharset(res, buffer);
  if (!charset || /^utf-?8$/i.test(charset)) return buffer.toString('utf8');
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString('utf8');
  }
}

/**
 * 抓一个 JSON 接口并解析（Node 内置 fetch，无依赖）。
 * 游戏鸟的下载接口要求带 Referer + X-Requested-With（模拟它自己的 $.get），
 * 否则可能拿不到数据；Referer 用当前详情页地址最稳。
 */
async function fetchJson(url, referer) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: referer || `${SITE_ORIGIN}/`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回的不是 JSON：${text.slice(0, 80)}`);
  }
}

// ==================== 页面解析（按站点结构改这里） ====================
/** 详情页 URL 特征：/game/<拼音slug>/ 或 /soft/<拼音slug>/（无数字 id，末尾带斜杠） */
const DETAIL_URL_RE = /^https?:\/\/(?:www\.)?youxiniao\.com\/(?:game|soft)\/[a-z0-9_-]+\/?$/i;

/**
 * 列表页 → 帖子详情页链接数组（游戏鸟「安卓频道」）。
 *
 * 实测结构（2026-10-04，https://www.youxiniao.com/android/，28 条/页）：
 *   <div class="rank_loop">
 *     <dl class="glide clearfix">
 *       <dt><a href="https://www.youxiniao.com/game/<slug>/" title="…"><img …></a></dt>
 *       <dd><h5><a href="同一条链接">标题</a></h5><p>分类</p><a class="download">详情</a></dd>
 *     </dl>
 *   </div>
 *
 * 两个坑：
 *   1. 每个条目里同一条详情链接出现 3 次（图 / 标题 / 详情按钮）→ 每块只取第一条；
 *   2. 全页扫 /game|soft/ 会把「下载排行 / 推荐 / 专题」侧栏一起抓进来（实测 99 条 vs 主列表 28 条）
 *      → 必须只在 rank_loop 块内取。
 */
function parseList(html, baseUrl) {
  const blocks = html.match(/<div[^>]+class=["'][^"']*\brank_loop\b[^"']*["'][^>]*>[\s\S]*?<\/dl>/gi) || [];
  const scope = blocks.length ? blocks : [html]; // 站点改版时退回整页扫描，别直接抓空

  const urls = [];
  for (const block of scope) {
    const re = /<a[^>]+href=["']([^"']+)["']/gi;
    let match;
    while ((match = re.exec(block)) !== null) {
      const abs = absoluteUrl(match[1], baseUrl);
      if (!abs || !DETAIL_URL_RE.test(abs)) continue;
      if (!urls.includes(abs)) urls.push(abs);
      break; // 每块只取第一条详情链接
    }
  }
  return urls.slice(0, MAX_POSTS);
}

/**
 * 帖子页（游戏详情页）→ { name, desc, images, links }。
 *
 * 实测结构（2026-10-04，/game/zhendangfangwei3/）：
 *   标题：<div class="info"><dl><dt><h1>正当防卫3手机版免费下载地址</h1>
 *         本站没有 og:title，<title> 还带「- 游戏鸟」尾巴和版本号，所以必须取 <h1>。
 *   正文：<section class="gameBcontent">…<div class="cont">…</div>   ← class="cont" 全页唯一
 *   截图：<div class="screenshot swiper-container"><li class="swiper-slide">
 *           <a href="大图.jpg" data-lightbox="screenshots"><img src="大图.jpg" alt="<标题>截图1">
 *   图标：<div class="bgpic"><img src="…_APP.png">（实测只有 120×120，仅在没有截图时兜底当封面）
 *   下载：<div class="downBtn downbtn" id="2671839" type="1">
 *         静态 HTML 里没有下载地址（按钮是 href="javascript:;"），
 *         必须再请求 GET /downs/detail/<id>/<type> 才能拿到 and_url / ios_url / pc_url。
 *
 * ⚠️ 本函数是 async（模板原版是同步的），fetchGames() 里调用处记得 await。
 */
async function parsePost(html, url) {
  const meta = collectMeta(html);

  // ---- 标题 ----
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const name = cleanText(h1 ? h1[1] : '') || cleanText(meta['description'] || '');

  // ---- 正文 ----
  // 必须精确匹配 <div class="cont">。反例：
  //   /<div[^>]*class="[^"]*\bcont\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/section>/
  // 实测会吞到 16231 字符（一路匹配到后面的 </div></section>，把截图区、评论、排行全吃进来），
  // 精确匹配只有 802 字符，才是真正的正文。
  const cont = /<div\s+class=["']cont["'][^>]*>([\s\S]*?)<\/div>/i.exec(html);
  const contentHtml = cont ? cont[1] : '';
  const desc = htmlToText(contentHtml) || cleanText(meta['description'] || '');

  // ---- 图片：截图区（本站图片全写在 src，没有 data-src 懒加载）----
  const images = [];
  const imgRe = /<img[^>]+>/gi;
  let imgMatch;
  while ((imgMatch = imgRe.exec(html)) !== null) {
    const attrs = parseAttrs(imgMatch[0]);
    if (!/截图\d*$/.test(String(attrs.alt || ''))) continue; // 只认截图，滤掉站点 logo / 广告图
    const src = absoluteUrl(attrs['data-src'] || attrs['data-original'] || attrs.src, url);
    if (src && !images.includes(src)) images.push(src);
  }
  if (images.length === 0) {
    // 兜底：没有截图时用游戏图标，至少保证有封面
    const bg = /<div[^>]+class=["'][^"']*\bbgpic\b[^"']*["'][^>]*>[\s\S]*?<img[^>]+src=["']([^"']+)["']/i.exec(html);
    const icon = bg ? absoluteUrl(bg[1], url) : '';
    if (icon) images.push(icon);
  }

  // ---- 链接：正文里的（本站正文一般没有外链，留着以后站点改版用）----
  const links = [];
  const aRe = /<a[^>]+href=["']([^"']+)["']/gi;
  let aMatch;
  while ((aMatch = aRe.exec(contentHtml)) !== null) {
    const abs = absoluteUrl(aMatch[1], url);
    if (abs && !links.includes(abs)) links.push(abs);
  }

  // ---- 下载接口：本站唯一能拿到真实下载地址的地方 ----
  const btn = /<div[^>]+class=["'][^"']*\bdownbtn\b[^"']*["'][^>]*>/i.exec(html);
  const btnAttrs = btn ? parseAttrs(btn[0]) : {};
  if (btnAttrs.id && btnAttrs.type) {
    await sleep(API_INTERVAL); // 同一条内的第二个请求，放慢一点
    try {
      const data = await fetchJson(`${DOWNLOAD_API}/${btnAttrs.id}/${btnAttrs.type}`, url);
      if (data && data.code === 1 && data.data) {
        for (const one of [data.data.and_url, data.data.ios_url, data.data.pc_url]) {
          if (!one) continue; // ⚠️ 必须先跳过空值：absoluteUrl('', base) 会返回站点首页
          const abs = absoluteUrl(one, url);
          if (abs && !links.includes(abs)) links.push(abs);
        }
      }
    } catch (err) {
      // 下载接口失败不影响这条入库，只是少几条下载链接
      console.warn(`[galgame/${SITE_NAME}]   ⚠️ 下载接口失败（id=${btnAttrs.id}）：${errorText(err)}`);
    }
  }

  return { name, desc, images, links };
}

// ==================== 入口（fetch.mjs 通过聚合器调用） ====================
/**
 * @param {{ source?: string, date?: string, site?: string, galgameDir?: string }} options
 * @returns {Promise<Array<object>>} 统一格式数组：id / source / name / desc / images / links / url / fetched_at
 */
export async function fetchGames(options = {}) {
  if (!LIST_URL) {
    console.log(`[galgame/${SITE_NAME}] 本模板还没配置（LIST_URL 为空），本次跳过；按同目录 README.md 填上真实站点即可`);
    return [];
  }

  console.log(`[galgame/${SITE_NAME}] 列表页：${LIST_URL}`);
  const listHtml = await fetchHtml(LIST_URL);

  const postUrls = parseList(listHtml, LIST_URL);
  if (postUrls.length === 0) {
    console.log(`[galgame/${SITE_NAME}] 列表页没解析出帖子链接，按本站点结构调整 parseList()`);
    return [];
  }
  console.log(`[galgame/${SITE_NAME}] 解析到 ${postUrls.length} 个帖子，开始逐个抓取`);

  const fetchedAt = nowText();
  const items = [];

  for (let index = 0; index < postUrls.length; index += 1) {
    const url = postUrls[index];
    try {
      const html = await fetchHtml(url);
      const parsed = await parsePost(html, url); // 本站 parsePost 是 async（要额外请求下载接口）
      if (!parsed.name) throw new Error('没解析到标题（按本站点结构调整 parsePost()）');

      items.push({
        id: idFromUrl(url),
        source: `galgame/${SITE_NAME}`,
        name: parsed.name,
        desc: parsed.desc,
        images: parsed.images,
        links: parsed.links,
        url,
        fetched_at: fetchedAt,
      });

      console.log(
        `[galgame/${SITE_NAME}]   ✅ ${parsed.name}（图 ${parsed.images.length} 张 / 链接 ${parsed.links.length} 条）`,
      );
    } catch (err) {
      // 单个帖子失败只跳过
      console.warn(`[galgame/${SITE_NAME}]   ⚠️ ${url} 抓取失败，已跳过：${errorText(err)}`);
    }

    if (index < postUrls.length - 1) await sleep(REQUEST_INTERVAL); // 请求间隔 2 秒
  }

  console.log(`[galgame/${SITE_NAME}] 结束：成功 ${items.length} 个（共 ${postUrls.length} 个）`);
  return items;
}

