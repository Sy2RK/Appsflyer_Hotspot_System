#!/bin/zsh
set -euo pipefail

ROOT_DIR="/Users/sheny2/Workspace/ASA_AppsFlyer_System/hotspot-system"
COMPOSE_FILE="$ROOT_DIR/infra/docker-compose.yml"
LOG_PREFIX="[hotspot-launchd]"
DOCKER_READY_MAX_ATTEMPTS=180
DOCKER_READY_SLEEP_SECONDS=5
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if ! pgrep -f "/Applications/Docker.app" >/dev/null 2>&1; then
  echo "$LOG_PREFIX opening Docker Desktop"
  open -ga Docker
fi

attempt=0
until docker info >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -eq 1 ] || [ $((attempt % 12)) -eq 0 ]; then
    echo "$LOG_PREFIX waiting for docker daemon (attempt $attempt/$DOCKER_READY_MAX_ATTEMPTS)" >&2
  fi
  if [ "$attempt" -ge "$DOCKER_READY_MAX_ATTEMPTS" ]; then
    echo "$LOG_PREFIX docker daemon not ready after waiting" >&2
    exit 1
  fi
  sleep "$DOCKER_READY_SLEEP_SECONDS"
done

cd "$ROOT_DIR"
echo "$LOG_PREFIX ensuring compose services are up"
docker compose -f "$COMPOSE_FILE" up -d
