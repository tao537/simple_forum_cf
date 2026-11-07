# 交接卡 — simple_forum_cf

> 写给**接手本项目的外部 AI / 部署助手**。目的：不探索、通读仓库就能直接干活。
> **先读这三个文件，够了**：本卡 → `docs/后端模块化与门禁说明.md` → `backend/wrangler.jsonc`。
> 需要更细的再按「按需查阅」跳，**不要整仓通读**。

## 一、当前状态（2026-11-13，HEAD 见仓库最新提交；Worker Version 以最近一次部署回报为准）

| 项 | 值 |
|---|---|
| 仓库根 | `simple_forum_cf/.git`（注意：工作目录本身不是 git 根） |
| 分支 | `main`，本地与 `origin/main` 一致 |
| 站点 | 前端 `https://kuhai.de5.net`（Pages，push 后自动发布）　后端 `https://api.kuhai.de5.net`（Worker `forum-api`） |
| 绑定 | D1 `DB = forum-db`、KV `IMG_KV`；`GAME_DB` 已注释停用（游戏库并入 forum-db） |
| 后端部署状态 | **已上线**，当前代码已全部模块化；实测 `670339f` 部署为 Version `8ddf25ee-1b45-4592-a6b8-8855bcefe3ae`（设备 AI 回报，哈希泄露修复版） |

后端已按「共享内核 + 领域模块」拆完，总 2952 行：

```
backend/src/
├── index.ts             48 行  ← 只剩装配层：CORS + 11 个 app.route + GET /
├── types.ts             28
├── lib/        auth 80 / security 74 / settings 38 / notify 22
└── modules/    posts 526 / game-posts 391 / gate 320 / admin 242 / users 232 / media 225
                / reports 212 / accounts 157 / site 143 / health 139 / notifications 75
```

约定：模块各自是 `Hono<Env>` 子应用，只依赖 `lib/`，模块之间**不互相 import**；
新增能力只有两种落点——纯能力进 `lib/`，业务进 `modules/`，**不要再往 `index.ts` 里堆路由**。

## 二、部署怎么做

```bash
# 只在 Linux 机器上做（Windows 上 node_modules 是 Linux 二进制，wrangler 跑不了）
cd backend && npx wrangler deploy
```

- 前端不用你管：push 到 `main` 后 Cloudflare Pages 自动构建发布；
- 首次/异常时确认 secret 仍在：`npx wrangler secret list`（应有 `JWT_SECRET`）；
- **不要**执行 `npm install` 之外的包管理操作，尤其**不要** `npm audit fix`（会把 wrangler 版本拖走）。

## 三、部署后必须逐条验证（照抄，不要自由发挥）

| # | 命令 | 期望 |
|---|---|---|
| 1 | `curl -s https://api.kuhai.de5.net/` | `{"ok":true,"service":"forum-api"}` |
| 2 | `curl -s https://api.kuhai.de5.net/api/settings` | **只有 5 个键**：cardSize/density/imageMaxWidth/imageQuality/thumbnailSize；**不得出现** `pbkdf2`、`gate`、`gamePasswordHash` |
| 3 | `curl -s https://api.kuhai.de5.net/api/game/gate` | `enabled/hasPassword/hint/ttl`（无哈希） |
| 4 | `curl -s -o /dev/null -w '%{http_code}' https://api.kuhai.de5.net/api/game/posts` | 门禁开启时 `401`（无通行证）；**门禁关闭（`/api/game/gate` 返回 `enabled:false`）时返回 `200` 属正常**，先确认开关再判失败 |
| 5 | `curl -s -o /dev/null -w '%{http_code}' https://api.kuhai.de5.net/api/admin/gate` | `403`（未登录） |
| 6 | `curl -s -o /dev/null -w '%{http_code}' https://api.kuhai.de5.net/api/game/reset-admin-password -X POST` | `404`（该后门已删除，不该复活） |

任一不符 → **停止，回报现象，不要自行改代码修**。

## 四、硬约束（违反了比不干活更糟）

1. **不改代码**：只做部署与验证。发现 bug 只回报，不擅自提交。
2. **不改 secret**：不得新建/覆盖 `JWT_SECRET`，不得输出 secret 值。
3. **不碰数据**：不执行任何 SQL，不 `DELETE`/`DROP`/`UPDATE`，不重置管理员密码。
4. **不 rollback**：除非站长明确要求；`wrangler rollback` 会让模块版本与前端版本错配。
5. **不 `git reset --hard` / `push --force`**：推送前必须先 `git pull --rebase`。
6. 回报格式固定：`commit` / `Version ID` / 6 条验证各自的结果 `原文响应或状态码` / 未做的事清单。

## 五、已知坑（别再踩一遍）

- **前端 12 页的内联 `<style>` 已全部抽成同名 css**（`frontend/<page>.css`），每个板块一套"覆盖层"式主题；改视觉请**追加**到该页 css 末尾，不要手写整份（曾因此覆盖掉 `novel.css` 原文）。
- **`common.js` 改一行，所有 HTML 的 `?v=` 都要加一**；`admin.js`/`admin.css` 改了两处版本号要一起改。

- **`*.workers.dev` 域名在国内直连会 TLS 失败**：验证一律走 `https://api.kuhai.de5.net`，不要拿裸 workers.dev 域名判失败。
- **门禁出厂默认口令仍可用**：后台「🔐 门禁」页现在会显示红色风险卡（`GET /api/admin/gate` 返回 `usingDefaultPassword`）。改密属运营动作，**由站长在后台操作**，AI 不要代改。
- **公开设置接口曾整包泄露哈希**：`/api/settings` 必须只回 5 个白名单键，动到 `modules/site.ts` 时要保住 `pickPublicSettings`。
- **`docs/项目速览.md` 的正文在 2026-11-13 更新过**（改成 `index.ts` 48 行 + 11 个模块 + 前端 4 个新模块），但**只改了仓库里的 ②**，机器上的 ①（`../AGENTS.md`）当时不可达，**未同步**。接手时若能在那台机器上操作，请把 ② 正文整体复制回 ①，再跑 `bash /home/zhong/Disk_C/ai/check-agents.sh`（第 10 项比对两份正文）。

## 五之二、本轮新增模块（2026-11-07，已随推送上线）

后端新增了举报模块，**推送后线上已生效（已实测，不是待办）**：

- `backend/src/modules/reports.ts`（举报工单）+ `index.ts` 多一行 `app.route('/', reportRoutes)`
- 部署后上线这三条：`POST /api/reports`（登录用户）、`GET /api/admin/reports`、`PATCH /api/admin/reports/:key`
- **不需要任何 SQL / 迁移**：工单存在已有的 KV 绑定 `IMG_KV`，键前缀 `report:`，180 天后自动过期
- **不改任何 secret、不碰数据库数据**
- 部署后请验证（未登录即可判定）：
  1. `POST /api/reports`（不带 token）→ 401，不能是 404
  2. `GET /api/admin/reports`（不带 token）→ 403，不能是 404
  3. `GET /api/settings` → 仍然只回五个显示字段（没被本次改动带出敏感键）
- 前端对应后台第 11 个「🚩 举报处理」标签页；`frontend/report.js` 是详情页的举报弹窗（跨板块共享库）
- 实测结果：`POST /api/reports` → 401、`GET /api/admin/reports` → 403，均不是 404，说明路由与鉴权都在

## 六、下一步待办（接手者可做，但需站长授权）

1. **举报闭环的人工实测**（唯一没走完的一条）：登录 → 详情页点「⚑ 举报」提交 → 后台「🚩 举报处理」看到工单 → 标记已处理。线上只验到"路由在、鉴权在前"（401/403 而不是 404），因为手上没有可用账号凭据。
2. **帖子管理缺编辑入口**（`PUT /api/posts/:id` 有接口，后台无 UI）；门禁缺「当前版本 / 通行证数」可视化。
3. 评估把举报工单从 KV 迁到 D1（当前 KV 只能前缀列举，`total` 是已读条数而非精确聚合；接口形状可以不变）。
4. 注册顺序不能乱：`/featured`、`/suggest`、`/batch` 必须在 `/api/posts/:id` 之前注册。

## 七、凭据

仓库里**不放任何 token 与 secret**（remote URL 里的凭据、`JWT_SECRET`、门禁口令都不写进文件）。
需要推送权限或线上口令时，向站长本人索取，**不要从仓库历史、日志或文档里找**。
