#!/usr/bin/env bash
# DeepSeek Harness Web UI with 免token鉴权 (no launch-token / cookie gate)
set -euo pipefail
export DSH_WEB_NO_TOKEN="${DSH_WEB_NO_TOKEN:-1}"
export DSH_BROWSER_AUTH="${DSH_BROWSER_AUTH:-disabled}"
HOST="${DSH_WEB_HOST:-127.0.0.1}"
PORT="${DSH_WEB_PORT:-3080}"
# Optionally pull API key from bridge .env without reserved launcher keys
if [ -f /opt/dsh-wechat-bridge/.env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|\#*) continue ;;
      DSH_BIN=*|DSH_HOME=*|DSH_PROFILE=*|NODE_OPTIONS=*) continue ;;
      DEEPSEEK_API_KEY=*|DSH_PROVIDER=*|DSH_MODEL=*|DSH_WEB_NO_TOKEN=*|DSH_BROWSER_AUTH=*)
        export "$line" 2>/dev/null || true
        ;;
    esac
  done < /opt/dsh-wechat-bridge/.env
fi
export DSH_WEB_NO_TOKEN=1
export DSH_BROWSER_AUTH=disabled
cd /tmp
if command -v dsh >/dev/null 2>&1; then
  exec dsh web --host "$HOST" --port "$PORT" --no-open "$@"
fi
exec node /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web --host "$HOST" --port "$PORT" --no-open "$@"
