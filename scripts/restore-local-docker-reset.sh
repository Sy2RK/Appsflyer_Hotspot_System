#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$ROOT_DIR/infra/docker-compose.yml"
INPUT_PATH="${1:-}"
WORK_DIR=""
BACKUP_DIR=""

cleanup() {
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -rf "$WORK_DIR"
  fi
}

trap cleanup EXIT

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[restore-local] missing command: $1" >&2
    exit 1
  fi
}

wait_for_postgres() {
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if docker exec hotspot-postgres sh -lc 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

wait_for_clickhouse() {
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    status=$(docker inspect hotspot-clickhouse --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)
    if [[ "$status" == "healthy" ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if [[ -z "$INPUT_PATH" ]]; then
  echo "Usage: $0 <backup_dir_or_tar_gz>" >&2
  exit 1
fi

if [[ ! -e "$INPUT_PATH" ]]; then
  echo "[restore-local] input not found: $INPUT_PATH" >&2
  exit 1
fi

require_cmd docker

if [[ -f "$INPUT_PATH" ]]; then
  WORK_DIR=$(mktemp -d)
  tar -xzf "$INPUT_PATH" -C "$WORK_DIR"
  BACKUP_DIR=$(find "$WORK_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)
else
  BACKUP_DIR="$INPUT_PATH"
fi

if [[ ! -f "$BACKUP_DIR/postgres.dump" ]]; then
  echo "[restore-local] missing postgres.dump in $BACKUP_DIR" >&2
  exit 1
fi

if [[ -f "$BACKUP_DIR/.env" ]]; then
  cp "$BACKUP_DIR/.env" "$ROOT_DIR/.env"
  chmod 600 "$ROOT_DIR/.env"
fi

echo "[restore-local] starting postgres + clickhouse"
docker compose -f "$COMPOSE_FILE" up -d postgres clickhouse >/dev/null

echo "[restore-local] waiting for postgres"
wait_for_postgres || { echo "[restore-local] postgres not ready" >&2; exit 1; }

echo "[restore-local] waiting for clickhouse"
wait_for_clickhouse || { echo "[restore-local] clickhouse not healthy" >&2; exit 1; }

echo "[restore-local] restoring databases"
"$SCRIPT_DIR/restore-cloud-migration.sh" "$INPUT_PATH"

echo "[restore-local] starting full stack"
docker compose -f "$COMPOSE_FILE" up -d >/dev/null

echo "[restore-local] completed"
echo "[restore-local] verify with: curl http://127.0.0.1:3000/ready"
