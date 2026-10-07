# kungal（鲲 Galgame 论坛）

站点：https://www.kungal.com/galgame （开源 Nuxt 站，SSR 渲染）

## 抓取流程（RSS 驱动，不走列表页）

1. **发现**：全站最新资源 RSS `https://www.kungal.com/rss/galgame.xml`
   （公开免登录，最新 50 条，每条 = 一个资源；`<category>游戏本体` 可用于过滤补丁/汉化）
2. **资源页** `https://www.kungal.com/galgame/resource/<rid>`（SSR 公开）：
   真实下载链接在 `__NUXT_DATA__`（devalue 扁平 JSON）的 `galgame_resource.dlsite.purchase_url` 字段；
   正文（解压说明/提取码）是 tiptap 文档，也在同一 payload；
   游戏 id / 游戏名 / 版本 / 大小 / 网盘名同页可取。
3. **游戏页** `https://www.kungal.com/galgame/<gid>`（SSR 公开）：
   `og:description` = 游戏简介。

## 站点坑位（2026-10-07 实测）

- **API 全线 401**：`/api/**` 未登录一律返回 `{"code":205,"message":"用户登录失效"}`，
  包括资源页上「获取链接」按钮背后的取链接口 → 游客拿不到新资源的真实网盘链接。
- **下载链接三个来源**（按优先级）：
  1. `galgame_resource.dlsite.purchase_url`（部分作者会把网盘链放这，SSR 可见）；
  2. 资源正文（tiptap 文档）里的链接节点 / 裸 URL；
  3. 都没有时（Telegram 渠道资源 / 正文只写解压教程的资源）→ payload 里带着
     **同游戏全部历史资源**，回退收集它们的链接，desc 里会注明「发布前务必点开核对」。
  复核的人构建 queue 清单时，panUrl/panCode 本来就是人工填的：登录浏览器点开
  `url` 字段（资源页）取链即可。
- **可见正文 ≠ payload**：SSR HTML 里 payload 是全量 JSON，正文渲染可能滞后/懒加载，
  解析一律认 `__NUXT_DATA__`，别认 DOM。
- **payload = 当前资源 + 同游戏历史资源**：用 rid 匹配主资源，其余当兜底来源。
- RSS 的 `<description>` 有时会把资源正文全文拼在尾部，字段截取要额外防。
- 无 gbk 编码问题（全站 UTF-8）；封面在 kungal 自家图床 `image.kungal.iloveren.link`，
  无 Referer 防盗链。
- 帖子单位是「资源」而非「游戏」：同一游戏出新资源 = 新的候选（id 含资源号），
  人工复核时自行取舍。

## 试跑（不要用 fetch.mjs galgame，会聚合全部子站）

```bash
cd simple_forum_cf/automation
node -e "import('./sources/galgame/kungal/index.mjs').then(m=>m.fetchGames({limit:3}))"
```

## 配置（index.mjs 顶部）

| 常量 | 默认 | 说明 |
|---|---|---|
| `RSS_URL` | 全站资源 RSS | 换成 `rss/galgame/<gid>.xml` 可盯单个游戏 |
| `ONLY_CATEGORY` | `游戏本体` | 空串 = 不过滤（会把补丁/汉化也抓进来） |
| `MAX_POSTS` | 10 | 单次抓取上限（`options.limit` 可临时覆盖，用于试跑） |
| `REQUEST_INTERVAL` | 2000ms | 请求间隔，别调太快 |
