#!/usr/bin/env bash
# Thin wrapper — prefer `sudo docker compose up` / `down` from the repo root.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Wrote .env from .env.example — edit JWT_SECRET, then: sudo docker compose up -d --build"
  exit 1
fi
if docker info >/dev/null 2>&1; then
  exec docker compose --env-file .env "$@"
fi
exec sudo docker compose --env-file .env "$@"
