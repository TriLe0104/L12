#!/usr/bin/env bash
# Thin wrapper — prefer `docker compose up` / `down` from the repo root.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Wrote .env from .env.example — edit JWT_SECRET, then: docker compose up -d --build"
  exit 1
fi
exec docker compose --env-file .env "$@"
