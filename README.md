# 论坛 + 游戏分享 — 部署说明

基于 **Cloudflare Workers + Hono + D1 + KV + Pages** 的双站点项目：一个论坛、一个游戏分享板块。
两站**共用同一个 Worker 后端**。历史上论坛与游戏站分两个 D1（`forum-db` / `game-db`），
**现在游戏库已停用**（`wrangler.jsonc` 里 `GAME_DB` 绑定被注释），游戏数据也落在 `forum-db`，
两站靠**表与字段**隔离。账号体系仍然独立：论坛账号不会在游戏站自动登录，反之亦然。

---

## 一、项目结构

```
simple_forum_cf/
├── README.md                # 本文件：部署与结构
├── HANDOFF.md               # 交接卡：给外部 AI / 部署助手（**先读这个**）
├── deploy.sh                # 一键部署脚本（Linux）
├── Linux部署手册-数据库合并.md
├── docs/                    # 设计文档（见第八节"文档地图"）
├── backend/                 # → Cloudflare Workers（API）
│   ├── src/index.ts         # 装配层，**48 行**：CORS + 11 个 app.route + 健康检查
│   ├── src/types.ts         # Env 绑定与公共类型（28 行）
│   ├── src/lib/             # 共享内核：auth 80 / security 74 / settings 38 / notify 22
│   ├── src/modules/         # 11 个领域模块（表见下；小说书源代理在 media.ts 里）
│   ├── schema.sql           # 论坛表结构（新库用）
│   ├── migrate.sql          # 论坛增量迁移（已有库用）
│   ├── game-schema.sql      # 游戏站表结构（新库用）
│   ├── game-account-migrate.sql  # 游戏站账号迁移（非幂等，先查列）
│   ├── wrangler.jsonc       # D1 `DB` / KV `IMG_KV`（`GAME_DB` 已注释停用）
│   ├── .dev.vars            # 本地 JWT_SECRET（勿提交）
│   └── node_modules/        # 依赖（Linux 版二进制，Windows 上 wrangler 跑不了）
├── frontend/                # → Cloudflare Pages（无构建，静态 HTML + 原生 ES module）
│   ├── index.html           # 双门面入口（论坛 / 游戏站）
│   ├── forum.html/.css      # 论坛首页（报纸风）
│   ├── post.html/.css       # 论坛帖子详情
│   ├── game.html/.css       # 游戏站（霓虹机厅）
│   ├── game-post.html/.css  # 游戏帖详情
│   ├── video.html/.css      # 影视（影院琥珀）
│   ├── novel.html/.css      # 小说（夜读暖棕）
│   ├── music.html/.css      # 苦海音乐（网易云 + Spotify + 多歌单）
│   ├── tools.html/.css      # 苦海工具箱（12 个本地工具）
│   ├── user.html/.css       # 个人主页
│   ├── notifications.html/.css
│   ├── login.html/.css      # 登录入口（海港夜灯配色，论坛与游戏共用）
│   ├── admin.html/.css/.js  # 管理后台（11 个标签页）
│   ├── 404.html
│   ├── common.js            # 全站共享库（871 行）：请求 / 登录态 / Markdown / 小播放器
│   ├── spotify.js           # Spotify 链接解析与内嵌（139 行，零依赖）
│   ├── music-playlists.js   # 多歌单数据 + 侧栏（300 行，零依赖）
│   ├── report.js            # 跨板块举报弹窗（171 行，零依赖）
│   ├── tools.js             # 工具箱注册表 + 弹窗壳（705 行）
│   ├── _headers             # 安全响应头 + 缓存策略
│   ├── vendor/              # 第三方库（按需加载，国内可直连）
│   ├── music/               # 背景音乐
│   ├── wallpapers/          # 壁纸
│   └── uploads/             # 历史图片
├── automation/              # 本地脚本，**不部署**：抓取 → 复核 → 发帖
└── automation-worker/       # 定时触发用的独立 Worker
```

### 后端 11 个模块（`backend/src/modules/`）

| 模块 | 行数 | 管什么 |
|---|---|---|
| `posts.ts` | 526 | 论坛帖 CRUD / 点赞 / 置顶 / 精选 / 评论 |
| `game-posts.ts` | 391 | 游戏站帖子与评论 |
| `gate.ts` | 320 | 门禁：开关、口令（PBKDF2）、提示词、TTL、通行证签发 |
| `admin.ts` | 242 | 后台统计与审核动作、CSV 导出 |
| `users.ts` | 232 | 用户列表 / 删除 / 角色 / 资料 |
| `media.ts` | 225 | 图片上传（KV）与 `GET /img/:id`；小说板块的维基文库代理（`/api/novel/*`，KV 缓存 1 天） |
| `reports.ts` | 212 | 举报工单（存 KV，键 `report:<id>`，180 天过期） |
| `accounts.ts` | 157 | 注册 / 登录 / me / 改密码 |
| `site.ts` | 143 | 分类、站点文案、公开设置（只回 5 个白名单键） |
| `health.ts` | 139 | 站点体检 7 项（只读） |
| `notifications.ts` | 75 | 通知列表 / 已读 |

模块之间只有三处单向只读依赖：`accounts → gate`、`admin → gate`、`health → gate`（都不复制门禁结构）。

## 二、文件分别放在哪里

| 部分 | 部署目标 | 部署方式 |
|---|---|---|
| `backend/` | **Cloudflare Workers** | `npx wrangler deploy` |
| `frontend/` 里的内容 | **Cloudflare Pages** | Git 连接 或 控制台直接上传 |
| 数据库表 | **Cloudflare D1**（唯一在用 `forum-db`；`game-db` 已停用，游戏数据并在 `forum-db`） | `npx wrangler d1 execute` |
| 图片存储 | **Cloudflare KV**（`IMG_KV`，免费 1 GB／1000 写/天，**无需绑卡**） | `npx wrangler kv namespace create IMG_KV` + 写入 `wrangler.jsonc` |

整体关系（域名规划）：

```
前端 Pages（同一个项目，两个域名都指向它）
  ├─ https://kuhai.de5.net        （不带 www）
  └─ https://www.kuhai.de5.net    （带 www）
            │ fetch 调用
            ▼
后端 Worker → https://api.kuhai.de5.net
            ├─ D1：forum-db（论坛 + 游戏站数据，靠表/字段隔离）
            └─ KV：IMG_KV（图片二进制 + 举报工单）
```

> 域名 `kuhai.de5.net` 在 DNSHE 注册，NS 已托管到 Cloudflare（walt/sloan.ns.cloudflare.com），
> 因此所有 `*.kuhai.de5.net` 子域名都在 Cloudflare 控制台直接管理。

---

## 三、部署步骤（Linux）

> 顺序：先部署后端 + 迁移数据库，再部署前端。

### 1. 准备环境（如 node_modules 不可用）

```bash
cd backend
npm install          # 若直接 copy 的 node_modules 报权限/二进制错误，再执行这步
```

### 2. 创建/确认 D1 数据库（仅首次）

```bash
npx wrangler d1 create forum-db
# 把输出的 database_id 填入 wrangler.jsonc 的 d1_databases
```

### 3. 数据库建表 / 迁移

- **全新空库**：

  ```bash
  npx wrangler d1 execute forum-db --remote --file schema.sql
  ```

- **已经部署过、有数据的库**（只执行一次）：

  ```bash
  npx wrangler d1 execute forum-db --remote --file migrate.sql
  ```

### 4. 设置生产密钥 JWT_SECRET（仅首次）

```bash
npx wrangler secret put JWT_SECRET
```

### 5. 配置域名（Cloudflare 控制台操作）

目标：后端用 `api.kuhai.de5.net`，前端用 `kuhai.de5.net` 和 `www.kuhai.de5.net`。

**5.1 后端 Worker 绑定 api 子域名**

1. Workers & Pages → 选择 **forum-api** → Settings → Domains & Routes。
2. Add → **Custom Domain** → 输入 `api.kuhai.de5.net` → Add Custom Domain。
   Cloudflare 会自动添加 DNS 记录并签发证书。
3. 在同一列表里，如果还有旧的 `kuhai.de5.net` 绑定，**移除它**（要让给前端）。

**5.2 前端 Pages 绑定两个域名**

1. Workers & Pages → 选择你的 **Pages 项目** → Custom domains。
2. 确认 `www.kuhai.de5.net` 已存在。
3. Set up a custom domain → 输入 `kuhai.de5.net` → Continue → Activate domain。
   （必须先完成 5.1 第 3 步，否则会和 Worker 冲突。）

> 原 `workers.dev` 地址在国内被 DNS 污染，不再使用。前端 `common.js` 的 `API_BASE`
> 已改为 `https://api.kuhai.de5.net`。

### 6. 部署后端 Worker

```bash
npx wrangler deploy --minify
```

部署后健康检查：访问 `https://api.kuhai.de5.net/`，应返回 `{"ok":true,"service":"forum-api"}`。

### 7. 部署前端到 Pages

- **方式 A（推荐）**：把 `frontend/` 内容推到 Git 仓库，Pages 连接仓库自动部署。
- **方式 B（直接上传）**：Workers & Pages → 创建 → Pages → 「直接上传资源」，
  把 `frontend/` **里面的内容**拖进去。

> ⚠️ 要让 `index.html` 位于网站最外层，不要多套一层 `frontend/` 目录。

完成后，`https://kuhai.de5.net` 和 `https://www.kuhai.de5.net` 都会显示同一个前端界面。

### 8. 本地调试（可选）

```bash
# 本地 D1 建表
npx wrangler d1 execute forum-db --local --file schema.sql
# 启动后端（.dev.vars 已含本地 JWT_SECRET），默认 http://localhost:8787
npx wrangler dev
```

前端本地调试：用任意静态服务器托管 `frontend/`（例如 `npx serve .` 或
`python3 -m http.server 8848`），再访问 `http://localhost:8848/`。

- 想让本地前端调用**本地后端**（8787）：把 `common.js` 顶部的 `USE_LOCAL_API` 改为 `true`。
- 想让本地前端调用**线上后端**：保持 `USE_LOCAL_API = false`（默认）。

---

## 四、图片上传（Cloudflare KV）

图片走 **KV 二进制直存**（已从 R2 / 第三方图床迁移过来）：免费、**无需绑卡**，且国内可直连。

### 4.1 建命名空间并绑定

```bash
# 1) 创建命名空间（务必从输出里复制 id —— 本项目曾因手抄错 id 三次部署失败）
npx wrangler kv namespace create IMG_KV
```

2. 把 id 填进 `backend/wrangler.jsonc`：

   ```jsonc
   "kv_namespaces": [
     { "binding": "IMG_KV", "id": "f677e3ee4a4a4484b2dc54aad6ce0de1" }
   ],
   ```

3. 重新部署：`npx wrangler deploy --minify`。

### 4.2 接口一览

| 用途 | 方法与路径 | 鉴权 |
|---|---|---|
| 论坛上传 | `POST /api/posts/upload` | 论坛 JWT |
| 游戏站上传 | `POST /api/game/posts/upload` | 游戏站密码（token scope=game） |
| 读取（`<img src>` 直接引用） | `GET /img/:id` | 无 |

- 表单字段名 `file`，仅接受 `image/*`，**单张 ≤ 5 MB**
- 存储位置：`IMG_KV` 的 `img:<id>`，**二进制 ArrayBuffer 直存**（比 base64 省约 33% 空间）
- **不设 `expirationTtl` → 图片永久保存**；读取时返回 `Cache-Control: public, max-age=31536000, immutable`
- 上传接口返回**绝对地址** `https://api.kuhai.de5.net/img/<id>`
  （前端在 Pages 上，若返回相对路径 `/img/...` 会打到 Pages 得到 404）

### 4.3 免费额度与运维

| 项 | KV 免费额度 | 说明 |
|---|---|---|
| 存储 | 1 GB | 按单张 5 MB 上限算，约可存 200 张满额图 |
| 写入 | 1,000 次/天 | 即每天最多 1,000 次上传 |
| 读取 | 100,000 次/天 | 浏览器有 1 年缓存，实际读取远低于此 |
| 单 value | 25 MiB | 远高于接口的 5 MB 限制 |

> 存满后的处理：先删无用图片
> `npx wrangler kv key delete --namespace-id <IMG_KV_id> "img:<id>"`
> 或改用 R2（需绑卡，10 GB 免费）。

---

## 五、功能说明（按板块）

七个板块各自有独立的视觉与逻辑，**跨板块只允许 `<a href>` 跳转**，方便单独拿出去放：

| 板块 | 入口 | 现在有什么 |
|---|---|---|
| 论坛 | `/forum` | 发帖（壁纸/资源/求助/闲聊）、图片上传、搜索、排序（最新/热门/最赞）、评论与点赞、@提及产通知 |
| 游戏站 | `/game` | 封面墙、排序与搜索、**门禁密码**换 `scope=game` 通行证（默认 12 小时）、独立账号或访客昵称发帖 |
| 苦海音乐 | `/music` | 网易云曲库搜索+点播、热门试听、**Spotify 链接内嵌**（与网易云并存）、**多歌单**（新建/改名/清空/删除，「我的收藏」自动迁移旧数据） |
| 小说 | `/novel` | 书源 = 中文维基文库（只收公版），搜索即读，夜读排版 |
| 影视 | `/video` | 片库浏览与剧集切换，影院风版式 |
| 苦海工具箱 | `/tools` | **12 个纯本地工具**：JSON、时间戳、URL/Base64、正则、哈希、密码、UUID、颜色、对比度、文本清洗、命名转换；不联网、不上传 |
| 管理后台 | `/admin` | 11 个标签页（见下） |

### 管理后台的 11 个标签页

数据概览 · 🩺 站点体检 · 🚩 举报处理 · 帖子管理 · 用户管理 · 分类管理 · 游戏站管理 ·
🔐 门禁 · 内容设置 · 界面设置 · 导出

- **站点体检**：7 项只读检查（配置里有无敏感键、门禁开关、口令是否还是出厂默认、
  管理员数为 0、管理员是否仍用 `admin@2026`、内容质量、今日活跃）
- **举报处理**：工单列表（待处理/已处理/已忽略/全部）、标记处理、忽略、退回、跳原帖；
  帖子与游戏帖详情页都有「⚑ 举报」按钮
- 门禁页会显示"口令仍是默认值"的红色风险卡

### 图片与存储
- 图片走 KV 二进制直存（`img:<id>`），单张 ≤ 5 MB，不设 TTL（永久）
- 举报工单也存 KV（`report:<id>`，180 天自动过期），**不需要建表、不需要迁移**

## 六、常见问题

1. **注册/登录报 500 或 secret 错误**
   生产环境未设置 JWT_SECRET，执行 `npx wrangler secret put JWT_SECRET`。

2. **查询报 `no such column: category`**
   已有数据库未迁移，执行 `npx wrangler d1 execute forum-db --remote --file migrate.sql`。

3. **图片上传失败**
   - 报 `501`／提示未绑定：`wrangler.jsonc` 缺 `kv_namespaces`，按「第四节」配置后重新部署。
   - 报「图片不能超过 5MB」：单张上限 5 MB（前端 `compressImage` 会先压缩，可调低压缩质量）。
   - 上传成功但图片不显示：确认接口返回的是 `https://api.kuhai.de5.net/img/...` 绝对地址
     （相对路径会被 Pages 当成自己的路由 → 404）。

4. **`wrangler dev` 报平台二进制错误**
   node_modules 是在其他平台安装的，在当前平台执行 `npm install` 重建。

5. **前端页面打不开 / 资源 404**
   Pages 上传时多套了目录，确保 `index.html` 在网站根目录。

6. **migrate.sql 重复执行报错**
   迁移只需执行一次，重复执行会因列已存在报错，属正常。

7. **`git pull` / `git push` 卡住不动或超时**
   `github.com:22` 经 Clash 代理不通（`Connection timed out during banner exchange`），
   而 `~/.gitconfig` 里的 `insteadOf = git@github.com:` 会把 SSH 地址改写成 HTTPS。
   所以本仓库 remote 固定用别名 `git@github-cline:tao537/simple_forum_cf.git`，
   `~/.ssh/config` 中 `github-cline` 指向 `ssh.github.com:443` + `ProxyCommand nc -X connect -x 127.0.0.1:7890`。
   脚本里调用 git 必须配 `timeout` 与 `-o BatchMode=yes`，否则握手失败会一直挂住（看起来像卡死）。

8. **game-account-migrate.sql 报 `duplicate column name`**
   该文件里的 `ALTER TABLE ... ADD COLUMN` 非幂等（SQLite 不支持 `ADD COLUMN IF NOT EXISTS`），
   重复执行会让 wrangler 整批回滚并报错。执行前先查结构，例如
   `pragma_table_info('posts')` 里有没有 `author_user_id`，缺什么补什么。
   注意 `wrangler d1 execute --json` 的输出**是带缩进的**（`"name": "posts"`，冒号后有空格），
   解析时必须容忍空白，否则会把"已存在"误判成"缺失"而重复 ALTER。

---

## 七、环境约束（务必遵守）

- 运行环境是 **Cloudflare Workers**，不是 Node.js。
- 禁止使用：Express、mysql2、multer、bcryptjs、任何 Node 原生模块（fs/path/process）。
- 数据库用 **Cloudflare D1（SQLite 语法）**，通过 `c.env.DB` 访问。
- 密码哈希用 **Web Crypto PBKDF2**。
- JWT 用 **hono/jwt**，密钥从 `c.env.JWT_SECRET` 读取，不硬编码。

---

## 八、文档地图（别整仓通读，按需跳）

| 想知道 | 读哪 |
|---|---|
| 项目整体、目录地图、后端锚点、踩过的坑 | `docs/项目速览.md`（**最省 token 的入口**） |
| 接手部署与验证（外部 AI 先读） | `HANDOFF.md` |
| 前端分层判据、缓存版本规矩、新增后台控件五步 | `docs/前端结构与约定.md` |
| 后端模块化过程、门禁契约、举报域设计 | `docs/后端模块化与门禁说明.md` |
| 界面与功能的规划、各板块视觉身份进度 | `docs/界面与功能规划.md` |
| token 成本怎么降下来的 | `docs/Agent优化报告.md` |
| automation 怎么写一个清单、怎么发布 | `automation/README.md` |

> 改完代码顺手更新对应文档——文档过期比没有文档更坑（本文件 2026-11-13 就修过一次"`index.ts` 是所有接口"的错误描述）。
