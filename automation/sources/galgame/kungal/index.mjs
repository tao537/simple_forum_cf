/**
 * 子站点：kungal（鲲 Galgame 论坛）
 *
 * 站点：https://www.kungal.com/galgame
 * 抓取流程（与 youxiniao 的「列表页→详情页」不同，本站走 RSS 更省请求）：
 *   1. 全站资源 RSS：https://www.kungal.com/rss/galgame.xml（公开、免登录，最新 50 条）
 *      每条 = 一个「资源」：<title>【游戏本体】游戏名 · 版本</title>、
 *      <description>语言/平台/大小</description>、<enclosure>封面图</enclosure>。
 *   2. 资源页 /galgame/resource/<rid>（SSR，公开）：
 *      真实下载链接不在可见正文里，而在页面 __NUXT_DATA__（devalue 扁平 JSON）的
 *      resource.dlsite.purchase_url 字段；正文（解压说明/提取码）是 tiptap 文档，
 *      也在同一 payload 里。游戏 id / 游戏名 / 大小 / 网盘名都从这里取。
 *   3. 游戏页 /galgame/<gid>（SSR，公开）：og:description = 游戏简介。
 *
 * ⚠️ 本站关键差异（改错就抓不到东西）：
 *   1. 站点 API（/api/**）一律要求登录（401 用户登录失效）→ 全程只走 RSS + SSR 页面；
 *   2. 下载链接是 s.imoe.uk 之类的中转短链，真正的网盘地址要点击后跳转；
 *   3. 资源页可见正文里只有「解压工具链接」这类杂项，必须从 payload 里拿 purchase_url；
 *   4. 需要 UTF-8，无 gbk 问题；无 Referer 防盗链（封面是 kungal 自己的图床）。
 */
import { createHash } from 'node:crypto';

// ==================== 站点配置（改这里） ====================
const SITE_NAME = 'kungal';                                   // 与文件夹名保持一致
const RSS_URL = 'https://www.kungal.com/rss/galgame.xml';     // 全站最新资源 RSS（50 条，免登录）
const SITE_ORIGIN = 'https://www.kungal.com';
const RESOURCE_URL = `${SITE_ORIGIN}/galgame/resource`;       // /galgame/resource/<rid>
const GAME_URL = `${SITE_ORIGIN}/galgame`;                    // /galgame/<gid>
const ONLY_CATEGORY = '游戏本体';                              // RSS 里还有补丁/汉化等，只发游戏本体（空串 = 不过滤）
const MAX_POSTS = 10;                                         // 单次最多抓几个资源
const REQUEST_INTERVAL = 2000;                                // 每次请求之间的间隔（毫秒）
const REQUEST_TIMEOUT = 20000;                                // 单次请求超时（毫秒）
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

/** 资源页 URL → 稳定唯一 id（含资源 id，同一资源永远同一个 id，重复抓取时 fetch.mjs 会自动去重） */
function idFor(rid) {
  return `galgame-${SITE_NAME}-r${rid}`;
}

// ==================== 通用工具（一般不用改） ====================
function decodeEntities(text) {
  return String(text === null || text === undefined ? '' : text)
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

/** 去掉所有标签，压成单行文本 */
function cleanText(text) {
  return decodeEntities(String(text || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
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

/** 抓一个页面并解码成字符串（Node 内置 fetch，无依赖） */
async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml,application/rss+xml',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString('utf8');
}

// ==================== devalue 解析（__NUXT_DATA__ 扁平 JSON） ====================
/**
 * Nuxt 的 __NUXT_DATA__ 是 devalue 扁平数组：字符串/数字直接存，
 * 对象存成 {键: 值所在下标}，数组存成 [下标, ...]。
 * 这里只按「键路径」取值、按 children/value 走文档树，不整体还原，
 * 天然避开循环引用。
 */

/** 按 keys 路径逐层取下标，返回「最终下标」（-1 = 路径断了） */
function dvIndex(data, start, keys) {
  let i = start;
  for (const key of keys) {
    const node = data[i];
    if (!node || typeof node !== 'object' || Array.isArray(node)) return -1;
    const next = node[key];
    if (!Number.isInteger(next)) return -1;
    i = next;
  }
  return i;
}

/** 按 keys 路径取值（返回最终下标处的元素，不是下标本身） */
function dvGet(data, start, keys) {
  const i = dvIndex(data, start, keys);
  return i >= 0 ? data[i] : undefined;
}

/** 字符串数组：["百度网盘"] 存成 [下标,...]，展开成真字符串数组 */
function dvStringList(data, value) {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((x) => typeof data[x] === 'string').map((x) => data[x]);
}

/** tiptap 文档树 → { text 纯文本, linkUrls 链接节点里的 URL }（只走 children/value/url，天然无环） */
function tiptapCollect(data, start) {
  const texts = [];
  const linkUrls = [];
  const walk = (i, depth) => {
    if (depth > 30) return;
    const node = data[i];
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const x of node) if (Number.isInteger(x)) walk(x, depth + 1);
      return;
    }
    if (typeof node !== 'object') return; // 字符串/数字是类型名或标量，不收
    // 链接节点：{object: 'link', url: <下标>, children: ...}
    if (
      Number.isInteger(node.object) &&
      data[node.object] === 'link' &&
      Number.isInteger(node.url) &&
      typeof data[node.url] === 'string'
    ) {
      linkUrls.push(data[node.url]);
    }
    if (Number.isInteger(node.value) && typeof data[node.value] === 'string') texts.push(data[node.value]);
    if (Number.isInteger(node.children)) walk(node.children, depth + 1);
  };
  if (Number.isInteger(start)) walk(start, 0);
  return { text: texts.join('\n').replace(/\n{3,}/g, '\n\n').trim(), linkUrls };
}

/** 提取页面 __NUXT_DATA__，拿不到返回 null */
function parseNuxtPayload(html) {
  const m = /<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// ==================== RSS 解析 ====================
/** RSS item → { rid, url, cover, category, langText, platformText, sizeText, title, pubDate } */
function parseRss(xml) {
  const items = [];
  const blockRe = /<item>([\s\S]*?)<\/item>/gi;
  let block;
  while ((block = blockRe.exec(xml)) !== null) {
    const seg = block[1];
    const cdata = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i').exec(seg);
      return m ? cleanText(m[1]) : '';
    };
    const link = cdata('link');
    const ridMatch = /\/resource\/(\d+)/.exec(link);
    if (!ridMatch) continue;

    // 封面在 <enclosure url="..."> 里
    const enc = /<enclosure[^>]*url=["']([^"']+)["']/i.exec(seg);
    // <description>语言: ... | 平台: ... | 大小: ...</description>
    // ⚠️ 有的条目会把资源正文全文拼在描述尾部，字段值要额外在 ！/换行 处截断
    const descText = cdata('description') || '';
    const field = (label) => {
      const m = new RegExp(`${label}[：:]\\s*([^|！\\n]*)`).exec(descText);
      return m ? m[1].trim() : '';
    };

    items.push({
      rid: ridMatch[1],
      url: absoluteUrl(link, SITE_ORIGIN),
      cover: enc ? absoluteUrl(enc[1], SITE_ORIGIN) : '',
      category: cdata('category'),
      langText: field('语言'),
      platformText: field('平台'),
      sizeText: field('大小'),
      versionText: field('版本'),
      rssTitle: cdata('title'),
      pubDate: cdata('pubDate'),
    });
  }
  return items;
}

// ==================== 资源页 / 游戏页解析 ====================
/** 这些域名的链接不当「下载链接」收（站点自身 / 统计 / 图床 / 社交） */
const LINK_DOMAIN_BLACKLIST =
  /(kungal\.com|kungal\.org|kungal\.iloveren\.link|umami\.|bilibili\.com\/|space\.bilibili|twitter\.com|x\.com|t\.me\/|discord\.gg|qmqq\.im)/i;

/** 一个 galgame_resource 对象 → 扁平化字段（全部来自 __NUXT_DATA__） */
function readResource(data, resIdx) {
  const workIdx = dvIndex(data, resIdx, ['work']);
  const content = tiptapCollect(data, dvIndex(data, resIdx, ['content']));
  const purchaseUrl = dvGet(data, resIdx, ['dlsite', 'purchase_url']);
  return {
    rid: String(dvGet(data, resIdx, ['id']) ?? ''),
    gid: workIdx >= 0 ? String(dvGet(data, workIdx, ['id']) ?? '') : '',
    gameName: workIdx >= 0 ? cleanText(dvGet(data, workIdx, ['display_name'])) : '',
    version: cleanText(dvGet(data, resIdx, ['title'])),
    size: cleanText(dvGet(data, resIdx, ['size'])),
    providers: dvStringList(data, dvGet(data, resIdx, ['provider_names'])),
    isNsfw: workIdx >= 0 && dvGet(data, workIdx, ['is_nsfw']) === true,
    text: content.text,
    linkUrls: content.linkUrls,
    purchaseUrl: typeof purchaseUrl === 'string' && /^https?:\/\//i.test(purchaseUrl) ? purchaseUrl : '',
  };
}

/**
 * 资源页 → { main: 当前资源, links: 下载相关链接, usedFallback, siblingCount }。
 *
 * payload 里除了当前资源，还带着同游戏全部历史资源（实测 67994 页面有 19 个）。
 * 当前资源正文为空且没有 purchase_url 时（实测 Telegram 渠道资源就这样），
 * 退回用同游戏其它资源里的链接兜底——同一个游戏，对复核的人照样有用。
 */
function parseResourcePage(html, wantRid) {
  const data = parseNuxtPayload(html);
  if (!data) throw new Error('资源页没有 __NUXT_DATA__（站点改版或被拦截）');

  const all = [];
  for (let i = 0; i < data.length; i += 1) {
    const node = data[i];
    if (
      node &&
      typeof node === 'object' &&
      !Array.isArray(node) &&
      Number.isInteger(node.object) &&
      data[node.object] === 'galgame_resource'
    ) {
      all.push(readResource(data, i));
    }
  }
  if (all.length === 0) throw new Error('payload 里没找到 galgame_resource 对象');

  const main = all.find((r) => r.rid === String(wantRid)) || all[0];
  if (!main.gameName) throw new Error('没解析到游戏名（payload 结构变了）');

  const links = collectLinks(main.text, main.purchaseUrl, main.linkUrls);
  let usedFallback = false;
  if (links.length === 0) {
    usedFallback = true;
    const collected = [];
    for (const r of all) {
      if (r.rid === main.rid) continue;
      collected.push(...collectLinks(r.text, r.purchaseUrl, r.linkUrls));
    }
    for (const u of collected) if (!links.includes(u)) links.push(u);
  }

  return { main, links, usedFallback, siblingCount: all.length - 1 };
}

/** 游戏页 → 简介（og:description）+ 标题兜底（og:title） */
function parseGamePage(html) {
  const meta = {};
  const re = /<meta\s+([^>]+?)\/?>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const key = /(?:property|name)=["']([^"']+)["']/i.exec(attrs);
    const content = /content=["']([^"']*)["']/i.exec(attrs);
    if (key && content) meta[key[1].toLowerCase()] = content[1];
  }
  return {
    desc: decodeEntities(meta['og:description'] || '').trim(),
    title: cleanText(decodeEntities(meta['og:title'] || '')),
    cover: meta['og:image'] || '',
  };
}

/** 汇总一条资源的下载相关链接：purchase_url + 链接节点 + 正文文本里的裸 URL（站点自身/统计/图床丢弃） */
function collectLinks(text, primary, linkUrls = []) {
  const links = [];
  const push = (u) => {
    if (u && !LINK_DOMAIN_BLACKLIST.test(u) && !links.includes(u)) links.push(u);
  };
  push(primary);
  for (const u of linkUrls) push(u);
  const re = /https?:\/\/[^\s"'<>（）()【】，,；;]+/gi;
  let m;
  while ((m = re.exec(text)) !== null) push(m[0].replace(/[),.]+$/, ''));
  return links;
}

/** RSS 描述里的语言/平台 → 帖子 tags（保持克制，人复核时还能改） */
function buildTags(rssItem, resource) {
  const tags = new Set(['galgame']);
  const plat = `${rssItem.platformText || ''}`;
  if (/windows|电脑/i.test(plat)) tags.add('PC');
  if (/安卓|android/i.test(plat)) tags.add('Android');
  if (/mac/i.test(plat)) tags.add('Mac');
  if (/switch|ns\b/i.test(plat)) tags.add('Switch');
  const lang = (rssItem.langText || '').split(/[\/、，,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (lang[0]) tags.add(lang[0]); // 只收第一个语言，避免标签爆炸
  for (const p of resource.providers) tags.add(p);
  if (resource.isNsfw) tags.add('NSFW');
  return [...tags].slice(0, 8);
}

// ==================== 入口（fetch.mjs 通过聚合器调用） ====================
/**
 * @param {{ limit?: number }} options  limit 用于小批量试跑（覆盖 MAX_POSTS）
 * @returns {Promise<Array<object>>} 统一格式数组
 */
export async function fetchGames(options = {}) {
  const limit = Math.max(1, Math.min(MAX_POSTS, Number(options.limit) || MAX_POSTS));

  console.log(`[galgame/${SITE_NAME}] 资源 RSS：${RSS_URL}`);
  const xml = await fetchHtml(RSS_URL);
  let items = parseRss(xml);
  if (ONLY_CATEGORY) items = items.filter((it) => it.category === ONLY_CATEGORY);
  if (items.length === 0) {
    console.log(`[galgame/${SITE_NAME}] RSS 里没解析到资源（站点改版？），按 parseRss() 检查`);
    return [];
  }
  items = items.slice(0, limit);
  console.log(`[galgame/${SITE_NAME}] RSS 解析到 ${items.length} 个资源，开始逐个抓取`);

  const fetchedAt = nowText();
  const results = [];

  for (let index = 0; index < items.length; index += 1) {
    const rssItem = items[index];
    try {
      // ---- 1. 资源页：下载链接 / 游戏名 / 版本 / 正文 ----
      const resHtml = await fetchHtml(rssItem.url);
      const parsed = parseResourcePage(resHtml, rssItem.rid);
      const resource = parsed.main;

      // ---- 2. 游戏页：简介（失败不影响这条入库） ----
      let intro = '';
      if (resource.gid) {
        await sleep(REQUEST_INTERVAL); // 同一条内的第二个请求，放慢一点
        try {
          const gameHtml = await fetchHtml(`${GAME_URL}/${resource.gid}`);
          intro = parseGamePage(gameHtml).desc;
        } catch (err) {
          console.warn(`[galgame/${SITE_NAME}]   ⚠️ 游戏页简介抓取失败：${errorText(err)}`);
        }
      }

      // ---- 3. 组装 ----
      // 版本标签自带【】（如「【PC/盖世/Winlator】」），拼进名字前剥掉一层
      const versionLabel = resource.version.replace(/^【(.*)】$/u, '$1');
      const name = versionLabel ? `${resource.gameName}（${versionLabel}）` : resource.gameName;
      const headLines = [
        `资源：${[resource.version, resource.size, ...resource.providers].filter(Boolean).join(' · ')}`,
        `语言：${rssItem.langText || '未知'}｜平台：${rssItem.platformText || '未知'}`,
      ].filter((s) => s.length > 3);
      if (parsed.usedFallback) {
        headLines.push(
          '⚠️ 本资源的下载链接未在页面公开（多为 Telegram 渠道资源），下面的链接来自同游戏的其它资源，发布前务必点开核对',
        );
      }
      const desc = [headLines.join('\n'), intro, resource.text && `资源说明：\n${resource.text}`]
        .filter(Boolean)
        .join('\n\n');

      const cover = rssItem.cover || '';
      results.push({
        id: idFor(resource.rid || rssItem.rid),
        source: `galgame/${SITE_NAME}`,
        name,
        desc,
        images: cover ? [cover] : [],
        links: parsed.links,
        url: rssItem.url,
        tags: buildTags(rssItem, resource),
        fetched_at: fetchedAt,
      });

      console.log(
        `[galgame/${SITE_NAME}]   ✅ ${name}（链接 ${results[results.length - 1].links.length} 条 / ${rssItem.sizeText || '大小未知'}）`,
      );
    } catch (err) {
      console.warn(`[galgame/${SITE_NAME}]   ⚠️ ${rssItem.url} 抓取失败，已跳过：${errorText(err)}`);
    }

    if (index < items.length - 1) await sleep(REQUEST_INTERVAL); // 请求间隔 2 秒
  }

  console.log(`[galgame/${SITE_NAME}] 结束：成功 ${results.length} 个（共 ${items.length} 个）`);
  return results;
}
