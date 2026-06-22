#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$SCRIPT_DIR}"

COMPOSE_SERVICE="${COMPOSE_SERVICE:-app}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"
DEPLOY_KEY_PATH="${DEPLOY_KEY_PATH:-$HOME/.ssh/id_ed25519_github_local_ai_images}"

log() {
  printf '[local-ai-images] %s\n' "$*"
}

fail() {
  printf '[local-ai-images] ERROR: %s\n' "$*" >&2
  exit 1
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

image_name() {
  read_env_value LOCAL_AI_IMAGES_IMAGE .env 2>/dev/null || printf 'local-ai-images-legacy:local\n'
}

ensure_artifacts_volume() {
  local volume_name

  volume_name="$(read_env_value LOCAL_AI_IMAGES_ARTIFACTS_VOLUME_NAME .env || true)"
  volume_name="${volume_name:-local-ai-images-legacy_artifacts}"

  if docker volume inspect "$volume_name" >/dev/null 2>&1; then
    log "Artifacts volume exists: $volume_name"
  else
    log "Creating artifacts volume: $volume_name"
    docker volume create "$volume_name" >/dev/null
  fi
}

should_rebuild_for_changed_files() {
  local changed_file

  if [ "${FULL_REBUILD:-false}" = "true" ]; then
    return 0
  fi

  if [ "${SKIP_REBUILD:-false}" = "true" ]; then
    return 1
  fi

  while IFS= read -r changed_file; do
    case "$changed_file" in
      Dockerfile|docker-entrypoint.sh|package.json|package-lock.json)
        return 0
        ;;
    esac
  done < /tmp/local-ai-images-changed-files.txt

  return 1
}

cd "$APP_DIR"

log "Using application directory: $APP_DIR"
log "Using Compose service: $COMPOSE_SERVICE"

require_command git
require_command docker
require_command curl

docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required: docker compose"

before_rev=""
after_rev=""

if [ -d .git ]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    fail "Tracked working tree changes are present. Commit, stash, or revert them before deploying."
  fi

  before_rev="$(git rev-parse HEAD)"

  if [ -z "${GIT_SSH_COMMAND:-}" ] && [ -f "$DEPLOY_KEY_PATH" ]; then
    export GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY_PATH -o IdentitiesOnly=yes"
    log "Using deploy key: $DEPLOY_KEY_PATH"
  fi

  log "Pulling latest git changes"
  git fetch --all --prune
  git pull --ff-only

  after_rev="$(git rev-parse HEAD)"

  if [ "$before_rev" != "$after_rev" ]; then
    git diff --name-only "$before_rev" "$after_rev" > /tmp/local-ai-images-changed-files.txt
  else
    : > /tmp/local-ai-images-changed-files.txt
  fi
else
  log "No .git directory found; skipping git pull for this source package"
  : > /tmp/local-ai-images-changed-files.txt
fi

if [ -n "${GPU_PROFILE:-}" ]; then
  profile_file=".env.${GPU_PROFILE}"

  if [ ! -f "$profile_file" ]; then
    fail "GPU profile not found: $profile_file"
  fi

  log "Activating GPU profile: $profile_file"
  cp "$profile_file" .env
fi

if [ ! -f .env ]; then
  fail ".env is missing. Create it or run with GPU_PROFILE=3090 / GPU_PROFILE=4080-super."
fi

log "Active runtime settings"
grep -E '^(LOCAL_AI_IMAGES_PROJECT_NAME|LOCAL_AI_IMAGES_CONTAINER_NAME|LOCAL_AI_IMAGES_ARTIFACTS_VOLUME_NAME|WEB_BIND_IP|WEB_PORT|GPU_DEVICE_ID)=' .env || true

ensure_artifacts_volume

log "Rendering Compose configuration"
compose config >/tmp/local-ai-images-compose.yml

selected_image="$(image_name)"

if ! docker image inspect "$selected_image" >/dev/null 2>&1; then
  log "Docker image is missing and must be built: $selected_image"
  FULL_REBUILD=true
fi

if should_rebuild_for_changed_files; then
  log "Building Docker image"
  build_args=()
  if [ "${NO_CACHE:-false}" = "true" ]; then
    build_args+=(--no-cache)
  fi
  compose build "${build_args[@]}" "$COMPOSE_SERVICE"
else
  log "Skipping Docker image build; app source is bind-mounted into the container"
  if [ -s /tmp/local-ai-images-changed-files.txt ]; then
    log "Changed files since previous deploy:"
    sed 's/^/[local-ai-images]   /' /tmp/local-ai-images-changed-files.txt
  fi
fi

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

log "Update and restart complete"