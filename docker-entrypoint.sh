#!/usr/bin/env bash
set -euo pipefail

COMFYUI_DIR="${COMFYUI_DIR:-/opt/comfyui/ComfyUI}"
COMFYUI_VENV="${COMFYUI_VENV:-/opt/comfyui/venv}"
COMFYUI_HOST="${COMFYUI_HOST:-127.0.0.1}"
COMFYUI_PORT="${COMFYUI_PORT:-8188}"
COMFYUI_OUTPUT_DIR="${COMFYUI_OUTPUT_DIR:-/app/data/artifacts/comfyui-output}"

mkdir -p \
  /app/config \
  /app/config/workflows \
  /app/data/artifacts \
  "${COMFYUI_OUTPUT_DIR}" \
  /cache \
  /models \
  /models/checkpoints \
  /models/loras \
  /models/vae \
  /models/controlnet \
  /models/upscale_models \
  /models/embeddings \
  /models/clip \
  /models/clip_vision \
  /models/unet \
  /models/diffusion_models

link_model_dir() {
  local source_dir="$1"
  local target_name="$2"
  local target_path="${COMFYUI_DIR}/models/${target_name}"

  mkdir -p "${source_dir}"
  rm -rf "${target_path}"
  ln -s "${source_dir}" "${target_path}"
}

mkdir -p "${COMFYUI_DIR}/models"

link_model_dir /models/checkpoints checkpoints
link_model_dir /models/loras loras
link_model_dir /models/vae vae
link_model_dir /models/controlnet controlnet
link_model_dir /models/upscale_models upscale_models
link_model_dir /models/embeddings embeddings
link_model_dir /models/clip clip
link_model_dir /models/clip_vision clip_vision
link_model_dir /models/unet unet
link_model_dir /models/diffusion_models diffusion_models

echo "Starting ComfyUI on ${COMFYUI_HOST}:${COMFYUI_PORT}"
cd "${COMFYUI_DIR}"
"${COMFYUI_VENV}/bin/python" main.py \
  --listen "${COMFYUI_HOST}" \
  --port "${COMFYUI_PORT}" \
  --output-directory "${COMFYUI_OUTPUT_DIR}" &
comfyui_pid="$!"

echo "Starting Local AI Images on ${HOST:-0.0.0.0}:${PORT:-8000}"
cd /app
npm start &
app_pid="$!"

terminate() {
  trap - INT TERM

  echo "Stopping Local AI Images and ComfyUI"
  kill "${app_pid}" "${comfyui_pid}" 2>/dev/null || true
  wait "${app_pid}" "${comfyui_pid}" 2>/dev/null || true
}

trap terminate INT TERM

set +e
wait -n "${comfyui_pid}" "${app_pid}"
exit_code="$?"
set -e

terminate

exit "${exit_code}"