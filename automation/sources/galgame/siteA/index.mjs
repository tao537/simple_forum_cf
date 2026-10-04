/**
 * 子站点：siteA（模板 / 示例）
 *
 * 每个站点一个文件夹，因为每个站点的 HTML 结构都不一样，抓取逻辑没法通用。
 * 用法：把本文件夹复制成你的站点名（如 siteB/），改下面 3 个地方即可：
 *   1. 顶部 LIST_URL 改成该站点的列表页地址；
 *   2. parseList() 按该站点列表页结构，取出帖子详情页链接；
 *   3. parsePost() 按该站点帖子页结构，取出标题、正文、图片、链接。
 *
 * LIST_URL 还空着时，本模板会直接打印一行提示并返回空数组，不会发任何请求，
 * 所以放在这里不会影响 node fetch.mjs galgame 的正常运行。
 */
import { createHash } from 'node:crypto';

// ==================== 站点配置（改这里） ====================
const SITE_NAME = 'siteA';                       // 与文件夹名保持一致
const LIST_URL = '';                             // ← 例：'https://example-galgame-site.com/new'
const MAX_POSTS = 10;                            // 单次最多抓几个帖子
const REQUEST_INTERVAL = 2000;                   // 每次请求之间的间隔（毫秒）
const REQUEST_TIMEOUT = 20000;                   // 单次请求超时（毫秒）
const USER_AGENT = 'Mozilla/5.0 (compatible; kuhai-automation/1.0)';

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

// ==================== 页面解析（按站点结构改这里） ====================
/**
 * 列表页 → 帖子详情页链接数组。
 * 默认规则：挑页面里"看起来像帖子页"的 <a href>；换成真实站点后，按它的 URL 特征调整正则。
 */
function parseList(html, baseUrl) {
  const links = [];
  const re = /<a[^>]+href=["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const abs = absoluteUrl(match[1], baseUrl);
    if (!abs) continue;
    // ↓↓ 按站点特征调整（示例：详情页形如 /12345.html 或 /thread/xxx）
    if (!/(\/\d+\.html$|\/thread\/|\/post\/|\/article\/|\/game\/)/i.test(abs)) continue;
    if (!links.includes(abs)) links.push(abs);
  }
  return links.slice(0, MAX_POSTS);
}

/**
 * 帖子页 → { name, desc, images, links }。
 * 默认规则：标题取 og:title / <title>；正文取 <article> 或 <div id="content"> 或 og:description；
 * 图片取正文里的 <img>（含 data-src 懒加载）；链接取正文里的所有 <a href>。
 */
function parsePost(html, url) {
  const meta = collectMeta(html);
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const name = cleanText(meta['og:title'] || meta['twitter:title'] || (titleTag ? titleTag[1] : ''));

  // 正文容器：按站点调整这几个选择器
  const contentMatch =
    /<article[^>]*>([\s\S]*?)<\/article>/i.exec(html) ||
    /<div[^>]+id=["']content["'][^>]*>([\s\S]*?)<\/div>/i.exec(html) ||
    /<div[^>]+class=["'][^"']*\b(post-content|article-content|entry-content)\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(
      html,
    );
  const contentHtml = contentMatch ? contentMatch[contentMatch.length - 1] : '';
  const desc = htmlToText(contentHtml) || cleanText(meta['og:description'] || meta['description'] || '');

  // 图片：正文里的 <img src> 与 data-src / data-original（懒加载）；正文为空时退回 og:image
  const images = [];
  const imgRe = /<img[^>]+>/gi;
  let imgMatch;
  while ((imgMatch = imgRe.exec(contentHtml || html)) !== null) {
    const attrs = parseAttrs(imgMatch[0]);
    const src = absoluteUrl(attrs['data-src'] || attrs['data-original'] || attrs.src, url);
    if (src && !images.includes(src)) images.push(src);
  }
  const ogImage = absoluteUrl(meta['og:image'] || '', url);
  if (images.length === 0 && ogImage) images.push(ogImage);

  // 链接：正文里出现的所有 http(s) 链接（网盘、论坛、官网…都收，不做类型判断）
  const links = [];
  const scope = contentHtml || html;
  const aRe = /<a[^>]+href=["']([^"']+)["']/gi;
  let aMatch;
  while ((aMatch = aRe.exec(scope)) !== null) {
    const abs = absoluteUrl(aMatch[1], url);
    if (abs && !links.includes(abs)) links.push(abs);
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
      const parsed = parsePost(html, url);
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

