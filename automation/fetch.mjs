#!/usr/bin/env node
/**
 * 苦海 · 游戏发布流水线 —— 抓取入口
 *
 * 用法：
 *   node fetch.mjs list                        列出所有已注册来源
 *   node fetch.mjs steam                       抓取 Steam 免费游戏（用今天日期）
 *   node fetch.mjs steam --date 2026-10-03     指定输出文件名里的日期
 *   node fetch.mjs galgame                     抓取 sources/galgame/sites.txt 里的网站
 *   node fetch.mjs steam --no-proxy            本次完全直连
 *   node fetch.mjs steam --proxy http://127.0.0.1:7890
 *
 * 设计要点：
 *   1. sources/ 下每个「含 index.mjs 的子目录」就是一个来源，不硬编码任何来源名；
 *   2. 动态 import 该来源的 index.mjs，取其中的 fetchGames 函数调用；
 *   3. 输出到 candidates/<来源名>-YYYY-MM-DD.json，已存在则按 id 去重后追加；
 *   4. 任何异常立即报错并以退出码 1 结束，不做静默重试。
 *
 * 依赖：仅 Node 内置模块（fs / path / url），无需 npm install，Node 18+。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ==================== 路径常量（全部锚定 automation/，在哪个目录执行都一样） ====================
const AUTOMATION_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCES_DIR = join(AUTOMATION_DIR, 'sources');
const CANDIDATES_DIR = join(AUTOMATION_DIR, 'candidates');
const CONFIG_FILE = join(AUTOMATION_DIR, 'config.json');

// 本机系统代理（GNOME 网络设置里就是 127.0.0.1:7890，http/https 同一个端口），
// 可用 --proxy <url> / --no-proxy 单次覆盖；长期改端口请写 config.json 的 network.proxy
const DEFAULT_PROXY = 'http://127.0.0.1:7890';

// 统一数据格式的必需字段：来源返回的每条数据都必须齐全
const REQUIRED_FIELDS = ['id', 'source', 'name', 'desc', 'url', 'cover', 'tags', 'fetched_at'];

const HELP_TEXT = `
苦海 · 游戏发布流水线 —— 抓取入口

用法：
  node fetch.mjs list                        列出所有已注册来源
  node fetch.mjs <来源名>                    抓取该来源（输出到 candidates/）
  node fetch.mjs <来源名> --date YYYY-MM-DD  指定输出文件名里的日期

可选参数：
  --proxy <url>   本次指定代理（默认读 config.json 的 network.proxy，再默认 ${DEFAULT_PROXY}）
  --no-proxy      本次完全直连
  -h, --help      显示本帮助

示例：
  node fetch.mjs steam
  node fetch.mjs steam --date 2026-10-03
  node fetch.mjs galgame

新增来源：在 sources/ 下新建 <名字>/index.mjs，导出 async function fetchGames(options)，
即可直接用 node fetch.mjs <名字> 调用，无需修改本文件。
`.trim();

// ==================== 基础工具 ====================
function fail(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

/** 把错误（含 undici 的底层 cause 码，如 UND_ERR_CONNECT_TIMEOUT / ECONNRESET）拼成可诊断的一行 */
function errorText(err) {
  if (!err) return String(err);
  const code = err.cause && err.cause.code ? `（${err.cause.code}）` : '';
  return `${err.message || err}${code}`;
}

function todayText() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// ==================== 参数解析 ====================
function parseArgs(argv) {
  const args = { target: '', date: '', proxy: '', noProxy: false, help: false };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '-h' || token === '--help') {
      args.help = true;
      continue;
    }
    if (token === '--no-proxy') {
      args.noProxy = true;
      continue;
    }
    if (token === '--date' || token === '--proxy') {
      const value = argv[i + 1];
      if (!value) {
        fail(`${token} 需要一个值，例如：${token} ${token === '--date' ? '2026-10-03' : 'http://127.0.0.1:7890'}`);
      }
      i += 1;
      if (token === '--date') {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`--date 需要 YYYY-MM-DD 格式，收到：${value}`);
        args.date = value;
      } else {
        args.proxy = value;
      }
      continue;
    }
    if (token.startsWith('-')) fail(`未知参数：${token}\n\n${HELP_TEXT}`);
    positional.push(token);
  }

  if (positional.length > 1) fail(`一次只能抓取一个来源，收到了多个：${positional.join(' ')}`);
  args.target = positional[0] || '';
  return args;
}

// ==================== 配置与代理 ====================
function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    fail(`config.json 解析失败：${err.message}`);
  }
}

/**
 * 让 Node 内置 fetch 走本地代理。
 * Node 默认忽略 HTTP(S)_PROXY 环境变量，必须打开 NODE_USE_ENV_PROXY；
 * 这里在发出任何请求之前替 sources/ 里的来源设好，来源自身无需关心网络。
 * 优先级：--proxy > config.json 的 network.proxy > 内置默认值
 * 注意：刻意不继承 shell 里的 HTTPS_PROXY（本机那条 7892 不稳定，实测会 fetch failed），
 *       要临时换代理请用 --proxy，要完全直连请用 --no-proxy。
 */
function applyProxy(args, config) {
  if (args.noProxy) {
    console.log('🌐 网络：直连（--no-proxy）');
    return;
  }

  const proxy = args.proxy || (config.network && config.network.proxy) || DEFAULT_PROXY;

  process.env.NODE_USE_ENV_PROXY = '1';
  process.env.HTTP_PROXY = proxy;
  process.env.HTTPS_PROXY = proxy;
  process.env.http_proxy = proxy;
  process.env.https_proxy = proxy;
  process.env.NO_PROXY = 'localhost,127.0.0.1,::1';
  process.env.no_proxy = 'localhost,127.0.0.1,::1';

  console.log(`🌐 网络：走代理 ${proxy}`);
}

// ==================== 来源扫描 ====================
function listSources() {
  if (!existsSync(SOURCES_DIR)) {
    fail(`找不到来源目录：${SOURCES_DIR}\n   请在 automation/ 下新建 sources/<来源名>/index.mjs`);
  }

  return readdirSync(SOURCES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => {
      const entryFile = join(SOURCES_DIR, entry.name, 'index.mjs');
      return { name: entry.name, entry: entryFile, valid: existsSync(entryFile) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function printSources(sources) {
  if (sources.length === 0) {
    console.log('📭 还没有任何来源。在 sources/ 下新建 <来源名>/index.mjs 即可注册一个来源。');
    return;
  }

  console.log(`📚 已注册来源（共 ${sources.length} 个，目录：${SOURCES_DIR}）\n`);
  for (const source of sources) {
    console.log(`  ${source.valid ? '✅' : '⚠️ '} ${source.name}${source.valid ? '' : '（缺少 index.mjs，无法使用）'}`);
  }

  const first = sources.find((source) => source.valid);
  console.log(`\n用法：node fetch.mjs <来源名>${first ? `      例如：node fetch.mjs ${first.name}` : ''}`);
}
// ==================== 数据校验（统一格式的守门人） ====================
function validateItems(items, sourceName) {
  if (!Array.isArray(items)) {
    fail(`来源「${sourceName}」的 fetchGames 必须返回数组，实际返回：${typeof items}`);
  }

  const seen = new Set();
  items.forEach((item, index) => {
    const at = `来源「${sourceName}」第 ${index + 1} 条数据`;

    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      fail(`${at} 不是对象：${JSON.stringify(item)}`);
    }
    for (const field of REQUIRED_FIELDS) {
      if (!(field in item)) {
        fail(`${at} 缺少必需字段 ${field}（统一数据格式：${REQUIRED_FIELDS.join(' / ')}）`);
      }
    }
    if (typeof item.id !== 'string' || !item.id.trim()) fail(`${at} 的 id 必须是非空字符串`);
    if (!item.id.startsWith(`${sourceName}-`)) {
      fail(`${at} 的 id「${item.id}」前缀必须是「${sourceName}-」`);
    }
    if (item.source !== sourceName) {
      fail(`${at} 的 source 必须是「${sourceName}」，实际是「${item.source}」`);
    }
    if (typeof item.name !== 'string' || !item.name.trim()) fail(`${at} 的 name 不能为空`);
    if (typeof item.desc !== 'string') fail(`${at} 的 desc 必须是字符串`);
    if (typeof item.url !== 'string' || !/^https?:\/\//.test(item.url)) {
      fail(`${at} 的 url 必须是 http(s) 链接，实际：${item.url}`);
    }
    if (typeof item.cover !== 'string') fail(`${at} 的 cover 必须是字符串（没有封面就填空字符串 ''）`);
    if (!Array.isArray(item.tags)) fail(`${at} 的 tags 必须是数组`);
    if (seen.has(item.id)) fail(`${at} 的 id「${item.id}」在本次结果里重复`);
    seen.add(item.id);
  });
}

/**
 * 软警告用：这条数据有没有图。
 * galgame 看 images 数组，steam 看 cover 字段；两者都没有才算「无图」（空串 / 空数组 / 缺字段都算没图）。
 * 注意：只用于统计与提醒，不影响任何校验或写入。
 */
function hasNoImage(item) {
  const hasImages = Array.isArray(item.images) && item.images.length > 0;
  return !hasImages && !item.cover;
}

// ==================== 去重合并 ====================
function mergeById(existing, incoming) {
  const merged = [];
  const seen = new Set();

  for (const item of existing) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }

  let added = 0;
  let duplicated = 0;
  const addedItems = [];
  for (const item of incoming) {
    if (seen.has(item.id)) {
      duplicated += 1;
      continue;
    }
    seen.add(item.id);
    merged.push(item);
    addedItems.push(item);
    added += 1;
  }

  return { merged, added, duplicated, addedItems };
}
// ==================== 主流程 ====================
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  const config = loadConfig();
  const sources = listSources();

  // 无来源名，或显式 list：列出所有来源
  if (!args.target || args.target === 'list') {
    printSources(sources);
    return;
  }

  const source = sources.find((item) => item.name === args.target);
  const available = sources.filter((item) => item.valid).map((item) => item.name);
  if (!source) {
    fail(
      `来源「${args.target}」不存在。\n   可用来源：${available.length ? available.join('、') : '(无)'}\n   查看全部来源：node fetch.mjs list`,
    );
  }
  if (!source.valid) fail(`来源「${source.name}」缺少 index.mjs：${source.entry}`);

  applyProxy(args, config);

  const date = args.date || todayText();
  const outFile = join(CANDIDATES_DIR, `${source.name}-${date}.json`);

  console.log(`🚀 开始抓取来源：${source.name}`);
  console.log(`📅 输出文件：${outFile}`);
  const startedAt = Date.now();

  // 动态加载来源模块（新增来源不用改本文件）
  const mod = await import(pathToFileURL(source.entry).href);
  if (typeof mod.fetchGames !== 'function') {
    fail(
      `来源「${source.name}」的 index.mjs 没有导出 fetchGames 函数\n   正确写法：export async function fetchGames(options) { ... }`,
    );
  }

  const items = await mod.fetchGames({
    source: source.name,
    date,
    automationDir: AUTOMATION_DIR,
    candidatesDir: CANDIDATES_DIR,
  });

  validateItems(items, source.name);

  if (items.length === 0) {
    console.log('\n⚠️ 本次没有抓到任何数据，未写入文件（candidates/ 原有内容保持不动）');
    return;
  }

  if (!existsSync(CANDIDATES_DIR)) mkdirSync(CANDIDATES_DIR, { recursive: true });

  let existing = [];
  if (existsSync(outFile)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(outFile, 'utf8'));
    } catch (err) {
      fail(`已有文件不是合法 JSON：${outFile}\n   ${err.message}`);
    }
    if (!Array.isArray(parsed)) fail(`已有文件内容不是数组：${outFile}`);
    existing = parsed;
    console.log(`📄 已存在 ${basename(outFile)}（${existing.length} 条），按 id 去重后追加`);
  }

  const { merged, added, duplicated, addedItems } = mergeById(existing, items);
  writeFileSync(outFile, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

  console.log(`\n✅ 抓取完成：来源返回 ${items.length} 条，新增 ${added} 条，跳过重复 ${duplicated} 条，文件共 ${merged.length} 条`);
  console.log(`📊 本次入库 ${added} 条，其中无图 ${addedItems.filter(hasNoImage).length} 条（建议人工复核）`);
  console.log(`📁 ${outFile}`);
  console.log(`⏱️ 耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)} 秒`);
}

main().catch((err) => {
  fail(
    `抓取失败：${errorText(err)}\n   排查建议：网络不通可试 --no-proxy 或 --proxy <url>；接口变动请看 sources/<来源名>/README.md`,
  );
});
