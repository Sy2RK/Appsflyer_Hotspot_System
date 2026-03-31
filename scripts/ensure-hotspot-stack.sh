#!/bin/zsh
set -euo pipefail

ROOT_DIR="/Users/sheny2/Workspace/ASA_AppsFlyer_System/hotspot-system"
COMPOSE_FILE="$ROOT_DIR/infra/docker-compose.yml"
LOG_PREFIX="[hotspot-launchd]"

if ! pgrep -f "/Applications/Docker.app" >/dev/null 2>&1; then
  echo "$LOG_PREFIX opening Docker Desktop"
  open -ga Docker
fi

attempt=0
until docker info >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "$LOG_PREFIX docker daemon not ready after waiting" >&2
    exit 1
  fi
  sleep 5
done

cd "$ROOT_DIR"
echo "$LOG_PREFIX ensuring compose services are up"
docker compose -f "$COMPOSE_FILE" up -d
