# Linux 部署手册：数据库合并 + 本轮全部改动

> 目标机器：Linux Mint（仓库 `~/Desktop/project/simple_forum_cf`）。
> Windows 副本的 `backend/node_modules` 是 Linux 版，**所有 wrangler / 数据库操作必须在 Linux 跑**。
> wrangler 用 `node node_modules/wrangler/bin/wrangler.js` 直调（npx 不可用）。

---

## 〇、把项目从 Windows 复制到 Linux

任选其一：

- U 盘 / 局域网：把整个 `simple_forum_cf` 覆盖到 `~/Desktop/project/simple_forum_cf`。
- 若先推了 GitHub：Linux 上 `git pull`（https 走代理会卡，建议用 SSH：`git pull git@github.com:tao537/simple_forum_cf.git main`）。

> 注意：`automation/config.json`、`backend/.dev.vars` 等凭证文件被 .gitignore 忽略，
> 走 GitHub 不会同步，需单独复制（或在 Linux 重建）。

---

## 一、备份两个数据库（务必先做）

```bash
cd ~/Desktop/project/simple_forum_cf/backend
TS=$(date +%Y%m%d-%H%M%S)
node node_modules/wrangler/bin/wrangler.js d1 export forum-db --remote --output forum-backup-$TS.sql
node node_modules/wrangler/bin/wrangler.js d1 export game-db  --remote --output game-backup-$TS.sql
```

> 若 `d1 export` 版本不支持，用 `--command "SELECT ..."` 逐表导出，或在 Cloudflare 控制台手动导出。

---

## 二、在 forum-db 建合并表结构

```bash
node node_modules/wrangler/bin/wrangler.js d1 execute forum-db --remote --file merge-schema.sql
```

验证四张 game_ 表已建：

```bash
node node_modules/wrangler/bin/wrangler.js d1 execute forum-db --remote \
  --command "SELECT name FROM sqlite_master WHERE name LIKE 'game_%';"
```

---

## 三、迁移 game-db 数据到 forum-db

先只生成、**人工核对**（不写库）：

```bash
node migrate-merge.mjs
# 生成 merge-data.sql，检查新用户数 / 帖子 / 评论 / 点赞 / 门禁设置是否合理
less merge-data.sql
```

核对无误后执行导入：

```bash
node migrate-merge.mjs --apply
```

迁移规则：
- 同名用户以论坛为准并归并（帖子作者映射到论坛 id）；
- 论坛没有的游戏用户，分配新 id 插入 forum-db.users，email 用占位 `game_<id>_<rand>@kuhai.local`（以后可补）；
- game_posts / game_comments 保留原 id，仅重映射 author_user_id；
- 门禁密码 hash 与提示词并入 forum-db.site_settings。

---

## 四、部署后端

```bash
# 若 esbuild 报 EACCES：
chmod +x node_modules/@esbuild/linux-x64/bin/esbuild

node node_modules/wrangler/bin/wrangler.js deploy
```

> `wrangler.jsonc` 已注释停用 GAME_DB 绑定；旧 game-db 数据保留，
> 确认合并稳定（观察几天）后再到 Cloudflare 控制台删除该数据库。

---

## 五、部署前端（push GitHub，Pages 自动部署）

前端改动（卡顿修复、SSO、favicon、动漫背景等）需推到 GitHub main：

```bash
cd ~/Desktop/project/simple_forum_cf
git add -A
git commit -m "数据库合并统一账号 + 卡顿修复 + 复核/ollama 增强 + 动漫背景"
git push origin main   # 若 https 卡，用 SSH：git push git@github.com:tao537/simple_forum_cf.git main
```

---

## 六、验证清单

- [ ] 论坛登录后，首屏列表**不再空白**（失败有"点击重试"，网络抖动自动重试）。
- [ ] 游戏站输入门禁密码可进入；门禁提示词正常显示。
- [ ] **论坛登录后打开游戏站，自动是登录态（SSO）**；游戏站登录后论坛也登录。
- [ ] 游戏站历史帖子、评论、点赞数都在。
- [ ] 论坛管理员（role=admin）在游戏站可管理帖子（置顶/精选/删除）。
- [ ] 后台「数据概览」游戏统计字段正常（posts/comments/postLikes...）。

---

## 七、回滚

- 后端：恢复 `wrangler.jsonc` 里 GAME_DB 绑定（文件内有注释模板），`git revert` 后端代码后重新 deploy。
- 数据：用第一步的 `forum-backup-*.sql` / `game-backup-*.sql` 恢复。

---

## 附：本轮其他改动

- 卡顿修复：`common.js` 统一请求内核（GET 自动重试、15s 超时）；`forum.html` 列表先行、失败重试。
- 复核自动化：`automation/review.mjs` 自动 pass/warn/reject，输出 `.review.json`，`--to-queue` 自动转队列。
- ollama 文案：`automation/publish-game.mjs` 恢复本地 ollama 生成，发布前 `checkOllama` 预检；
  预检命令：`node publish-game.mjs --check-ollama`（需先 `ollama serve` 且 `ollama pull qwen2.5:7b`）。
