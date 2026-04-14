#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
OUTPUT_ROOT="${1:-$ROOT_DIR/migration-backups}"

require_file() {
  if [[ ! -f "$1" ]]; then
    echo "[backup-local] missing file: $1" >&2
    exit 1
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[backup-local] missing command: $1" >&2
    exit 1
  fi
}

require_cmd docker
require_file "$ROOT_DIR/.env"

before_latest=$(find "$OUTPUT_ROOT" -maxdepth 1 -type d -name 'hotspot-migration-*' 2>/dev/null | sort | tail -n 1 || true)

"$SCRIPT_DIR/backup-cloud-migration.sh" "$OUTPUT_ROOT"

latest_dir=$(find "$OUTPUT_ROOT" -maxdepth 1 -type d -name 'hotspot-migration-*' 2>/dev/null | sort | tail -n 1 || true)
if [[ -z "$latest_dir" || "$latest_dir" == "$before_latest" ]]; then
  echo "[backup-local] unable to locate latest backup directory" >&2
  exit 1
fi

cp "$ROOT_DIR/.env" "$latest_dir/.env"
chmod 600 "$latest_dir/.env"

echo "[backup-local] completed"
echo "[backup-local] backup dir: $latest_dir"
echo "[backup-local] restore with: ./scripts/restore-local-docker-reset.sh \"$latest_dir\""
