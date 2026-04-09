#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
OUTPUT_ROOT="${1:-$ROOT_DIR/migration-backups}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="${OUTPUT_ROOT%/}/hotspot-migration-$TIMESTAMP"
CLICKHOUSE_DIR="$BACKUP_DIR/clickhouse"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[backup] missing command: $1" >&2
    exit 1
  fi
}

require_container() {
  if ! docker ps --format '{{.Names}}' | grep -qx "$1"; then
    echo "[backup] container is not running: $1" >&2
    exit 1
  fi
}

mkdir -p "$CLICKHOUSE_DIR"

require_cmd docker
require_container hotspot-postgres
require_container hotspot-clickhouse

echo "[backup] root: $ROOT_DIR"
echo "[backup] output: $BACKUP_DIR"

if git -C "$ROOT_DIR" rev-parse HEAD >/dev/null 2>&1; then
  git -C "$ROOT_DIR" rev-parse HEAD > "$BACKUP_DIR/git_commit.txt"
fi

docker exec hotspot-postgres sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$BACKUP_DIR/postgres.dump"

docker exec hotspot-clickhouse clickhouse-client --query "
SELECT name
FROM system.tables
WHERE database = 'hotspot'
  AND engine NOT LIKE '%View%'
ORDER BY name
" > "$BACKUP_DIR/clickhouse_tables.txt"

while IFS= read -r table_name; do
  if [[ -z "$table_name" ]]; then
    continue
  fi
  echo "[backup] clickhouse table: $table_name"
  docker exec hotspot-clickhouse clickhouse-client --query "SELECT * FROM hotspot.$table_name FORMAT Native" > "$CLICKHOUSE_DIR/$table_name.native"
done < "$BACKUP_DIR/clickhouse_tables.txt"

tar -C "$(dirname "$BACKUP_DIR")" -czf "$BACKUP_DIR.tar.gz" "$(basename "$BACKUP_DIR")"

echo "[backup] completed"
echo "[backup] directory: $BACKUP_DIR"
echo "[backup] archive: $BACKUP_DIR.tar.gz"
