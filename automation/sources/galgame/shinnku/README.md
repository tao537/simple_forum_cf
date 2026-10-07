# shinnku（真红小站）

站点：https://www.shinnku.com （开源：github.com/shinnku-nikaidou/shinnku-com，
Next.js 15 前端 + Rust/Axum 后端 + Backblaze B2 文件存储）

## 站点模型

**游戏 = 存储里的一个压缩包**（.rar/.7z/.apk），文件名即游戏名。目录树
（`/files/shinnku/<path>`）：

| 分区 | 内容 | 结构 |
|---|---|---|
| `zd` | 熟肉 PC（约 2400 个） | 编号分段文件夹（0001-0500 …），需下钻一层 |
| `0/win` | 熟肉 PC 旧区 | 文件直铺 + 少量子文件夹（不展开） |
| `0/apk` | 安卓 APK | 文件直铺 |
| `0/ons` `0/krkr` | ONS/KRKR | 默认不扫，要加改 SECTIONS |

## 抓取流程

1. **目录列表**：带 `RSC: 1` 头请求目录页 → Next.js App Router 飞行数据里嵌着
   后端目录 JSON 的完整 props，每个文件一段自包含 JSON：
   `{"type":"file","name":…,"info":{"file_path":…,"upload_timestamp":…,"file_size":…}}`
   → 正则整块抠出 `JSON.parse`，不碰 DOM。
2. 全分区合并 → 按 `upload_timestamp` 倒序 → 取前 N = 最新发布。
3. **简介**：公开接口 `/api/aiintro?name=<游戏名>`（站方 AI，简中，Redis 缓存），
   失败退 `/api/wiki?name=<游戏名>`（繁中维基，截 900 字）。

## 站点坑位（2026-10-07 实测）

- **下载是公开直链**（Backblaze B2）：`https://zd.shinnku.top/file/shinnku/<file_path>`，
  无需登录、无需提取码；路径每段 `encodeURIComponent`。
  （站方还有个 `download.shinnku.com` 加速域，注释里留着，未启用。）
- **后端目录 API（:2999）不公开**，Next 只在 SSR 时内网调用 → 只能吃 RSC 飞行数据。
  别再试 `www.shinnku.com/api/...` 猜目录接口，目录相关只有 `/api/aiintro`、
  `/api/wiki`、`/api/r2/download-url/**` 这几个。
- `aiintro` 返回的 `bg` 封面字段是**前端没在用的死字段**（只有文件名没有 URL 拼法），
  所以本源 cover 留空 → 封面由人工在 queue 清单 screenshots 里补。
- RSC 飞行数据里引号有 `\"` 转义，正则字符类必须写 `(?:[^"\\]|\\.)*`。
- 目录名/文件名带中文和特殊字符（`～`、`×`），URL 拼接一律逐段编码。

## 试跑（不要用 fetch.mjs galgame，会聚合全部子站）

```bash
cd simple_forum_cf/automation
node -e "import('./sources/galgame/shinnku/index.mjs').then(m=>m.fetchGames({limit:3}))"
```

## 配置（index.mjs 顶部）

| 常量 | 默认 | 说明 |
|---|---|---|
| `SECTIONS` | zd / 0/win / 0/apk | 要扫的分区，加 ONS/KRKR 在这里补 |
| `MAX_POSTS` | 10 | 单次抓取上限（`options.limit` 可临时覆盖） |
| `REQUEST_INTERVAL` | 2000ms | 请求间隔；aiintro 背后是站方 AI 服务，别调快 |
| `INTRO_MAX_CHARS` | 900 | 维基兜底简介的截断长度 |
