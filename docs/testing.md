# Testing guide

The project follows the reference app's built-in Node test style: no Jest/Vitest dependency, no browser test runner, and no required GPU for unit tests.

## Local test commands

```bash
npm test
npm run build
npm run validate
```

`npm test` runs all `tests/*.test.ts` files with Node's native test runner and type stripping. The build step remains lightweight because the app is executed directly by Node.

## What the test suite covers

The added image-generation tests cover:

- Runtime configuration parsing for ComfyUI/mock backend, auth, paths, and queue settings.
- Generation request validation and normalization.
- Stable request-to-ComfyUI workflow mapping.
- Model inventory scanning from configured directories.
- Workflow preset loading from built-in and operator JSON files.
- GPU stats error reporting when `nvidia-smi` is missing or unavailable.
- ComfyUI health checks with mocked HTTP services.
- ComfyUI prompt submit, history polling, image download, and submit failure paths.
- In-memory job queue state transitions: queued, running, succeeded, canceled, failed.
- Artifact data and sidecar metadata mapping.
- `/api/v1` authentication success and failure.
- API routes for health, stats, models, workflows, generate, jobs, cancel, result, and artifacts.
- Legacy reference-app routes so existing LLM/Ollama monitor functionality is preserved.

## Optional GPU smoke test

The hardware smoke test is skipped unless explicitly enabled:

```bash
RUN_GPU_TESTS=1 npm test
```

It runs `nvidia-smi` through `NvidiaSmiGpuService` and expects at least one GPU. Use it only on the target VM after NVIDIA driver installation.

## Mock backend smoke test

Use this mode to validate the app without ComfyUI or a GPU:

```bash
cat > .env <<'ENV'
PORT=8000
HOST=127.0.0.1
IMAGE_GENERATION_ENABLED=true
IMAGE_BACKEND=mock
IMAGE_API_KEYS=dev-secret
REQUIRE_IMAGE_API_AUTH=true
IMAGE_MODEL_PATHS=./models
IMAGE_WORKFLOW_PATH=./config/workflows
IMAGE_ARTIFACT_PATH=./data/artifacts
IMAGE_DEFAULT_SYNC_TIMEOUT_MS=1000
ENV

mkdir -p models/checkpoints config/workflows data/artifacts
printf 'placeholder' > models/checkpoints/mock.safetensors
npm start
```

From a second shell:

```bash
curl -sS -H 'Authorization: Bearer dev-secret' http://127.0.0.1:8000/api/v1/health | jq .

curl -sS -H 'Authorization: Bearer dev-secret' \
  -H 'content-type: application/json' \
  -d '{"prompt":"mock smoke test","output":"base64","sync_timeout_ms":1000}' \
  http://127.0.0.1:8000/api/v1/generate | jq .
```

## Real ComfyUI smoke test

After ComfyUI and NVIDIA drivers are working:

```bash
curl -sS http://127.0.0.1:8188/system_stats | jq .

curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"prompt":"real comfyui smoke test","model":"YOUR_CHECKPOINT.safetensors","output":"url","sync_timeout_ms":60000}' \
  "$IMAGE_API_URL/api/v1/generate" | jq .
```

Then retrieve the artifact from the returned `artifacts[0].url`.

## Test data policy

The repository should not contain model files, generated images, secrets, or host-specific absolute paths. Tests create temporary directories under the OS temp directory and use a 1x1 PNG fixture for mock artifact checks.
