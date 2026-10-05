# 游戏推荐帖自动化发布

一条命令完成：**AI 写游戏推荐文案 → 自动发到游戏站**。

> 📖 **第一次用请先看 [`使用教程.md`](使用教程.md)** —— 抓取 → 复核 → 发布的手把手步骤、
> 命令速查、代理排查。架构与实现细节看 `项目报告.txt`。

## 工作流程

```
queue/*.json（待发布清单）
      │
      ▼
ollama 本地模型生成标题 + Markdown 推荐文案
      │
      ▼（可选）
云端 AI 润色（DeepSeek / OpenAI 兼容接口）
      │
      ▼（可选）
截图上传到 KV（需要论坛管理员账号）
      │
      ▼
门禁 + 游戏站管理员登录 → 发帖
      │
      ▼
published/（归档，含帖子链接，不会重复发布）
```

## 首次准备

```bash
cd automation
cp config.example.json config.json
```

编辑 `config.json`：

| 字段 | 说明 |
|---|---|
| `forumAdmin` | 苦海论坛管理员账号（admin），**仅上传截图时需要**；不发截图可随便填 |
| `game.gatePassword` | 游戏站门禁密码（当前：利益or节操） |
| `game.adminUsername / adminPassword` | 游戏站管理员账号（在游戏站注册的第一个账号） |
| `ollama.model` | 本地模型，推荐 `qwen2.5:7b`，质量更好可换 `DeepSeek-R1:8B` |
| `cloudAi` | 云端润色，**留空 apiKey 则跳过**。DeepSeek 就填 `api.deepseek.com/v1` + key |

## 发布步骤

1. 按 `queue/_example-game.json` 的格式，为每个游戏建一个清单（真实清单**不要**下划线开头）：

```json
{
  "name": "游戏名",
  "panUrl": "网盘链接",
  "panCode": "提取码",
  "genre": "类型（RPG/动作/冒险…）",
  "platform": "安卓 / PC",
  "tags": ["二次元", "单机"],
  "notes": "给 AI 的备注（汉化、MOD、版本等），可省略",
  "screenshots": ["screenshots/xxx.jpg"]
}
```

- 截图路径相对清单文件，可省略；没有截图就删除 `screenshots` 字段
- 一次可以放多个清单，脚本逐个发布

2. 确认 ollama 已运行：

```bash
ollama list          # 服务默认在 localhost:11434
```

3. 运行：

```bash
node publish-game.mjs
```

成功后帖子立即出现在 `https://kuhai.de5.net/game.html`，清单自动移到 `published/`。

## 失败处理

- 脚本失败会立即停止并打印原因，已发布的不会重复
- 常见原因：网络不通（重试即可）、模型输出解析失败（重跑，或换更大的模型）、账号密码错误
- 纯本地测试文案（不发布）：`curl http://localhost:11434/api/chat ...` 或直接重跑脚本观察

## 定时自动发布（验证稳定后）

例如每天上午 9 点自动处理 queue：

```bash
crontab -e
# 加入（按实际路径）：
0 9 * * * cd /home/zhong/Desktop/project/simple_forum_cf/automation && /usr/bin/node publish-game.mjs >> publish.log 2>&1
```

定时前建议：①queue 里始终备好清单；②云端润色配好 key 质量更稳。

## 约束

- Node 18+ 内置 fetch，**无需 npm install**
- 只调用现有网站 API，不改动后端代码
- 不直接上传 APK，下载用网盘链接（正文内）
- **网盘链接缺提取码不中止发布**：链接照常写进帖子，并且**正文会插入一段「提取码暂缺」
  说明**（不静默），同时在 `queue/_no-code-warnings.json` 留一条警告等人工补码。
  说明文案可用 `config.json` 的 `noCodeNotice` 覆盖，设为空字符串则不加说明。
  （直链、商店页不算网盘，不告警。）见 `node publish-game.mjs --help`
