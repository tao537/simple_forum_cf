# 来源：steam —— Steam 免费游戏

## 抓什么

从 Steam 的「特色分类」接口里挑出**免费游戏**（`final_price` 或 `original_price` 为 0），
再逐个取详情（简介、封面、类型标签），产出可以直接下笔写文案的候选清单。

实测（2026-10-04，`cc=CN&l=schinese`）：分类去重 52 款 → 免费 14 款 → 过滤掉 6 款试玩版 Demo → **入库 8 款**。

## 依赖的接口（Steam 公开接口，无需 key）

| 接口 | 用途 |
|---|---|
| `https://store.steampowered.com/api/featuredcategories?cc=CN&l=schinese` | 分类列表（specials / new_releases / top_sellers / coming_soon / genres…），含价格字段 |
| `https://store.steampowered.com/api/appdetails?appids=<appid>&cc=CN&l=schinese` | 单个游戏详情：`short_description`、`header_image`、`genres`、`type` 等 |

> 类型标签（genres）**只在 appdetails 里有**，分类接口不返回，所以每款游戏都要再请求一次详情。

## 运行

```bash
cd automation
node fetch.mjs steam                   # 输出 candidates/steam-YYYY-MM-DD.json
node fetch.mjs steam --date 2026-10-03 # 指定文件名里的日期
node fetch.mjs steam --no-proxy        # 本次直连（不走代理）
node fetch.mjs steam --proxy http://127.0.0.1:7890
```

## 输出字段（统一数据格式）

| 字段 | 来源 | 说明 |
|---|---|---|
| `id` | `steam-<appid>` | 前缀必须与来源文件夹名一致（fetch.mjs 会校验） |
| `source` | 固定 `"steam"` | |
| `name` | appdetails 的 `name` | |
| `desc` | appdetails 的 `short_description` | 原始简介，写文案时自己润色 |
| `url` | 拼装 | `https://store.steampowered.com/app/<appid>/` |
| `cover` | appdetails 的 `header_image` | 没有则退回分类接口的图片，再没有就是 `""` |
| `tags` | appdetails 的 `genres[].description` | 中文标签，如 `["动作","免费开玩"]` |
| `fetched_at` | 本地抓取时间 | `YYYY-MM-DD HH:mm`，与 `--date` 无关 |

## 限流与容错

- 每款游戏之间固定间隔 **2 秒**（`REQUEST_INTERVAL`），单请求超时 20 秒
- 分类接口失败 = 整批失败，立即报错退出（不静默重试）
- 单个游戏详情失败 = 只跳过该游戏并打印 `⚠️`，其余照常入库
- 试玩版 Demo 默认跳过（`SKIP_DEMO = true`，依据 `type === 'demo'`）；想收录改成 `false`

## 常见问题

- **报 `UND_ERR_CONNECT_TIMEOUT` / `fetch failed`**：网络或代理不通。本机需要走系统代理
  （`127.0.0.1:7890`，脚本已默认使用）；代理偶尔抖动时重跑一次即可，也可以用 `--proxy` 换端口、`--no-proxy` 试直连。
- **免费游戏比预期少**：分类接口只给「当前特色」的一小批（约 50 款），不是全站搜索；
  想抓更多可以后续在这里追加商店搜索接口。
- **某个字段变空了**：接口字段改名时，`desc` / `cover` / `tags` 会先变成空值，照 Steam 返回的 JSON 调整 `fetchGames` 里的取值即可。
- **跑得慢**：每条之间等 2 秒，抓 8 款约 30 秒属正常。

## 想抓别的来源？

见 `automation/README.md` 的「如何新增一个来源」：在 `sources/` 下新建 `<名字>/index.mjs`、
导出 `fetchGames(options)` 即可，**不需要改 `fetch.mjs`**。
