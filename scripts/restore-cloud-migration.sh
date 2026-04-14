#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
INPUT_PATH="${1:-}"
WORK_DIR=""
BACKUP_DIR=""
STOPPED_CONTAINERS=()

cleanup() {
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
    rm -rf "$WORK_DIR"
  fi
}

trap cleanup EXIT

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[restore] missing command: $1" >&2
    exit 1
  fi
}

require_container() {
  if ! docker ps --format '{{.Names}}' | grep -qx "$1"; then
    echo "[restore] container is not running: $1" >&2
    exit 1
  fi
}

stop_container_if_running() {
  local name="$1"
  if docker ps --format '{{.Names}}' | grep -qx "$name"; then
    echo "[restore] stopping container: $name"
    docker stop "$name" >/dev/null
    STOPPED_CONTAINERS+=("$name")
  fi
}

if [[ -z "$INPUT_PATH" ]]; then
  echo "Usage: $0 <backup_dir_or_tar_gz>" >&2
  exit 1
fi

if [[ ! -e "$INPUT_PATH" ]]; then
  echo "[restore] input not found: $INPUT_PATH" >&2
  exit 1
fi

require_cmd docker
require_container hotspot-postgres
require_container hotspot-clickhouse

if [[ -f "$INPUT_PATH" ]]; then
  WORK_DIR=$(mktemp -d)
  tar -xzf "$INPUT_PATH" -C "$WORK_DIR"
  extracted_dirs=$(find "$WORK_DIR" -mindepth 1 -maxdepth 1 -type d)
  BACKUP_DIR=$(echo "$extracted_dirs" | head -n 1)
else
  BACKUP_DIR="$INPUT_PATH"
fi

if [[ ! -f "$BACKUP_DIR/postgres.dump" ]]; then
  echo "[restore] missing postgres.dump in $BACKUP_DIR" >&2
  exit 1
fi

if [[ ! -f "$BACKUP_DIR/clickhouse_tables.txt" ]]; then
  echo "[restore] missing clickhouse_tables.txt in $BACKUP_DIR" >&2
  exit 1
fi

echo "[restore] root: $ROOT_DIR"
echo "[restore] source: $BACKUP_DIR"

if [[ -f "$BACKUP_DIR/git_commit.txt" ]]; then
  backup_commit=$(tr -d '[:space:]' < "$BACKUP_DIR/git_commit.txt")
  if git -C "$ROOT_DIR" rev-parse HEAD >/dev/null 2>&1; then
    current_commit=$(git -C "$ROOT_DIR" rev-parse HEAD | tr -d '[:space:]')
    if [[ "$backup_commit" != "$current_commit" ]]; then
      if [[ "${HOTSPOT_ALLOW_COMMIT_MISMATCH:-false}" != "true" ]]; then
        echo "[restore] git commit mismatch" >&2
        echo "[restore] backup commit : $backup_commit" >&2
        echo "[restore] current commit: $current_commit" >&2
        echo "[restore] aborting; set HOTSPOT_ALLOW_COMMIT_MISMATCH=true only if you have manually verified schema compatibility" >&2
        exit 1
      fi
      echo "[restore] git commit mismatch ignored by HOTSPOT_ALLOW_COMMIT_MISMATCH=true" >&2
    fi
  else
    echo "[restore] warning: repository is not a git checkout; skipping commit verification" >&2
  fi
fi

for container_name in \
  hotspot-caddy \
  hotspot-api \
  hotspot-mcp-server \
  hotspot-aggregator \
  hotspot-detector \
  hotspot-puller \
  hotspot-keyword-engine \
  hotspot-budget-advisor \
  hotspot-asa-keywords \
  hotspot-asa-daily-brief \
  hotspot-daily-brief \
  hotspot-bitable-export \
  hotspot-bitable-feedback-sync
do
  stop_container_if_running "$container_name"
done

docker exec -i hotspot-postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$ROOT_DIR/infra/postgres/init.sql"
docker exec -i hotspot-clickhouse clickhouse-client -n < "$ROOT_DIR/infra/clickhouse/init.sql"

echo "[restore] postgres"
docker exec -i hotspot-postgres sh -lc 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges' < "$BACKUP_DIR/postgres.dump"

echo "[restore] clickhouse"
while IFS= read -r table_name; do
  if [[ -z "$table_name" ]]; then
    continue
  fi
  native_file="$BACKUP_DIR/clickhouse/$table_name.native"
  if [[ ! -f "$native_file" ]]; then
    echo "[restore] skip missing table file: $native_file" >&2
    continue
  fi
  if [[ ! -s "$native_file" ]]; then
    echo "[restore] skip empty table file: $native_file" >&2
    continue
  fi
  echo "[restore] clickhouse table: $table_name"
  docker exec hotspot-clickhouse clickhouse-client --query "TRUNCATE TABLE hotspot.$table_name"
  docker exec -i hotspot-clickhouse clickhouse-client --query "INSERT INTO hotspot.$table_name FORMAT Native" < "$native_file"
done < "$BACKUP_DIR/clickhouse_tables.txt"

echo "[restore] completed"
if [[ ${#STOPPED_CONTAINERS[@]} -gt 0 ]]; then
  echo "[restore] business containers were stopped and left stopped for safety:"
  printf '  - %s\n' "${STOPPED_CONTAINERS[@]}"
  echo "[restore] start them manually after verification"
fi
