#!/bin/bash
# 一键部署脚本：拉代码 + 部署后端 + 更新帖子封面图
# 用法：bash deploy.sh

set -e

cd ~/Desktop/project/simple_forum_cf

echo "=== 1. 拉取最新代码 ==="
git pull origin main

echo "=== 2. 部署后端 ==="
cd backend
node node_modules/wrangler/bin/wrangler.js deploy

echo "=== 3. 更新帖子封面图 ==="

# 门禁拿 token
GATE_TOKEN=$(curl -s -X POST https://api.kuhai.de5.net/api/game/enter \
  -H "Content-Type: application/json" \
  -d '{"password":"利益or节操"}' | jq -r .token)

# 登录管理员
AUTH_TOKEN=$(curl -s -X POST https://api.kuhai.de5.net/api/game/login \
  -H "Content-Type: application/json" \
  -H "X-Gate-Token: $GATE_TOKEN" \
  -d '{"username":"adminstartor","password":"admin@2026"}' | jq -r .token)

echo "登录成功，开始更新帖子..."

# 更新 Perennial Dusk 的帖子（id 19, 20, 29）
for id in 19 20 29; do
  curl -s -X PUT "https://api.kuhai.de5.net/api/admin/game/posts/$id/images" \
    -H "Content-Type: application/json" \
    -H "X-Gate-Token: $GATE_TOKEN" \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -d '{"images":["https://cdn.akamai.steamstatic.com/steam/apps/3470530/header.jpg"]}'
  echo "✅ 更新帖子 $id（Perennial Dusk）"
done

# 更新夏少女 PULLTOP（id 28）
curl -s -X PUT "https://api.kuhai.de5.net/api/admin/game/posts/28/images" \
  -H "Content-Type: application/json" \
  -H "X-Gate-Token: $GATE_TOKEN" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -d '{"images":["https://aka.doubaocdn.com/s/TkQuojiDeu"]}'
echo "✅ 更新帖子 28（夏少女）"

# 更新姫狩りダンジョンマイスター（id 27, 21）
for id in 27 21; do
  curl -s -X PUT "https://api.kuhai.de5.net/api/admin/game/posts/$id/images" \
    -H "Content-Type: application/json" \
    -H "X-Gate-Token: $GATE_TOKEN" \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -d '{"images":["https://aka.doubaocdn.com/s/Z7gRZq6FV9"]}'
  echo "✅ 更新帖子 $id（姫狩りダンジョンマイスター）"
done

# 更新もえなつしらす（id 23, 22）
for id in 23 22; do
  curl -s -X PUT "https://api.kuhai.de5.net/api/admin/game/posts/$id/images" \
    -H "Content-Type: application/json" \
    -H "X-Gate-Token: $GATE_TOKEN" \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -d '{"images":["https://aka.doubaocdn.com/s/d4y7wjMarO"]}'
  echo "✅ 更新帖子 $id（もえなつしらす）"
done

echo ""
echo "=== 全部更新完成！==="
echo "前端地址：https://kuhai.de5.net/game"
