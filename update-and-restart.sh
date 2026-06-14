#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-local-ai-images}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$SCRIPT_DIR}"

log() {
  printf '[local-ai-images] %s\n' "$*"
}

have_systemd_service() {
  command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "${SERVICE_NAME}.service" --no-legend >/dev/null 2>&1
}

cd "$APP_DIR"
log "Using application directory: $APP_DIR"
log "Using service name: $SERVICE_NAME"

if have_systemd_service; then
  log "Stopping systemd service ${SERVICE_NAME}.service"
  sudo systemctl stop "${SERVICE_NAME}.service"
else
  log "No systemd service named ${SERVICE_NAME}.service was found; attempting best-effort process stop"
  if pgrep -f "$APP_DIR/src/index.ts" >/dev/null 2>&1; then
    pkill -f "$APP_DIR/src/index.ts"
  fi
fi

if [ -d .git ]; then
  log "Pulling latest git changes"
  git fetch --all --prune
  git pull --ff-only
else
  log "No .git directory found; skipping git pull for this source package"
fi

if [ -f package-lock.json ]; then
  log "Installing dependencies with npm ci"
  npm ci
else
  log "package-lock.json not found; installing dependencies with npm install"
  npm install
fi

log "Running validation tests"
npm run validate

log "Building application"
npm run build

if have_systemd_service; then
  log "Reloading systemd and starting ${SERVICE_NAME}.service"
  sudo systemctl daemon-reload
  sudo systemctl start "${SERVICE_NAME}.service"
  sudo systemctl --no-pager --full status "${SERVICE_NAME}.service"
else
  log "Starting application with npm start in the background because systemd service was not found"
  nohup npm start > local-ai-images.log 2>&1 &
  log "Started process $!. Logs: $APP_DIR/local-ai-images.log"
fi

log "Update and restart complete"
