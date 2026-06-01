#!/usr/bin/env bash
# Build OctoDeck release artifacts into ./output.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-${ROOT_DIR}/output}"
NPM_BIN="${NPM_BIN:-npm}"
GO_BIN="${GO_BIN:-go}"

log() {
  printf '\n\033[1;34m==> %s\033[0m\n' "$*"
}

copy_dir() {
  local src="$1"
  local dest="$2"
  if [ ! -d "$src" ]; then
    printf 'missing directory: %s\n' "$src" >&2
    exit 1
  fi
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  cp -R "$src" "$dest"
}

copy_file() {
  local src="$1"
  local dest="$2"
  if [ ! -f "$src" ]; then
    printf 'missing file: %s\n' "$src" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
}

cd "$ROOT_DIR"

log "Cleaning output directory"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR/server" "$OUTPUT_DIR/frontend" "$OUTPUT_DIR/daemon"

log "Syncing shared generated files"
make sync-types

log "Building server"
"$NPM_BIN" run build

log "Building frontend"
"$NPM_BIN" --prefix web run build

log "Building agent runner"
"$NPM_BIN" --prefix container/agent-runner run build

log "Building daemon"
(cd client/octodeck-daemon && "$GO_BIN" build -o octodeck-daemon .)

log "Collecting server artifact"
copy_dir "$ROOT_DIR/dist" "$OUTPUT_DIR/server/dist"
copy_file "$ROOT_DIR/package.json" "$OUTPUT_DIR/server/package.json"
if [ -f "$ROOT_DIR/package-lock.json" ]; then
  copy_file "$ROOT_DIR/package-lock.json" "$OUTPUT_DIR/server/package-lock.json"
fi

# Keep runtime-relative assets available under the server artifact as well:
# src/web.ts serves ./web/dist and src/routes/daemon.ts serves
# ./client/octodeck-daemon/octodeck-daemon from process.cwd().
copy_dir "$ROOT_DIR/web/dist" "$OUTPUT_DIR/server/web/dist"
copy_file "$ROOT_DIR/client/octodeck-daemon/octodeck-daemon" "$OUTPUT_DIR/server/client/octodeck-daemon/octodeck-daemon"
copy_dir "$ROOT_DIR/container/agent-runner/dist" "$OUTPUT_DIR/server/container/agent-runner/dist"
copy_file "$ROOT_DIR/container/agent-runner/package.json" "$OUTPUT_DIR/server/container/agent-runner/package.json"

log "Collecting frontend artifact"
copy_dir "$ROOT_DIR/web/dist" "$OUTPUT_DIR/frontend/dist"

log "Collecting daemon artifact"
copy_file "$ROOT_DIR/client/octodeck-daemon/octodeck-daemon" "$OUTPUT_DIR/daemon/octodeck-daemon"
chmod +x "$OUTPUT_DIR/daemon/octodeck-daemon" "$OUTPUT_DIR/server/client/octodeck-daemon/octodeck-daemon"

log "Build artifacts ready"
printf '  server:   %s\n' "$OUTPUT_DIR/server"
printf '  frontend: %s\n' "$OUTPUT_DIR/frontend"
printf '  daemon:   %s\n' "$OUTPUT_DIR/daemon"

