# 苦海 · 自动化发布 Worker

把本地 Linux + ollama 的流水线搬到 Cloudflare Workers，实现 24/7 自动抓游戏 → AI 写文案 → 发帖。

## 架构

```
Cron 每天 9:00 (北京时间)
    ↓
Worker 触发
    ↓
1. 门禁 + 管理员登录游戏站 API
2. 抓取 shinnku 最新游戏
3. 云端 AI (DeepSeek/智谱) 写推荐文案
4. 调游戏站 API 发帖
5. KV 记录已发 ID（90 天去重，不重复发）
```

## 部署步骤

### 1. 创建 KV namespace（去重用）

```bash
cd automation-worker
npx wrangler kv:namespace create PUBLISHED
```

输出类似：
```
🌀 Creating namespace with title "forum-automation-PUBLISHED"
✨ Success!
Add the following to your configuration file in your wrangler.toml:
[[kv_namespaces]]
binding = "PUBLISHED"
id = "xxxx-xxxx-xxxx"
```

把输出的 `id` 填进 `wrangler.toml` 的 `id = "REPLACE_WITH_YOUR_KV_ID"`。

### 2. 设置 Secrets（敏感信息，不会写进代码）

```bash
npx wrangler secret put GATE_PASSWORD
# 输入门禁密码：利益or节操

npx wrangler secret put ADMIN_USERNAME
# 输入游戏站管理员用户名

npx wrangler secret put ADMIN_PASSWORD
# 输入游戏站管理员密码

npx wrangler secret put AI_API_KEY
# 输入你的云端 AI API key（DeepSeek 的 sk-... 或智谱的 key）
```

### 3. 确认配置

编辑 `wrangler.toml`：
- `AI_BASE_URL`：默认 DeepSeek（`https://api.deepseek.com/v1`），想换智谱就改成 `https://open.bigmodel.cn/api/paas/v4`
- `AI_MODEL`：DeepSeek 用 `deepseek-chat`，智谱用 `glm-4.7-flash`（免费）
- `MAX_PER_RUN`：每次最多发几条（默认 3）

### 4. 部署

```bash
npx wrangler deploy
```

### 5. 手动测试（不等到 Cron）

部署后访问：
```
https://forum-automation.<你的子域>.workers.dev/run
```

会立即跑一次流水线，返回 JSON 日志。

## 日常运维

- **看日志**：`npx wrangler tail` 实时看运行日志
- **手动触发**：访问 `/run` 路径
- **改频率**：编辑 `wrangler.toml` 的 `crons` 行
- **换 AI**：改 `AI_BASE_URL` 和 `AI_MODEL`，重新 `wrangler secret put AI_API_KEY`

## 与本地方案对比

| | 本地 Linux | Workers 版 |
|---|---|---|
| 开机要求 | 电脑得开着 | 24/7 自动 |
| 代理 | 要挂 Clash | 不需要（Cloudflare 网络） |
| 文案模型 | 本地 ollama | 云端 AI API |
| 定时 | crontab | Workers Cron |
| 日志 | 本地 log 文件 | wrangler tail / KV |

## 注意

- 目前只抓 shinnku 一个站，后续加站在 `fetchShinnkuLatest()` 旁边加新函数
- AI 文案质量取决于你配的模型，DeepSeek-chat 质量最好，智谱 glm-4.7-flash 免费但弱一些
- 已发游戏在 KV 里保留 90 天，到期后会重新发（如果游戏还在最新列表里）
