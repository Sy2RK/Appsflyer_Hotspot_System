#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
COMPOSE_FILE="$ROOT_DIR/infra/docker-compose.yml"
BACKUP_ROOT="${1:-$ROOT_DIR/migration-backups}"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RUN_DIR="${BACKUP_ROOT%/}/clickhouse-repair-$TIMESTAMP"
LOG_DIR="$RUN_DIR/logs"
META_DIR="$RUN_DIR/meta"
CLICKHOUSE_CONTAINER="hotspot-clickhouse"
CLICKHOUSE_VOLUME="infra_clickhouse-data"
PART_LOG_VOLUME="infra_clickhouse-system-part-log"
ASYNC_LOG_VOLUME="infra_clickhouse-system-asynchronous-metric-log"
VOLUME_IMAGE="postgres:16"
MAX_START_ATTEMPTS=3
BACKUP_MODE="${CLICKHOUSE_REPAIR_BACKUP_MODE:-metadata-only}"

mkdir -p "$LOG_DIR" "$META_DIR"

log() {
  echo "[repair] $*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[repair] missing command: $1" >&2
    exit 1
  fi
}

container_exists() {
  docker container inspect "$1" >/dev/null 2>&1
}

save_container_logs() {
  local label="$1"
  if container_exists "$CLICKHOUSE_CONTAINER"; then
    docker logs --tail 4000 "$CLICKHOUSE_CONTAINER" > "$LOG_DIR/docker-$label.log" 2>&1 || true
    cp "$LOG_DIR/docker-$label.log" "$LOG_DIR/clickhouse-server.err.$label.log" 2>/dev/null || true
  fi
}

run_on_clickhouse_volume() {
  local command="$1"
  docker run --rm \
    -v "$CLICKHOUSE_VOLUME:/var/lib/clickhouse" \
    -v "$RUN_DIR:/backup" \
    "$VOLUME_IMAGE" \
    sh -lc "$command"
}

run_on_volume() {
  local volume_name="$1"
  local mount_point="$2"
  local command="$3"
  docker run --rm \
    -v "$volume_name:$mount_point" \
    -v "$RUN_DIR:/backup" \
    "$VOLUME_IMAGE" \
    sh -lc "$command"
}

backup_volume() {
  log "backing up $CLICKHOUSE_VOLUME to $RUN_DIR/infra_clickhouse-data.tar.gz"
  docker run --rm \
    -v "$CLICKHOUSE_VOLUME:/source:ro" \
    -v "$RUN_DIR:/backup" \
    "$VOLUME_IMAGE" \
    sh -lc 'cd /source && tar -czf /backup/infra_clickhouse-data.tar.gz .'
}

capture_metadata() {
  log "capturing lightweight metadata snapshot"
  run_on_clickhouse_volume '
    mkdir -p /backup/meta/system-metadata
    cp -R /var/lib/clickhouse/metadata/system/. /backup/meta/system-metadata/ 2>/dev/null || true
    ls -lh /var/lib/clickhouse/core > /backup/meta/core-before.txt 2>/dev/null || true
    du -sh /var/lib/clickhouse/store > /backup/meta/store-size.txt 2>/dev/null || true
    find /var/lib/clickhouse/store -maxdepth 4 \
      \( -path "*/detached/broken-on-start_*" -o -path "*/detached/recovery-*" \) \
      | sort > /backup/meta/detached-paths.txt 2>/dev/null || true
  '
}

maybe_backup_volume() {
  if [[ "$BACKUP_MODE" == "full" ]]; then
    backup_volume
    return
  fi
  log "skipping full volume backup (CLICKHOUSE_REPAIR_BACKUP_MODE=$BACKUP_MODE)"
}

stop_clickhouse() {
  if container_exists "$CLICKHOUSE_CONTAINER"; then
    log "disabling auto restart for $CLICKHOUSE_CONTAINER"
    docker update --restart=no "$CLICKHOUSE_CONTAINER" >/dev/null || true
    log "stopping $CLICKHOUSE_CONTAINER"
    docker stop "$CLICKHOUSE_CONTAINER" >/dev/null 2>&1 || true
  fi
}

collect_disabled_log_uuid() {
  local table_name="$1"
  run_on_clickhouse_volume "sed -n \"s/.*UUID '\\''\\([^'\\'']*\\)'\\''.*/\\1/p\" /var/lib/clickhouse/metadata/system/$table_name.sql 2>/dev/null | head -n 1"
}

write_disabled_log_map() {
  : > "$META_DIR/disabled-log-uuids.tsv"
  for table_name in part_log asynchronous_metric_log text_log metric_log; do
    local uuid
    uuid=$(collect_disabled_log_uuid "$table_name")
    if [[ -n "$uuid" ]]; then
      printf '%s\t%s\n' "$table_name" "$uuid" >> "$META_DIR/disabled-log-uuids.tsv"
    fi
  done
}

disable_system_log_metadata() {
  log "moving disabled system log metadata out of active metadata directory"
  run_on_clickhouse_volume '
    disabled_dir="/var/lib/clickhouse/metadata_dropped/system_logs_disabled_'"$TIMESTAMP"'"
    mkdir -p "$disabled_dir"
    for table_name in part_log asynchronous_metric_log text_log metric_log; do
      source_file="/var/lib/clickhouse/metadata/system/${table_name}.sql"
      if [ -f "$source_file" ]; then
        mv "$source_file" "$disabled_dir/${table_name}.sql"
      fi
    done
  '
}

remove_core_dump() {
  log "removing ClickHouse core dump if present"
  run_on_clickhouse_volume 'rm -f /var/lib/clickhouse/core'
}

wait_for_clickhouse() {
  local deadline=$((SECONDS + 45))
  while (( SECONDS < deadline )); do
    local status
    status=$(docker inspect "$CLICKHOUSE_CONTAINER" --format '{{.State.Status}}' 2>/dev/null || true)
    if [[ "$status" == "exited" || "$status" == "dead" ]]; then
      return 1
    fi

    local health
    health=$(docker inspect "$CLICKHOUSE_CONTAINER" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || true)
    if [[ "$health" == "healthy" ]]; then
      return 0
    fi
    sleep 2
  done
  return 1
}

start_once() {
  log "starting ClickHouse with current bind-mounted config"
  docker compose -f "$COMPOSE_FILE" up -d --force-recreate clickhouse >/dev/null
  if wait_for_clickhouse; then
    save_container_logs "healthy"
    return 0
  fi
  save_container_logs "failed"
  return 1
}

extract_bad_paths_from_log() {
  local err_log="$1"
  python3 - "$err_log" <<'PY'
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(errors="ignore")
patterns = [
    re.compile(r'Bad message \["(/var/lib/clickhouse/store/[^"]+)"\]'),
    re.compile(r'path (store/[^: ]+)'),
]
paths = []
for pattern in patterns:
    for match in pattern.findall(text):
        if match.startswith("store/"):
            match = "/var/lib/clickhouse/" + match
        paths.append(match.rstrip('/'))
seen = set()
for path in paths:
    if path not in seen:
        seen.add(path)
        print(path)
PY
}

quarantine_bad_parts() {
  local err_log="$1"
  local paths_file="$META_DIR/quarantine-paths.txt"
  extract_bad_paths_from_log "$err_log" > "$paths_file"
  if [[ ! -s "$paths_file" ]]; then
    log "no remaining bad paths found in $err_log"
    return 1
  fi

  log "quarantining remaining bad parts listed in $(basename "$paths_file")"
  docker run --rm \
    -v "$CLICKHOUSE_VOLUME:/var/lib/clickhouse" \
    -v "$RUN_DIR:/backup" \
    "$VOLUME_IMAGE" \
    sh -lc '
      set -eu
      paths_file=/backup/meta/quarantine-paths.txt
      while IFS= read -r original_path; do
        [ -n "$original_path" ] || continue
        [ -e "$original_path" ] || continue
        case "$original_path" in
          */detached/*) continue ;;
        esac
        parent_dir=$(dirname "$original_path")
        base_name=$(basename "$original_path")
        detached_dir="$parent_dir/detached"
        target_path="$detached_dir/manual-quarantine-${base_name}-'"$TIMESTAMP"'"
        mkdir -p "$detached_dir"
        mv "$original_path" "$target_path"
        echo "$original_path -> $target_path"
      done < "$paths_file"
    ' | tee "$LOG_DIR/manual-quarantine.log"
}

cleanup_disabled_log_residue() {
  if [[ ! -f "$META_DIR/disabled-log-uuids.tsv" ]]; then
    return
  fi

  log "cleaning detached recovery residue for disabled system logs"
  while IFS=$'\t' read -r table_name uuid; do
    [[ -n "$table_name" && -n "$uuid" ]] || continue

    if [[ "$table_name" == "part_log" ]]; then
      run_on_volume "$PART_LOG_VOLUME" /mnt/log 'find /mnt/log/detached -maxdepth 1 \( -name "broken-on-start_*" -o -name "recovery-*" \) -exec rm -rf {} + 2>/dev/null || true'
      continue
    fi

    if [[ "$table_name" == "asynchronous_metric_log" ]]; then
      run_on_volume "$ASYNC_LOG_VOLUME" /mnt/log 'find /mnt/log/detached -maxdepth 1 \( -name "broken-on-start_*" -o -name "recovery-*" \) -exec rm -rf {} + 2>/dev/null || true'
      continue
    fi

    run_on_clickhouse_volume "
      store_dir=\$(find /var/lib/clickhouse/store -mindepth 2 -maxdepth 2 -type d -name '$uuid' | head -n 1)
      if [ -n \"\$store_dir\" ] && [ -d \"\$store_dir/detached\" ]; then
        find \"\$store_dir/detached\" -maxdepth 1 \\( -name 'broken-on-start_*' -o -name 'recovery-*' \\) -exec rm -rf {} +
      fi
    "
  done < "$META_DIR/disabled-log-uuids.tsv"
}

verify_business_tables() {
  log "verifying business tables"
  docker exec "$CLICKHOUSE_CONTAINER" clickhouse-client --query "SELECT count() FROM hotspot.raw_events" > "$LOG_DIR/raw_events.count.txt"
  docker exec "$CLICKHOUSE_CONTAINER" clickhouse-client --query "SELECT count() FROM hotspot.metrics_daily" > "$LOG_DIR/metrics_daily.count.txt"
  docker exec "$CLICKHOUSE_CONTAINER" clickhouse-client --query "SELECT count() FROM hotspot.keyword_value_daily_metrics" > "$LOG_DIR/keyword_value_daily_metrics.count.txt"
}

require_cmd docker
require_cmd python3

log "output directory: $RUN_DIR"
log "backup mode: $BACKUP_MODE"
save_container_logs "before"
stop_clickhouse
capture_metadata
maybe_backup_volume
write_disabled_log_map
disable_system_log_metadata
remove_core_dump

attempt=1
recovered=false
while (( attempt <= MAX_START_ATTEMPTS )); do
  log "start attempt $attempt/$MAX_START_ATTEMPTS"
  if start_once; then
    recovered=true
    break
  fi

  failed_err_log="$LOG_DIR/clickhouse-server.err.failed.log"
  if [[ ! -f "$failed_err_log" ]]; then
    break
  fi

  if ! quarantine_bad_parts "$failed_err_log"; then
    break
  fi

  stop_clickhouse
  ((attempt += 1))
done

if [[ "$recovered" != "true" ]]; then
  echo "[repair] ClickHouse did not recover. Inspect $RUN_DIR for backup and logs." >&2
  exit 1
fi

cleanup_disabled_log_residue
verify_business_tables

log "repair completed"
if [[ "$BACKUP_MODE" == "full" ]]; then
  log "backup archive: $RUN_DIR/infra_clickhouse-data.tar.gz"
else
  log "backup archive: skipped (metadata-only mode)"
fi
log "logs directory: $LOG_DIR"
