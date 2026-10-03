# 论坛 + 游戏分享 — 部署说明

基于 **Cloudflare Workers + Hono + D1 + KV + Pages** 的双站点项目：一个论坛、一个游戏分享板块。
两站**共用同一个 Worker 后端**，但数据互相隔离 —— 论坛用 `forum-db`，游戏站用 `game-db`，
且**各自有独立的账号体系**（论坛账号不会在游戏站自动登录）。

---

## 一、项目结构

```
simple_forum_cf/
├── backend/                 # 后端 → Cloudflare Workers（API）
│   ├── src/index.ts         # 所有接口代码（论坛 + 游戏站）
│   ├── schema.sql           # 论坛表结构（新库用）
│   ├── migrate.sql          # 论坛增量迁移（已有库用）
│   ├── game-schema.sql      # 游戏站表结构（新库用）
│   ├── game-account-migrate.sql  # 游戏站账号体系增量迁移（非幂等，先查列再执行）
│   ├── README.md            # 后端说明
│   ├── wrangler.jsonc       # Worker 配置（D1×2 / KV 绑定）
│   ├── package.json
│   ├── .dev.vars            # 本地开发密钥（JWT_SECRET，勿提交）
│   └── node_modules/        # 依赖（Linux 版，可直接用于 Linux）
└── frontend/                # 前端 → Cloudflare Pages（网页）
    ├── index.html           # 站点入口（论坛 / 游戏站二选一）
    ├── forum.html           # 论坛首页（帖子列表）
    ├── game.html            # 游戏分享板块
    ├── post.html            # 论坛帖子详情
    ├── game-post.html       # 游戏帖子详情
    ├── admin.html           # 管理后台
    ├── login.html           # 登录 / 注册（左右双入口）
    ├── notifications.html   # 消息通知
    ├── user.html            # 个人主页
    ├── 404.html             # 自定义 404
    ├── common.js            # 共享脚本（登录态、请求、设置、图片压缩）
    ├── music/               # 背景音乐
    ├── wallpapers/          # 壁纸
    └── uploads/             # 历史图片
```

## 二、文件分别放在哪里

| 部分 | 部署目标 | 部署方式 |
|---|---|---|
| `backend/` | **Cloudflare Workers** | `npx wrangler deploy` |
| `frontend/` 里的内容 | **Cloudflare Pages** | Git 连接 或 控制台直接上传 |
| 数据库表 | **Cloudflare D1**（`forum-db` 论坛库 / `game-db` 游戏库，双库互相隔离） | `npx wrangler d1 execute` |
| 图片存储 | **Cloudflare KV**（`IMG_KV`，免费 1 GB／1000 写/天，**无需绑卡**） | `npx wrangler kv namespace create IMG_KV` + 写入 `wrangler.jsonc` |

整体关系（域名规划）：

```
前端 Pages（同一个项目，两个域名都指向它）
  ├─ https://kuhai.de5.net        （不带 www）
  └─ https://www.kuhai.de5.net    （带 www）
            │ fetch 调用
            ▼
后端 Worker → https://api.kuhai.de5.net
            ├─ D1：forum-db（论坛数据）
            ├─ D1：game-db（游戏站数据，与论坛完全隔离）
            └─ KV：IMG_KV（图片，二进制直存，免费 1 GB）
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

## 五、功能说明

### 论坛
- 发帖（分类：壁纸 / 资源 / 求助 / 闲聊）、图片上传、搜索、排序（最新/热门/最赞）
- 评论、评论点赞、帖子点赞
- 回复 / @提及 / 点赞 会产生消息通知

### 游戏分享（游戏站，与论坛隔离）

- 独立紫色主题板块，封面墙展示，帖子归入「游戏」分类
- 支持最新/热门/最赞排序与搜索
- **访问需密码**：在游戏站输入访问密码换取 `scope=game` 的 token（**12 小时**有效），与论坛登录态完全隔离
- **独立账号体系**：游戏站可自行注册 / 登录（数据在 `game-db`），发帖评论显示账号身份；
  未登录则以「访客昵称」发帖
- **独立数据库**：游戏站的用户 / 帖子 / 评论 / 图片都走 `game-db`（`GAME_DB` 绑定），
  与论坛 `forum-db` 互不影响 —— 论坛账号在游戏站不会自动登录，反之亦然
- 游戏站管理员：拥有游戏站的帖子管理权限（任命方式与论坛管理员相同）

### 管理员（第一个注册用户自动成为管理员）
- **数据概览**：用户 / 帖子 / 评论 / 点赞统计、今日新增、分类分布、热门帖子
- **帖子管理**：集中置顶 / 精选 / 删除，支持筛选与分页
- **用户管理**：任命管理员、删除、批量删除
- **界面设置**：卡片大小（大/中/小）、布局密度、图片最大宽度、压缩质量

---

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
