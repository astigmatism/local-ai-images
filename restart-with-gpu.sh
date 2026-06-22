#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
COMPOSE_SERVICE="${COMPOSE_SERVICE:-app}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"

log() {
  printf '[local-ai-images] %s\n' "$*"
}

fail() {
  printf '[local-ai-images] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  ./restart-with-gpu.sh <gpu>

Available GPU names:
  3090
  rtx-3090
  4080-super
  4080
  rtx-4080-super

Examples:
  ./restart-with-gpu.sh 3090
  ./restart-with-gpu.sh 4080-super

What this does:
  1. Copies the matching .env.<profile> file to .env
  2. Recreates the Docker Compose app container
  3. Waits for the container to become healthy
  4. Prints the GPU visible inside the container

This script does not pull git changes and does not rebuild the Docker image.
Use update-and-restart.sh for application code deployments.
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

read_env_value() {
  local key="$1"
  local file="${2:-.env}"

  if [ ! -f "$file" ]; then
    return 1
  fi

  grep -E "^${key}=" "$file" | tail -n 1 | cut -d '=' -f 2-
}

compose() {
  docker compose "$@"
}

resolve_profile_file() {
  local requested="$1"

  case "$requested" in
    3090|rtx-3090|RTX-3090)
      printf '.env.3090\n'
      ;;
    4080|4080-super|rtx-4080-super|RTX-4080-SUPER)
      printf '.env.4080-super\n'
      ;;
    *)
      return 1
      ;;
  esac
}

wait_for_container_health() {
  local container_id="$1"
  local deadline
  local status

  deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))

  while [ "$SECONDS" -lt "$deadline" ]; do
    status="$(
      docker inspect "$container_id" \
        --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        2>/dev/null || true
    )"

    log "Container health: ${status:-unknown}"

    if [ "$status" = "healthy" ] || [ "$status" = "running" ]; then
      return 0
    fi

    if [ "$status" = "unhealthy" ] || [ "$status" = "exited" ] || [ "$status" = "dead" ]; then
      return 1
    fi

    sleep 2
  done

  return 1
}

build_health_url() {
  local bind_ip
  local web_port
  local host

  bind_ip="$(read_env_value WEB_BIND_IP .env || true)"
  web_port="$(read_env_value WEB_PORT .env || true)"

  host="${bind_ip:-127.0.0.1}"
  web_port="${web_port:-8000}"

  if [ "$host" = "0.0.0.0" ]; then
    host="127.0.0.1"
  fi

  printf 'http://%s:%s/health\n' "$host" "$web_port"
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ "${1:-}" = "help" ]; then
  usage
  exit 0
fi

if [ "$#" -lt 1 ]; then
  usage
  exit 1
fi

requested_gpu="$1"

profile_file="$(resolve_profile_file "$requested_gpu" || true)"
if [ -z "$profile_file" ]; then
  usage
  fail "Unknown GPU profile: $requested_gpu"
fi

cd "$APP_DIR"

require_command docker
require_command curl

docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required: docker compose"

if [ ! -f "$profile_file" ]; then
  fail "GPU profile file not found: $profile_file"
fi

log "Using application directory: $APP_DIR"
log "Using Compose service: $COMPOSE_SERVICE"
log "Activating GPU profile: $profile_file"

cp "$profile_file" .env

log "Active runtime settings"
grep -E '^(LOCAL_AI_IMAGES_PROJECT_NAME|LOCAL_AI_IMAGES_CONTAINER_NAME|LOCAL_AI_IMAGES_ARTIFACTS_VOLUME_NAME|WEB_BIND_IP|WEB_PORT|GPU_DEVICE_ID)=' .env || true

log "Recreating Docker container"
compose up -d --force-recreate "$COMPOSE_SERVICE"

container_id="$(compose ps -q "$COMPOSE_SERVICE")"
if [ -z "$container_id" ]; then
  fail "Could not resolve container id for Compose service: $COMPOSE_SERVICE"
fi

log "Waiting for container readiness"
if ! wait_for_container_health "$container_id"; then
  log "Recent container logs:"
  compose logs --tail 120 "$COMPOSE_SERVICE" || true
  fail "Container did not become healthy"
fi

health_url="${HEALTH_URL:-$(build_health_url)}"
log "Checking health endpoint: $health_url"
curl -fsS "$health_url" >/tmp/local-ai-images-health.json

log "Container status"
compose ps "$COMPOSE_SERVICE"

log "Visible GPU inside container"
compose exec -T "$COMPOSE_SERVICE" nvidia-smi --query-gpu=index,uuid,name,memory.total,memory.free --format=csv || true

log "GPU restart complete"