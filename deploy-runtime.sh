#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$SCRIPT_DIR}"
COMPOSE_SERVICE="${COMPOSE_SERVICE:-app}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-240}"

log() {
  printf '[local-ai-images] %s\n' "$*"
}

fail() {
  printf '[local-ai-images] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF_USAGE'
Usage:
  ./deploy-runtime.sh list
  ./deploy-runtime.sh plan --gpu-device-ids <GPU-UUID> --model <checkpoint>
  ./deploy-runtime.sh deploy --gpu-device-ids <GPU-UUID> --model <checkpoint>
  ./deploy-runtime.sh <GPU-UUID> <checkpoint>
  ./deploy-runtime.sh help

GPU assignment:
  local-ai-images has exactly one schedulable GPU slot.

  Deployment accepts full NVIDIA GPU UUIDs only, for example:
    GPU-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

  Do not pass GPU numeric indexes, GPU model names, friendly aliases, or "all".
  A scheduler or operator should run list/discovery first, select an installed GPU
  UUID, and then pass that UUID to plan or deploy.

Checkpoint argument:
  Pass a checkpoint filename from the checkpoints directory.
  The .safetensors suffix may be omitted when the name resolves uniquely.

Examples:
  ./deploy-runtime.sh list
  ./deploy-runtime.sh plan --gpu-device-ids GPU-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx --model waiIllustriousSDXL_v170.safetensors
  ./deploy-runtime.sh deploy --gpu-device-ids GPU-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx --model waiIllustriousSDXL_v170.safetensors
  ./deploy-runtime.sh GPU-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx waiIllustriousSDXL_v170.safetensors

What deploy does:
  1. Validates the requested GPU UUID against live host nvidia-smi inventory.
  2. Resolves the checkpoint argument from the checkpoints directory.
  3. Generates the active .env file.
  4. Ensures the persistent artifact volume exists.
  5. Renders and validates Docker Compose configuration.
  6. Recreates the Docker Compose app container without rebuilding the image.
  7. Waits for health.
  8. Sets the selected checkpoint as the app default through the local API.
  9. Optionally ensures the selected checkpoint is loaded.
  10. Prints the container status and visible GPU inside the container.

What plan does:
  1. Validates the requested GPU UUID against live host nvidia-smi inventory.
  2. Resolves the checkpoint argument from the checkpoints directory.
  3. Prints the generated runtime values that would be used.
  4. Makes no filesystem, Docker, Compose, or API changes.

Environment overrides:
  APP_DIR=/path/to/repo
  COMPOSE_SERVICE=app
  AI_ROOT=/home/astigmatism/ai
  CHECKPOINT_DIR=/custom/checkpoints
  WEB_BIND_IP=192.168.1.21
  WEB_PORT=8000
  PRELOAD_MODEL=true
  PRELOAD_WIDTH=512
  PRELOAD_HEIGHT=512
  PRELOAD_STEPS=1
  PRELOAD_WAIT_TIMEOUT_SECONDS=240
EOF_USAGE
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

read_env_or_default() {
  local key="$1"
  local default_value="$2"
  local value

  value="$(read_env_value "$key" .env 2>/dev/null || true)"

  if [ -n "$value" ]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$default_value"
  fi
}

compose() {
  docker compose "$@"
}

list_gpus() {
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "nvidia-smi not found on host."
    return 0
  fi

  echo "Detected host GPUs:"
  nvidia-smi --query-gpu=index,uuid,name,memory.total,memory.free --format=csv
  echo
  echo "Deploy inputs must use the uuid value exactly. Do not use index or name values as deploy arguments."
}

validate_single_gpu_device_id() {
  local requested="$1"

  if [ -z "$requested" ]; then
    fail "GPU device ID is required."
  fi

  if [ "$requested" = "all" ] || [ "$requested" = "ALL" ]; then
    fail "local-ai-images requires exactly one GPU UUID. The value 'all' is not allowed."
  fi

  if [[ "$requested" == *,* ]]; then
    fail "local-ai-images requires exactly one GPU UUID, but received a comma-separated value: $requested"
  fi

  case "$requested" in
    GPU-*)
      ;;
    *)
      fail "GPU assignment must be a full NVIDIA GPU UUID beginning with GPU-. Received: $requested"
      ;;
  esac

  case "$requested" in
    *[[:space:]]*)
      fail "GPU UUID must not contain whitespace. Received: $requested"
      ;;
  esac

  python3 - "$requested" <<'PY'
import csv
import subprocess
import sys

requested = sys.argv[1].strip()

try:
    raw = subprocess.check_output(
        [
            "nvidia-smi",
            "--query-gpu=index,uuid,name,memory.total,memory.free",
            "--format=csv,noheader",
        ],
        text=True,
    )
except FileNotFoundError:
    print("nvidia-smi not found on host", file=sys.stderr)
    sys.exit(2)
except subprocess.CalledProcessError as exc:
    print(f"nvidia-smi failed: {exc}", file=sys.stderr)
    sys.exit(2)

gpus = []
for row in csv.reader(raw.splitlines()):
    if len(row) < 5:
        continue

    index = row[0].strip()
    uuid = row[1].strip()
    name = row[2].strip()
    memory_total = row[3].strip()
    memory_free = row[4].strip()
    gpus.append(
        {
            "index": index,
            "uuid": uuid,
            "name": name,
            "memory_total": memory_total,
            "memory_free": memory_free,
        }
    )

if not gpus:
    print("No GPUs were returned by nvidia-smi", file=sys.stderr)
    sys.exit(2)

for gpu in gpus:
    if gpu["uuid"].lower() == requested.lower():
        print(gpu["uuid"])
        sys.exit(0)

print(f"GPU UUID is not installed on this host: {requested}", file=sys.stderr)
print("Available GPU UUIDs:", file=sys.stderr)
for gpu in gpus:
    print(
        f"  {gpu['uuid']} | index={gpu['index']} | {gpu['name']} | "
        f"total={gpu['memory_total']} | free={gpu['memory_free']}",
        file=sys.stderr,
    )

sys.exit(1)
PY
}

list_checkpoints() {
  local checkpoint_dir="$1"

  echo
  echo "Checkpoint directory:"
  echo "  $checkpoint_dir"
  echo

  if [ ! -d "$checkpoint_dir" ]; then
    echo "Checkpoint directory does not exist."
    return 0
  fi

  find "$checkpoint_dir" -maxdepth 1 -type f \
    \( -name '*.safetensors' -o -name '*.ckpt' \) \
    -printf '%f\n' | sort
}

resolve_checkpoint() {
  local requested="$1"
  local checkpoint_dir="$2"
  local candidate
  local matches=()

  [ -d "$checkpoint_dir" ] || fail "Checkpoint directory does not exist: $checkpoint_dir"

  candidate="$checkpoint_dir/$requested"
  if [ -f "$candidate" ]; then
    basename "$candidate"
    return 0
  fi

  candidate="$checkpoint_dir/${requested}.safetensors"
  if [ -f "$candidate" ]; then
    basename "$candidate"
    return 0
  fi

  mapfile -t matches < <(
    find "$checkpoint_dir" -maxdepth 1 -type f \
      \( -name "${requested}*.safetensors" -o -name "${requested}*.ckpt" \) \
      -printf '%f\n' | sort
  )

  if [ "${#matches[@]}" -eq 1 ]; then
    printf '%s\n' "${matches[0]}"
    return 0
  fi

  if [ "${#matches[@]}" -gt 1 ]; then
    log "Checkpoint name is ambiguous: $requested"
    printf '%s\n' "${matches[@]}" | sed 's/^/[local-ai-images]   /'
    fail "Pass the full checkpoint filename."
  fi

  fail "Checkpoint not found: $requested"
}

write_env_file() {
  local gpu_uuid="$1"
  local checkpoint_file="$2"
  local ai_root="$3"
  local tmp_file

  tmp_file="$(mktemp)"

  {
    echo "# Generated by deploy-runtime.sh"
    echo "# Do not edit GPU/model assignment here by hand; rerun deploy-runtime.sh."
    echo

    printf 'LOCAL_AI_IMAGES_PROJECT_NAME=%s\n' "$(read_env_or_default LOCAL_AI_IMAGES_PROJECT_NAME local-ai-images-legacy)"
    printf 'LOCAL_AI_IMAGES_CONTAINER_NAME=%s\n' "$(read_env_or_default LOCAL_AI_IMAGES_CONTAINER_NAME local-ai-images-legacy)"
    printf 'LOCAL_AI_IMAGES_ARTIFACTS_VOLUME_NAME=%s\n' "$(read_env_or_default LOCAL_AI_IMAGES_ARTIFACTS_VOLUME_NAME local-ai-images-legacy_artifacts)"
    printf 'LOCAL_AI_IMAGES_IMAGE=%s\n' "$(read_env_or_default LOCAL_AI_IMAGES_IMAGE local-ai-images-legacy:local)"
    echo

    printf 'AI_ROOT=%s\n' "$ai_root"
    printf 'WEB_BIND_IP=%s\n' "${WEB_BIND_IP:-$(read_env_or_default WEB_BIND_IP 192.168.1.21)}"
    printf 'WEB_PORT=%s\n' "${WEB_PORT:-$(read_env_or_default WEB_PORT 8000)}"
    echo

    printf 'GPU_DEVICE_ID=%s\n' "$gpu_uuid"
    echo

    echo "IMAGE_GENERATION_ENABLED=true"
    echo "IMAGE_BACKEND=comfyui"
    echo "COMFYUI_BASE_URL=http://host.docker.internal:8188"
    echo

    echo "REQUIRE_IMAGE_API_AUTH=false"
    echo "IMAGE_API_KEYS="
    echo

    echo "IMAGE_DEFAULT_WORKFLOW_ID=sdxl-text-to-image"
    printf 'IMAGE_DEFAULT_MODEL=%s\n' "$checkpoint_file"
    echo "IMAGE_PRELOAD_DEFAULT_ON_STARTUP=false"
    echo "IMAGE_PRELOAD_TIMEOUT_MS=120000"
    echo "IMAGE_PRELOAD_WORKFLOW_ID=sdxl-text-to-image"
    printf 'IMAGE_PRELOAD_WIDTH=%s\n' "${PRELOAD_WIDTH:-$(read_env_or_default IMAGE_PRELOAD_WIDTH 512)}"
    printf 'IMAGE_PRELOAD_HEIGHT=%s\n' "${PRELOAD_HEIGHT:-$(read_env_or_default IMAGE_PRELOAD_HEIGHT 512)}"
    printf 'IMAGE_PRELOAD_STEPS=%s\n' "${PRELOAD_STEPS:-$(read_env_or_default IMAGE_PRELOAD_STEPS 1)}"
    echo "IMAGE_PRELOAD_KEEP_ARTIFACT=false"
    echo "IMAGE_QUEUE_CONCURRENCY=1"
    echo "IMAGE_MAX_QUEUED_JOBS=32"
    echo

    echo "MODEL_INSTALLS_ENABLED=false"
    echo "MODEL_INSTALL_ALLOW_CKPT=false"
    echo "LEGACY_OLLAMA_ENABLED=false"
  } > "$tmp_file"

  mv "$tmp_file" .env
}

print_runtime_plan() {
  local gpu_uuid="$1"
  local checkpoint_file="$2"
  local ai_root="$3"

  log "Runtime deployment plan"
  printf '[local-ai-images]   APP_DIR=%s\n' "$APP_DIR"
  printf '[local-ai-images]   COMPOSE_SERVICE=%s\n' "$COMPOSE_SERVICE"
  printf '[local-ai-images]   AI_ROOT=%s\n' "$ai_root"
  printf '[local-ai-images]   WEB_BIND_IP=%s\n' "${WEB_BIND_IP:-$(read_env_or_default WEB_BIND_IP 192.168.1.21)}"
  printf '[local-ai-images]   WEB_PORT=%s\n' "${WEB_PORT:-$(read_env_or_default WEB_PORT 8000)}"
  printf '[local-ai-images]   GPU_DEVICE_ID=%s\n' "$gpu_uuid"
  printf '[local-ai-images]   IMAGE_DEFAULT_MODEL=%s\n' "$checkpoint_file"
  printf '[local-ai-images]   PRELOAD_MODEL=%s\n' "${PRELOAD_MODEL:-true}"
  printf '[local-ai-images]   IMAGE_PRELOAD_WIDTH=%s\n' "${PRELOAD_WIDTH:-$(read_env_or_default IMAGE_PRELOAD_WIDTH 512)}"
  printf '[local-ai-images]   IMAGE_PRELOAD_HEIGHT=%s\n' "${PRELOAD_HEIGHT:-$(read_env_or_default IMAGE_PRELOAD_HEIGHT 512)}"
  printf '[local-ai-images]   IMAGE_PRELOAD_STEPS=%s\n' "${PRELOAD_STEPS:-$(read_env_or_default IMAGE_PRELOAD_STEPS 1)}"

  echo
  echo "Selected GPU detail:"
  nvidia-smi --query-gpu=uuid,name,memory.total,memory.free --format=csv,noheader \
    | awk -F ', ' -v uuid="$gpu_uuid" '$1 == uuid { printf "  %s | %s | total=%s | free=%s\n", $1, $2, $3, $4 }'
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

wait_for_container_health() {
  local container_id="$1"
  local deadline
  local status

  deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))

  while [ "$SECONDS" -lt "$deadline" ]; do
    status="$(
      docker inspect "$container_id" \
        --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
        2>/dev/null || true)"

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

build_base_url() {
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

  printf 'http://%s:%s\n' "$host" "$web_port"
}

set_default_model_via_api() {
  local base_url="$1"
  local checkpoint_file="$2"

  python3 - "$checkpoint_file" >/tmp/local-ai-images-set-default.json <<'PY'
import json
import sys

print(json.dumps({"model": sys.argv[1]}))
PY

  curl -fsS -X POST \
    -H "content-type: application/json" \
    -d @/tmp/local-ai-images-set-default.json \
    "$base_url/api/v1/models/default" >/tmp/local-ai-images-set-default-response.json
}

ensure_model_loaded_via_api() {
  local base_url="$1"
  local checkpoint_file="$2"
  local timeout_seconds="${PRELOAD_WAIT_TIMEOUT_SECONDS:-240}"
  local preload_width
  local preload_height
  local preload_steps

  preload_width="${PRELOAD_WIDTH:-$(read_env_or_default IMAGE_PRELOAD_WIDTH 512)}"
  preload_height="${PRELOAD_HEIGHT:-$(read_env_or_default IMAGE_PRELOAD_HEIGHT 512)}"
  preload_steps="${PRELOAD_STEPS:-$(read_env_or_default IMAGE_PRELOAD_STEPS 1)}"

  python3 - "$base_url" "$checkpoint_file" "$timeout_seconds" "$preload_width" "$preload_height" "$preload_steps" <<'PY'
import json
import sys
import time
import urllib.error
import urllib.request

base_url = sys.argv[1].rstrip("/")
checkpoint_file = sys.argv[2]
timeout_seconds = int(sys.argv[3])
preload_width = int(sys.argv[4])
preload_height = int(sys.argv[5])
preload_steps = int(sys.argv[6])

preload_payload = json.dumps({
    "workflow_id": "sdxl-text-to-image",
    "width": preload_width,
    "height": preload_height,
    "steps": preload_steps,
    "keep_artifact": False,
}).encode("utf-8")


def request_json(method, path, payload=None):
    req = urllib.request.Request(
        f"{base_url}{path}",
        data=payload,
        method=method,
        headers={"content-type": "application/json"},
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            body = response.read().decode("utf-8")
            return response.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(body) if body else {}
        except json.JSONDecodeError:
            parsed = {"raw": body}
        return exc.code, parsed


def health_preload_state():
    status, data = request_json("GET", "/health")
    if status < 200 or status >= 300:
        raise RuntimeError(f"health returned HTTP {status}: {data}")

    models = data.get("models", {})
    preload = models.get("preload", {}) or {}

    return {
        "default_model": models.get("default_model"),
        "current_default": preload.get("currentDefaultCheckpoint") or preload.get("current_default_checkpoint"),
        "active": bool(preload.get("active")),
        "last_result": preload.get("lastPreloadResult") or preload.get("last_preload_result"),
        "last_error": preload.get("lastPreloadError") or preload.get("last_preload_error"),
        "last_model": preload.get("lastPreloadModel") or preload.get("last_preload_model"),
        "confirmed": preload.get("lastConfirmedLoadedModel") or preload.get("last_confirmed_loaded_model"),
    }


def is_loaded(state):
    return state.get("confirmed") == checkpoint_file and not state.get("active")


def print_state(prefix, state):
    print(
        f"[local-ai-images] {prefix}: "
        f"default={state.get('default_model')} "
        f"current={state.get('current_default')} "
        f"confirmed={state.get('confirmed')} "
        f"active={state.get('active')} "
        f"last_result={state.get('last_result')}"
    )


deadline = time.time() + timeout_seconds

state = health_preload_state()
print_state("preload state before request", state)

if is_loaded(state):
    print(f"[local-ai-images] Selected checkpoint is already loaded: {checkpoint_file}")
    sys.exit(0)

while state.get("active") and time.time() < deadline:
    print("[local-ai-images] Preload is already active; waiting before making another preload request")
    time.sleep(2)
    state = health_preload_state()
    print_state("preload state while waiting", state)

    if is_loaded(state):
        print(f"[local-ai-images] Selected checkpoint is loaded: {checkpoint_file}")
        sys.exit(0)

status, response = request_json("POST", "/api/v1/models/preload", preload_payload)

if status == 409:
    print(f"[local-ai-images] Preload endpoint returned 409; treating as busy and polling health: {response}")
elif status < 200 or status >= 300:
    raise RuntimeError(f"preload returned HTTP {status}: {response}")
else:
    print("[local-ai-images] Preload request accepted")

while time.time() < deadline:
    time.sleep(2)
    state = health_preload_state()
    print_state("preload state after request", state)

    if is_loaded(state):
        print(f"[local-ai-images] Selected checkpoint is loaded: {checkpoint_file}")
        sys.exit(0)

    if not state.get("active") and state.get("last_result") == "failed":
        raise RuntimeError(f"preload failed: {state.get('last_error')}")

raise RuntimeError(f"Timed out waiting for checkpoint to load: {checkpoint_file}")
PY
}

parse_plan_or_deploy_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --gpu-device-ids)
        shift
        [ "$#" -gt 0 ] || fail "--gpu-device-ids requires a value"
        REQUESTED_GPU_DEVICE_IDS="$1"
        ;;
      --gpu-device-id)
        shift
        [ "$#" -gt 0 ] || fail "--gpu-device-id requires a value"
        REQUESTED_GPU_DEVICE_IDS="$1"
        ;;
      --model|--checkpoint)
        shift
        [ "$#" -gt 0 ] || fail "--model requires a value"
        REQUESTED_MODEL="$1"
        ;;
      -h|--help|help)
        usage
        exit 0
        ;;
      *)
        fail "Unknown argument: $1"
        ;;
    esac
    shift
  done

  [ -n "${REQUESTED_GPU_DEVICE_IDS:-}" ] || fail "Missing required --gpu-device-ids value"
  [ -n "${REQUESTED_MODEL:-}" ] || fail "Missing required --model value"
}

if [ "${1:-}" = "help" ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

cd "$APP_DIR"

ai_root="${AI_ROOT:-$(read_env_or_default AI_ROOT /home/astigmatism/ai)}"
checkpoint_dir="${CHECKPOINT_DIR:-$ai_root/models/checkpoints}"

if [ "${1:-}" = "list" ]; then
  list_gpus
  list_checkpoints "$checkpoint_dir"
  exit 0
fi

ACTION="deploy"
REQUESTED_GPU_DEVICE_IDS=""
REQUESTED_MODEL=""

case "${1:-}" in
  plan|deploy)
    ACTION="$1"
    shift
    parse_plan_or_deploy_args "$@"
    ;;
  *)
    if [ "$#" -ne 2 ]; then
      usage
      exit 1
    fi
    ACTION="deploy"
    REQUESTED_GPU_DEVICE_IDS="$1"
    REQUESTED_MODEL="$2"
    ;;
esac

require_command python3
require_command nvidia-smi

gpu_uuid="$(validate_single_gpu_device_id "$REQUESTED_GPU_DEVICE_IDS")"
checkpoint_file="$(resolve_checkpoint "$REQUESTED_MODEL" "$checkpoint_dir")"
preload_model="${PRELOAD_MODEL:-true}"

log "Using application directory: $APP_DIR"
log "Selected GPU UUID: $gpu_uuid"
log "Selected checkpoint: $checkpoint_file"

if [ "$ACTION" = "plan" ]; then
  print_runtime_plan "$gpu_uuid" "$checkpoint_file" "$ai_root"
  log "Plan complete; no files, containers, volumes, or API state were changed"
  exit 0
fi

require_command docker
require_command curl

docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required: docker compose"

write_env_file "$gpu_uuid" "$checkpoint_file" "$ai_root"

log "Generated .env"
grep -E '^(LOCAL_AI_IMAGES_PROJECT_NAME|LOCAL_AI_IMAGES_CONTAINER_NAME|LOCAL_AI_IMAGES_ARTIFACTS_VOLUME_NAME|WEB_BIND_IP|WEB_PORT|GPU_DEVICE_ID|IMAGE_DEFAULT_MODEL|IMAGE_PRELOAD_DEFAULT_ON_STARTUP)=' .env

ensure_artifacts_volume

log "Rendering Compose configuration"
compose config >/tmp/local-ai-images-compose.yml

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

base_url="$(build_base_url)"

log "Checking health endpoint: $base_url/health"
curl -fsS "$base_url/health" >/tmp/local-ai-images-health.json

log "Setting selected checkpoint as app default"
set_default_model_via_api "$base_url" "$checkpoint_file"

if [ "$preload_model" = "true" ]; then
  log "Ensuring selected checkpoint is loaded"
  ensure_model_loaded_via_api "$base_url" "$checkpoint_file"
else
  log "Skipping preload because PRELOAD_MODEL=$preload_model"
fi

log "Container status"
compose ps "$COMPOSE_SERVICE"

log "Visible GPU inside container"
compose exec -T "$COMPOSE_SERVICE" nvidia-smi --query-gpu=index,uuid,name,memory.total,memory.free --format=csv || true

log "Runtime deploy complete"