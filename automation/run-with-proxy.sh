#!/bin/bash
# automation/run-with-proxy.sh
# 用法:
#   ./run-with-proxy.sh fetch.mjs steam
#   ./run-with-proxy.sh fetch.mjs galgame
#   ./run-with-proxy.sh fetch.mjs steam --date 2026-10-03
#
# 作用: 加载 .env 里的代理配置，并让 Node 内置 fetch 真正走代理。

set -e

# 切到脚本所在目录，保证相对路径正确
cd "$(dirname "$0")"

# 加载 .env 文件（如果存在）
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
else
    echo "⚠️  未找到 .env 文件，将不使用代理运行"
fi

# 关键: 让 Node v24+ 的内置 fetch 读取 HTTP_PROXY / HTTPS_PROXY
export NODE_USE_ENV_PROXY=1

# 强制优先 IPv4，避免 IPv6 静默超时
export NODE_OPTIONS="${NODE_OPTIONS} --dns-result-order=ipv4first"

echo "🌐 代理: ${HTTPS_PROXY:-<未设置>}"
echo "🚀 执行: node $@"
echo ""

exec node "$@"
