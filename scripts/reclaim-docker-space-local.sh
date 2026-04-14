#!/usr/bin/env bash
set -euo pipefail

DOCKER_RAW="${HOME}/Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[reclaim] missing command: $1" >&2
    exit 1
  fi
}

log() {
  echo "[reclaim] $*"
}

show_usage() {
  if [[ -f "$DOCKER_RAW" ]]; then
    log "Docker.raw actual usage: $(du -sh "$DOCKER_RAW" | awk '{print $1}')"
    log "Docker.raw logical size: $(ls -lh "$DOCKER_RAW" | awk '{print $5}')"
  fi
  df -h /
  docker system df
}

require_cmd docker

log "before reclaim"
show_usage

log "pruning unused build cache"
docker builder prune -af >/dev/null

log "pruning unused images"
docker image prune -af >/dev/null

log "reclaiming sparse disk space back to macOS"
docker run --rm --privileged --pid=host docker/desktop-reclaim-space >/dev/null

log "after reclaim"
show_usage
