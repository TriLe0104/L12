#!/usr/bin/env bash
set -euo pipefail

: "${PORT:=10000}"

envsubst '${PORT}' \
  < /etc/nginx/templates/po-calendar.conf.template \
  > /etc/nginx/conf.d/po-calendar.conf

cd /app/backend
uvicorn app.main:app --host 127.0.0.1 --port 8000 &
api_pid=$!

cd /app/frontend
HOSTNAME=127.0.0.1 PORT=3000 node server.js &
web_pid=$!

nginx -g 'daemon off;' &
proxy_pid=$!

cleanup() {
  kill "$api_pid" "$web_pid" "$proxy_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait -n "$api_pid" "$web_pid" "$proxy_pid"
