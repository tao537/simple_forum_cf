# 来源：galgame —— 站点聚合器

一句话：`sources/galgame/` 是个「大文件夹」，**每个子文件夹 = 一个站点**，各自实现自己的抓取逻辑；
`index.mjs` 只负责扫描、调用、合并、去重。**新增站点不用改公共代码，也不用改 `fetch.mjs`。**

## 目录结构

```
sources/galgame/
├── index.mjs            # 聚合器：扫描子文件夹 → 调用各站点的 fetchGames() → 校验/合并/去重
├── README.md            # 本文件
├── siteA/               # 一个站点（当前是模板）
│   ├── index.mjs        # 该站点自己的抓取逻辑（LIST_URL 为空，不配置不发请求）
│   └── README.md        # 该站点怎么改
├── siteB/               # 以后新增的站点，长这样
└── sites.txt.example    # 老的「站点清单」写法，已废弃，仅留作参考
```

## 怎么新增一个站点

```bash
cd automation/sources/galgame
cp -r siteA siteB          # 1. 复制模板，文件夹名就是站点名
$EDITOR siteB/index.mjs    # 2. 改 SITE_NAME / LIST_URL / parseList() / parsePost()
cd ../.. && node fetch.mjs galgame   # 3. 跑（要联网加 ./run-with-proxy.sh）
```

规则只有 4 条：

1. 每个站点文件夹必须有 `index.mjs`，并且 `export async function fetchGames(options)`
2. 返回**数组**，每项格式见下面「输出格式」
3. 文件夹名就是数据里的 `site` 字段 —— **不要用 `.` 或 `_` 开头**（会被聚合器跳过，`_template/` 这类可以拿来放模板）
4. 站点的抓取失败 / 没配置 / 格式不合法 → 只打印 ⚠️ 跳过它，其它站点照常跑

## 输出格式（每条数据）

| 字段 | 含义 |
|---|---|
| `id` | `galgame-<站点名>-<帖子 URL 的 sha256 前 12 位>`。同一帖子永远同一个 id → 重复抓取自动去重 |
| `source` | 兼容模式下固定 `"galgame"`（子站点模块里写的是 `"galgame/siteA"`，由聚合器归一，见下节） |
| `site` | 这条数据来自哪个子站点，例如 `siteA` |
| `name` | 帖子标题 / 游戏名（子站点负责去掉多余站点名后缀） |
| `desc` | 帖子正文纯文本，**保留段落换行** |
| `images` | 帖子里的图片地址数组 |
| `links` | 帖子里出现的所有链接（不判断用途） |
| `url` | 原帖地址 |
| `fetched_at` | 抓取时间 `YYYY-MM-DD HH:MM` |
| `cover` / `tags` | 兼容字段：`cover = images[0] || ''`、`tags = []`（因为 `fetch.mjs` 的守门人要求有这两个字段） |

### `images` 是干什么的

写文案要用的配图。聚合器会把第一张塞进兼容字段 `cover`，其它照旧。抓不到图就是空数组 / 空串。

### `links` 是干什么的

帖子里出现的**所有** http(s) 链接：网盘、论坛、官网、外链全收。
脚本**只采集、不判断** —— 不判断是不是有效资源、不判断是哪个网盘、不判断是不是广告。
因为「哪些是真资源」由你手工判断，所以这里宁滥勿缺，一个都不漏。

## 兼容模式（`COMPAT_WITH_VALIDATOR`）

`fetch.mjs` 的守门人校验（`fetch.mjs:185-219`）要求：`id` 以 `galgame-` 开头、`source === 'galgame'`、
必须有 `cover` / `tags`。而子站点天然的写法是 `source: "galgame/siteA"`、只有 `images` / `links`。
所以聚合器顶部留了一个开关：

```js
const COMPAT_WITH_VALIDATOR = true; // 默认
```

- **`true`（当前）**：聚合器把每条数据归一化 —— `source` 变成 `"galgame"`，子站点名写进 `site` 字段，
  自动补 `cover` / `tags`。**`fetch.mjs` 一行都不用改。**
- **`false`**：保留子站点给的 `source: "galgame/siteA"`，也不补 `cover` / `tags`。
  前提是把 `fetch.mjs` 的校验放宽（约 4 行）：

  ```js
  // 1) 去掉两个字段的必填要求
  const REQUIRED_FIELDS = ['id', 'source', 'name', 'desc', 'url', 'fetched_at'];
  // 2) 改成"有才校验"
  if ('cover' in item && typeof item.cover !== 'string') fail(`${at} 的 cover 必须是字符串`);
  if ('tags' in item && !Array.isArray(item.tags)) fail(`${at} 的 tags 必须是数组`);
  // 3) 放行 "galgame/xxx" 这种子来源写法
  if (item.source !== sourceName && !item.source.startsWith(`${sourceName}/`)) fail(...);
  ```

  子站点模块的写法两种模式共用，不需要改。

## 聚合器怎么工作

1. 扫描 `sources/galgame/` 下的子目录（`.` / `_` 开头跳过）
2. 子目录没有 `index.mjs`、或没导出 `fetchGames` → ⚠️ 跳过
3. **串行**调用各站点的 `fetchGames()`（不并发，避免同一时间打太多站点；站点内部自己控频，模板是 2 秒/请求）
4. 逐条校验并归一化；格式不合法的条目单独丢弃并打印原因
5. 按 `id` 去重（同一 id 只留第一条 —— `fetch.mjs` 也会拒绝重复 id）
6. 返回合并数组 → `fetch.mjs` 按 id 去重后写入 `candidates/galgame-YYYY-MM-DD.json`

## 运行

```bash
cd automation
node fetch.mjs galgame                    # 输出 candidates/galgame-YYYY-MM-DD.json
node fetch.mjs galgame --date 2026-10-03  # 指定文件名里的日期
./run-with-proxy.sh fetch.mjs galgame     # 需要走代理时用这个（加载 .env 里的代理）
```

## 排查

| 现象 | 原因 / 处理 |
|---|---|
| `[galgame] 还没有任何子站点` | `galgame/` 下没有任何子目录。复制 `siteA/` 建一个即可 |
| `⚠️ xxx：目录里没有 index.mjs，已跳过` | 文件夹建了但没写入口文件 |
| `本模板还没配置（LIST_URL 为空），本次跳过` | `siteA` 还是模板，正常现象 |
| `列表页没解析出帖子链接` | `parseList()` 的正则没命中该站点，见 `siteA/README.md` |
| `⚠️ xxx 抓取失败，已跳过：fetch failed（UND_ERR_CONNECT_TIMEOUT）` | 网络/代理不通（用 `./run-with-proxy.sh`），或站点反爬 |
| `⚠️ xxx 第 N 条格式不合法，已跳过：id ... 必须以 galgame- 开头` | 子站点返回值不符合格式，看 `siteA/README.md` 的输出格式表 |
| `⚠️ 本次没有抓到任何数据，未写入文件` | 所有站点都没出货（模板没配置 / 都被降级跳过） |
| 落盘数据里 `site` 字段想改成别的名字 | 改 `index.mjs` 的 `normalizeItem()` 一处即可 |
