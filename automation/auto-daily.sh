#!/usr/bin/env bash
# ============================================================
# 苦海 · 每日自动发布流水线
#   检查 ollama → 抓取 galgame 子站 → 自动审核 → ollama 写文案 → 发帖
#   日志写入 automation/logs/YYYY-MM-DD.log
#
# 用法：
#   ./auto-daily.sh            # 正常跑（发布）
#   ./auto-daily.sh --dry      # 只抓不发（调试用）
# ============================================================
set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

LOG_DIR="$DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d).log"

PROXY="${HTTPS_PROXY:-http://127.0.0.1:7890}"

log() {
  echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# ---------- 参数 ----------
MODE="publish"
if [[ "${1:-}" == "--dry" ]]; then
  MODE="dry"
fi

log "=========================================="
log "每日自动流水线启动（模式: $MODE）"

# ---------- 1. 检查 ollama ----------
if ! curl -s --max-time 3 http://localhost:11434/api/tags > /dev/null 2>&1; then
  log "❌ ollama 未运行（localhost:11434），尝试启动..."
  systemctl --user start ollama 2>/dev/null || ollama serve > /dev/null 2>&1 &
  sleep 3
  if ! curl -s --max-time 3 http://localhost:11434/api/tags > /dev/null 2>&1; then
    log "❌ ollama 启动失败，退出。请手动运行 ollama serve"
    exit 1
  fi
fi
log "✅ ollama 正常"

# ---------- 2. 检查代理 ----------
export HTTPS_PROXY="$PROXY" HTTP_PROXY="$PROXY"
if curl -s --max-time 8 -x "$PROXY" https://www.google.com -o /dev/null; then
  log "✅ 代理正常: $PROXY"
else
  log "⚠️  代理 $PROXY 不通，可能抓取国外站失败（继续尝试直连）"
  unset HTTPS_PROXY HTTP_PROXY
fi

# ---------- 3. 跑流水线 ----------
PUBLISH_FLAG=""
if [[ "$MODE" == "publish" ]]; then
  PUBLISH_FLAG="--publish"
fi

log "▶ 开始抓取 + 生成清单 + 发布..."
node run-new-source.mjs $PUBLISH_FLAG >> "$LOG_FILE" 2>&1
RC=$?

if [[ $RC -eq 0 ]]; then
  log "✅ 流水线完成"
else
  log "❌ 流水线退出码 $RC，查看上方日志定位错误"
fi

log "=========================================="
exit $RC
