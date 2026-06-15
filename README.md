# Local AI Images

Local AI Images is a dependency-light Node control panel and machine-to-machine image-generation API for a GPU-enabled Ubuntu host. The default runtime is image-focused: it talks to ComfyUI, scans local image model directories, manages an async generation queue, stores artifacts, and reports NVIDIA GPU/status telemetry.

Legacy Ollama endpoints from the reference application are still present only as optional compatibility routes. They are disabled by default and do not run, prewarm, or affect health checks unless `LEGACY_OLLAMA_ENABLED=true` is set explicitly.

## What this provides

- Node HTTP service on `0.0.0.0:8000`, using native TypeScript type stripping and no application npm dependencies.
- Static hosted control panel with service, GPU, ComfyUI/mock engine, queue, model inventory, model lifecycle actions, workflow preset, and recent-job state.
- Stable image API over `/api/v1`:
  - `GET /api/v1/health`
  - `GET /api/v1/capabilities`
  - `GET /api/v1/stats`
  - `GET /api/v1/models`
  - `POST /api/v1/models/refresh`
  - `POST /api/v1/models/default`
  - `DELETE /api/v1/models/default`
  - `GET /api/v1/models/preload`
  - `POST /api/v1/models/preload`
  - `POST /api/v1/models/preload/startup`
  - `DELETE /api/v1/models/{modelId}`
  - `GET /api/v1/workflows`
  - `GET /api/v1/workflows/{workflowId}`
  - `POST /api/v1/generate`
  - `GET /api/v1/jobs`
  - `GET /api/v1/jobs/{jobId}`
  - `GET /api/v1/jobs/{jobId}/result`
  - `POST /api/v1/jobs/{jobId}/cancel`
  - `GET /api/v1/artifacts/{artifactId}`
- Provider abstraction with ComfyUI as the primary backend and a mock backend for local testing.
- App-level request validation and workflow preset mapping so callers do not need to submit raw ComfyUI JSON.
- Local model inventory scanner, persisted default checkpoint, explicit checkpoint preload, startup preload, safe model delete, and operator-supplied workflow directory.
- In-memory async job queue with configurable concurrency/back-pressure.
- Artifact storage with sidecar metadata and URL/base64/binary/metadata-only result delivery.
- API-key or bearer-token authentication for `/api/v1` when configured.
- NVIDIA GPU telemetry via `nvidia-smi`.
- Compatibility GPU endpoints: `/health`, `/api/capabilities`, `/gpu`, and `/gpus`. In the default image-only mode, `/health` and `/api/capabilities` report image API state and do not contact Ollama.

## Quick start in mock mode

Mock mode starts without ComfyUI or a GPU:

```bash
cp .env.example .env
python3 - <<'PY'
from pathlib import Path
p = Path('.env')
s = p.read_text()
s = s.replace('IMAGE_BACKEND=comfyui', 'IMAGE_BACKEND=mock')
s = s.replace('REQUIRE_IMAGE_API_AUTH=true', 'REQUIRE_IMAGE_API_AUTH=false')
s = s.replace('IMAGE_API_KEYS=replace-with-a-long-random-secret', 'IMAGE_API_KEYS=')
p.write_text(s)
PY
mkdir -p models/checkpoints config/workflows data/artifacts
printf 'placeholder' > models/checkpoints/mock.safetensors
npm ci
npm run validate
npm start
```

Open the portal:

```text
http://127.0.0.1:8000/
```

Submit a mock image request:

```bash
curl -sS -H 'content-type: application/json' \
  -d '{"prompt":"a mock smoke test","output":"base64","sync_timeout_ms":1000}' \
  http://127.0.0.1:8000/api/v1/generate | jq .
```

## Production deployment

Use the image-generation docs first:

- [`docs/image-generation-vm.md`](docs/image-generation-vm.md) for RTX 3080 passthrough VM, Ubuntu, NVIDIA driver, ComfyUI, and first API/UI checks.
- [`docs/deployment.md`](docs/deployment.md) for systemd deployment and environment variables.
- [`docs/api.md`](docs/api.md) for the orchestrator-facing API.
- [`docs/testing.md`](docs/testing.md) for unit, mock, and optional GPU smoke tests.

The deployment pattern is host-service/systemd by default:

```bash
sed "s/<user>/$USER/g" deploy/comfyui.service.example | sudo tee /etc/systemd/system/comfyui.service >/dev/null
sed "s/<user>/$USER/g" deploy/local-ai-images.service.example | sudo tee /etc/systemd/system/local-ai-images.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now comfyui.service local-ai-images.service
```

The service examples run under the logged-in Ubuntu user and assume the app checkout is `$HOME/local-ai-images`. Replace `<user>` placeholders before installing, as shown above. For nvm-based Node, use the commented nvm `ExecStart` in `deploy/local-ai-images.service.example`.

Keep ComfyUI bound to `127.0.0.1:8188`; expose only this app to trusted LAN hosts or a reverse proxy.

## Important image defaults

```dotenv
IMAGE_GENERATION_ENABLED=true
IMAGE_BACKEND=comfyui
COMFYUI_BASE_URL=http://127.0.0.1:8188
CONFIG_PATH=./config/local-ai-images.json
IMAGE_MODEL_PATHS=./models
IMAGE_WORKFLOW_PATH=./config/workflows
IMAGE_ARTIFACT_PATH=./data/artifacts
IMAGE_DEFAULT_WORKFLOW_ID=sdxl-text-to-image
IMAGE_DEFAULT_MODEL=
IMAGE_PRELOAD_DEFAULT_ON_STARTUP=false
IMAGE_PRELOAD_TIMEOUT_MS=120000
IMAGE_PRELOAD_WORKFLOW_ID=sdxl-text-to-image
IMAGE_PRELOAD_WIDTH=512
IMAGE_PRELOAD_HEIGHT=512
IMAGE_PRELOAD_STEPS=1
IMAGE_PRELOAD_KEEP_ARTIFACT=false
IMAGE_QUEUE_CONCURRENCY=1
IMAGE_API_KEYS=replace-with-a-long-random-secret
REQUIRE_IMAGE_API_AUTH=true
LEGACY_OLLAMA_ENABLED=false
```

The repository does not include model files, generated images, secrets, or machine-specific paths. Operators supply local models and workflow presets.


## Model lifecycle controls

The portal distinguishes installed-on-disk, selected-in-playground, persisted default, last confirmed loaded/prewarmed, and preload-on-startup states. Each installed checkpoint row/card exposes **Use in playground**, **Load / Prewarm now**, **Set as default**, **Set default + preload on startup**, **Delete model**, and **Refresh scan** controls. The default status panel shows the current default checkpoint, missing-file warnings, startup preload state, last preload result/error, and last confirmed loaded/prewarmed model.

ComfyUI does not expose an exact loaded-checkpoint-in-VRAM API through this app, so the portal uses the honest label **Last confirmed loaded/prewarmed model** after a successful preload or generation.

## API examples

```bash
export IMAGE_API_URL=http://127.0.0.1:8000
export IMAGE_API_KEY=replace-with-a-long-random-secret

curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/health" | jq .

curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"prompt":"a cinematic fox in a server room","model":"sd_xl_base_1.0.safetensors","sync_timeout_ms":60000,"output":"url"}' \
  "$IMAGE_API_URL/api/v1/generate" | jq .
```

Artifact bytes and metadata:

```bash
curl -L -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/artifacts/ARTIFACT_ID" --output output.png

curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/artifacts/ARTIFACT_ID?metadata=1" | jq .
```

## Testing

```bash
npm test
npm run build
npm run validate
RUN_GPU_TESTS=1 npm test   # optional real nvidia-smi smoke test
```

The test suite runs without real GPUs or ComfyUI by using mocks and temporary directories. Optional legacy Ollama compatibility tests use mocked Ollama clients and do not require an Ollama service.

## Local-control policy

The app is local-first and operator-controlled. It does not hardcode prompt filters, vendor moderation calls, remote safety gates, or model allowlists. Use API keys, firewall rules, filesystem permissions, and internal legal-use policies appropriate for your deployment.

## Optional legacy Ollama compatibility

Retained legacy routes are disabled by default: `/models/running`, `/models/installed`, `/config`, `/model/load`, `/model/prewarm`, and `/api/images/generate`. They return `LEGACY_OLLAMA_DISABLED` until `LEGACY_OLLAMA_ENABLED=true` is set.

When legacy mode is disabled, `npm start`, `/health`, `/api/capabilities`, and the dashboard do not contact Ollama and no default LLM model is assumed. New image-generation integrations should use `/api/v1/generate`.

## Scripts

```bash
./update-and-restart.sh
./compress-source.sh ~/Desktop
```

`update-and-restart.sh` supports systemd operation and defaults to the `local-ai-images` service name. Override it with:

```bash
SERVICE_NAME=my-service-name ./update-and-restart.sh
```
