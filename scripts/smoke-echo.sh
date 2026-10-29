#!/usr/bin/env bash
# 不依赖 dsh：AGENT_MODE=echo 冒烟 webhook 解析 + 健康检查
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export AGENT_MODE=echo
export BRIDGE_PORT="${BRIDGE_PORT:-8787}"
export WECHAT_CLIENT_BASE_URL="${WECHAT_CLIENT_BASE_URL:-http://127.0.0.1:9}"
npx --yes tsx src/index.ts &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT
sleep 1
curl -sf "http://127.0.0.1:${BRIDGE_PORT}/health" | tee /tmp/bridge-health.json
echo
curl -sf -X POST "http://127.0.0.1:${BRIDGE_PORT}/webhook?robot_id=1&robot_code=demo&robot_wxid=wxid_bot" \
  -H 'Content-Type: application/json' \
  -d '{"AddMsgs":[{"MsgId":1,"NewMsgId":1001,"MsgType":1,"FromUserName":{"string":"wxid_user"},"ToUserName":{"string":"wxid_bot"},"Content":{"string":"你好 dsh"},"CreateTime":1710000000}]}'
echo
echo "smoke ok"
