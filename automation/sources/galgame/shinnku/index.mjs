/**
 * 子站点：shinnku（真红小站）
 *
 * 站点：https://www.shinnku.com （开源：github.com/shinnku-nikaidou/shinnku-com，
 *       Next.js 前端 + Rust/Axum 后端 + Backblaze B2 文件存储）
 *
 * 站点模型：游戏 = 存储里的一个压缩包。目录树：
 *   /files/shinnku/zd        熟肉 PC（内含 0001-0500 … 编号分段文件夹，约 2400 个）
 *   /files/shinnku/0/win     熟肉 PC（旧 win 区，文件直铺 + 少量子文件夹）
 *   /files/shinnku/0/apk     安卓 APK（文件直铺）
 *   /files/shinnku/0/ons     ONS 游戏（默认不扫）
 *   /files/shinnku/0/krkr    KRKR 游戏（默认不扫）
 *
 * 抓取流程（本站与 youxiniao / kungal 都不同）：
 *   1. 带请求头 `RSC: 1` 请求目录页 → 返回 Next.js App Router 的 RSC 飞行数据，
 *      里面嵌着后端目录 JSON 的完整 props：每个文件一个自包含对象
 *      {"type":"file","name":…,"info":{"file_path":…,"upload_timestamp":…,"file_size":…}}
 *      → 正则整块抠出来 JSON.parse 即可，不用碰 DOM。
 *   2. 全部分区合并，按 upload_timestamp 倒序取前 N 个 = 最新发布的游戏。
 *   3. 简介：站点公开接口 /api/aiintro?name=<游戏名>（站方 AI 生成简中简介，
 *      Redis 缓存）；拿不到再退 /api/wiki?name=<游戏名>（繁中维基文本，截断）。
 *
 * ⚠️ 本站关键差异（改错就抓不到东西）：
 *   1. 下载链接是 **公开直链**（Backblaze B2）：https://zd.shinnku.top/file/shinnku/<file_path>
 *      —— 无需登录、无需提取码；路径每段要 encodeURIComponent。
 *   2. 后端目录 API（:2999 /files/**）不公开，只能靠 RSC 飞行数据（见 1）。
 *   3. 文件名即游戏名（带 [日期][社团] 前缀和 .rar/.7z/.apk 后缀），要清洗。
 *   4. 无封面（aiintro 返回的 bg 是前端没在用的死字段）→ cover 留空，
 *      封面由人工在 queue 清单的 screenshots 里补。
 */
import { createHash } from 'node:crypto';

// ==================== 站点配置（改这里） ====================
const SITE_NAME = 'shinnku';                              // 与文件夹名保持一致
const SITE_ORIGIN = 'https://www.shinnku.com';
const DL_BASE = 'https://zd.shinnku.top/file/shinnku/';   // B2 公开直链（无提取码）
const AI_INTRO_API = `${SITE_ORIGIN}/api/aiintro`;        // 站方 AI 简介（简中）
const WIKI_API = `${SITE_ORIGIN}/api/wiki`;               // 维基简介（繁中，兜底）

// 要扫描的分区（路径相对 /files/shinnku/）。加 ONS/KRKR 在这里补一行即可。
const SECTIONS = [
  { path: 'zd', tag: '熟肉' },     // 熟肉 PC 新区（编号分段文件夹，会自动下钻一层）
  { path: '0/win', tag: '熟肉' },  // 熟肉 PC 旧区
  { path: '0/apk', tag: '安卓' },  // 安卓 APK
];
const MAX_POSTS = 10;               // 单次最多抓几个游戏
const REQUEST_INTERVAL = 2000;      // 每次请求之间的间隔（毫秒）
const REQUEST_TIMEOUT = 30000;      // 单次请求超时（aiintro 背后是 AI 服务，放宽点）
const INTRO_MAX_CHARS = 900;        // 简介截断长度（维基全文很长）

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

/** 文件路径 → 稳定唯一 id（同一路径永远同一个 id，重复抓取时 fetch.mjs 会自动去重） */
function idFor(filePath) {
  return `galgame-${SITE_NAME}-${createHash('sha256').update(filePath).digest('hex').slice(0, 12)}`;
}

// ==================== 通用工具（一般不用改） ====================
function decodeEntities(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function num2size(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(0)} KB`;
}

function tsToDate(ms) {
  const d = new Date(Number(ms));
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 抓一个页面（RSC 飞行数据 / JSON 接口通用） */
async function fetchText(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; kuhai-automation/1.0)',
      Accept: 'text/x-component, application/json, text/html',
      ...headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ==================== RSC 飞行数据解析 ====================
/**
 * RSC 数据里每个文件条目是一段自包含 JSON（实测 2026-10-07）：
 *   {"type":"file","name":"…","info":{"file_path":"…","upload_timestamp":1734641779424,"file_size":808619869}}
 * 引号内可能出现 \" 转义，所以字符类写成 (?:[^"\\]|\\.)*。
 */
const FILE_RE =
  /\{"type":"file","name":"((?:[^"\\]|\\.)*)","info":\{"file_path":"((?:[^"\\]|\\.)*)","upload_timestamp":(\d+),"file_size":(\d+)\}\}/g;
const FOLDER_RE = /\{"type":"folder","name":"((?:[^"\\]|\\.)*)"\}/g;

function extractFiles(rscText) {
  const out = [];
  let m;
  FILE_RE.lastIndex = 0;
  while ((m = FILE_RE.exec(rscText)) !== null) {
    let name;
    let filePath;
    try {
      name = JSON.parse(`"${m[1]}"`);
      filePath = JSON.parse(`"${m[2]}"`);
    } catch {
      continue; // 转义异常的条目跳过
    }
    out.push({
      name: decodeEntities(name),
      filePath: decodeEntities(filePath),
      uploadTimestamp: Number(m[3]),
      fileSize: Number(m[4]),
    });
  }
  return out;
}

function extractFolders(rscText) {
  const out = [];
  let m;
  FOLDER_RE.lastIndex = 0;
  while ((m = FOLDER_RE.exec(rscText)) !== null) {
    try {
      out.push(decodeEntities(JSON.parse(`"${m[1]}"`)));
    } catch {
      /* 跳过 */
    }
  }
  return out;
}

// ==================== 名字清洗 / 链接拼接 ====================
/** 文件名 → 游戏名：去扩展名、去结尾的 (files)/(crack) 标记；[日期][社团] 前缀保留（复核有用） */
function fileNameToGameName(fileName) {
  return fileName
    .replace(/\.(rar|zip|7z|apk|exe)$/i, '')
    .replace(/\s*\((?:files|crack)\)\s*$/i, '')
    .trim();
}

/** 下载直链：每段 encodeURIComponent（实测 B2 按 %XX 接收，+ 号也接受） */
function downloadUrlFor(filePath) {
  return DL_BASE + filePath.split('/').map(encodeURIComponent).join('/');
}

/** 站内页面地址（人复核时点开用） */
function pageUrlFor(filePath) {
  return `${SITE_ORIGIN}/files/shinnku/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

// ==================== 简介抓取 ====================
/** 站方 AI 简介（简中）→ { title, text } 或 null */
async function fetchAiIntro(gameName) {
  const raw = await fetchText(`${AI_INTRO_API}?name=${encodeURIComponent(gameName)}`);
  const data = JSON.parse(raw);
  if (!data || typeof data.text !== 'string' || !data.text.trim()) return null;
  if (data.text.includes('No results found.')) return null;
  return { title: String(data.title || '').trim(), text: data.text.trim() };
}

/** 维基简介（繁中，兜底）→ 字符串或 null */
async function fetchWikiIntro(gameName) {
  const raw = await fetchText(`${WIKI_API}?name=${encodeURIComponent(gameName)}`);
  const data = JSON.parse(raw);
  if (!data || typeof data.text !== 'string' || !data.text.trim()) return null;
  let text = data.text;
  const cut = text.indexOf('== 參考');
  if (cut !== -1) text = text.slice(0, cut); // 去掉参考资料之后的尾巴
  text = text.replace(/^(={2,})\s*(.*?)\s*(={2,})$/gm, '【$2】').trim(); // 标题转【】
  return text.slice(0, INTRO_MAX_CHARS);
}

// ==================== 入口（fetch.mjs 通过聚合器调用） ====================
/**
 * @param {{ limit?: number }} options  limit 用于小批量试跑（覆盖 MAX_POSTS）
 * @returns {Promise<Array<object>>} 统一格式数组
 */
export async function fetchGames(options = {}) {
  const limit = Math.max(1, Math.min(MAX_POSTS, Number(options.limit) || MAX_POSTS));

  // ---- 1. 扫描全部分区，收集文件条目 ----
  const all = [];
  const seenPaths = new Set();
  for (const section of SECTIONS) {
    const base = `${SITE_ORIGIN}/files/shinnku/${section.path.split('/').map(encodeURIComponent).join('/')}`;
    console.log(`[galgame/${SITE_NAME}] 扫描分区：${section.path}（${section.tag}）`);
    let files = [];
    try {
      files = extractFiles(await fetchText(base, { RSC: '1' }));
    } catch (err) {
      console.warn(`[galgame/${SITE_NAME}]   ⚠️ 分区 ${section.path} 抓取失败，已跳过：${errorText(err)}`);
      continue;
    }

    // 顶层一个文件都没有（如 zd 的编号分段结构）→ 下钻一层文件夹
    if (files.length === 0) {
      let folders = [];
      try {
        folders = extractFolders(await fetchText(base, { RSC: '1' }));
      } catch (err) {
        console.warn(`[galgame/${SITE_NAME}]   ⚠️ 分区 ${section.path} 目录解析失败：${errorText(err)}`);
      }
      for (const folder of folders) {
        if (folder.startsWith('.')) continue;
        await sleep(REQUEST_INTERVAL);
        try {
          const sub = extractFiles(
            await fetchText(`${base}/${encodeURIComponent(folder)}`, { RSC: '1' }),
          );
          console.log(`[galgame/${SITE_NAME}]   └ ${folder}：${sub.length} 个文件`);
          files.push(...sub);
        } catch (err) {
          console.warn(`[galgame/${SITE_NAME}]   ⚠️ 子目录 ${folder} 失败，已跳过：${errorText(err)}`);
        }
      }
    } else {
      console.log(`[galgame/${SITE_NAME}]   顶层 ${files.length} 个文件（子文件夹不展开）`);
    }

    for (const f of files) {
      if (seenPaths.has(f.filePath)) continue;
      seenPaths.add(f.filePath);
      all.push({ ...f, sectionTag: section.tag });
    }
    if (SECTIONS.indexOf(section) < SECTIONS.length - 1) await sleep(REQUEST_INTERVAL);
  }

  if (all.length === 0) {
    console.log(`[galgame/${SITE_NAME}] 没解析到任何文件（站点改版？），按 extractFiles() 检查`);
    return [];
  }

  // ---- 2. 按上传时间倒序取前 N 个 ----
  all.sort((a, b) => b.uploadTimestamp - a.uploadTimestamp);
  const picked = all.slice(0, limit);
  console.log(
    `[galgame/${SITE_NAME}] 共 ${all.length} 个文件，取最新 ${picked.length} 个（${tsToDate(picked[0].uploadTimestamp)} ~ ${tsToDate(picked[picked.length - 1].uploadTimestamp)}），开始抓简介`,
  );

  const fetchedAt = nowText();
  const results = [];

  for (let index = 0; index < picked.length; index += 1) {
    const item = picked[index];
    try {
      const gameName = fileNameToGameName(item.name);

      // ---- 3. 简介：aiintro 优先，wiki 兜底（失败不影响入库） ----
      let intro = '';
      try {
        const ai = await fetchAiIntro(gameName);
        if (ai) {
          intro = ai.text;
          // 站方 AI 按「名字」模糊匹配，偶尔配错游戏 → 标题对不上时给复核的人提个醒
          if (ai.title && !gameName.includes(ai.title) && !ai.title.includes(gameName)) {
            intro = `⚠️ 站方 AI 按名字匹配到《${ai.title}》，请核对是否同一部作品：\n${intro}`;
          }
        }
      } catch (err) {
        console.warn(`[galgame/${SITE_NAME}]   ⚠️ aiintro 失败：${errorText(err)}`);
      }
      if (!intro) {
        try {
          intro = (await fetchWikiIntro(gameName)) || '';
        } catch (err) {
          console.warn(`[galgame/${SITE_NAME}]   ⚠️ wiki 简介失败：${errorText(err)}`);
        }
      }

      const head = `类型：${item.sectionTag}｜大小：${num2size(item.fileSize)}｜上传：${tsToDate(item.uploadTimestamp)}`;
      const desc = intro ? `${head}\n\n${intro}` : head;

      results.push({
        id: idFor(item.filePath),
        source: `galgame/${SITE_NAME}`,
        name: gameName,
        desc,
        images: [], // 本站无封面；发布截图由人工在 queue 清单里补
        links: [downloadUrlFor(item.filePath)], // B2 公开直链，无需提取码
        url: pageUrlFor(item.filePath),
        tags: ['galgame', item.sectionTag],
        fetched_at: fetchedAt,
      });

      console.log(`[galgame/${SITE_NAME}]   ✅ ${gameName}（${num2size(item.fileSize)}）`);
    } catch (err) {
      console.warn(`[galgame/${SITE_NAME}]   ⚠️ ${item.filePath} 组装失败，已跳过：${errorText(err)}`);
    }

    if (index < picked.length - 1) await sleep(REQUEST_INTERVAL);
  }

  console.log(`[galgame/${SITE_NAME}] 结束：成功 ${results.length} 个（共 ${picked.length} 个）`);
  return results;
}
