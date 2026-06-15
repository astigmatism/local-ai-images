# 07 - Operations and troubleshooting

## Check service status

```bash
systemctl status comfyui.service --no-pager
systemctl status local-ai-images.service --no-pager
```

## View logs

```bash
journalctl -u comfyui.service -e --no-pager
journalctl -u comfyui.service -f
journalctl -u local-ai-images.service -e --no-pager
journalctl -u local-ai-images.service -f
```

## Restart services

```bash
sudo systemctl restart comfyui.service
sudo systemctl restart local-ai-images.service
```

If ComfyUI restarts while a job is running, the in-memory Local AI Images job may fail and should be resubmitted by the caller.

## Run the update routine

From the repository root:

```bash
./update-and-restart.sh
```

Override service name or app directory:

```bash
SERVICE_NAME=local-ai-images APP_DIR=/home/<user>/local-ai-images ./update-and-restart.sh
```

The script:

1. Stops the systemd service if present.
2. Pulls git updates when `.git` exists.
3. Runs `npm ci` when `package-lock.json` exists.
4. Runs typecheck and tests.
5. Builds the TypeScript app.
6. Restarts the service or starts the app in the background if no service exists.

It uses `set -euo pipefail` and does not hide test failures.

## Create a handoff zip

```bash
./compress-source.sh ~/Desktop
```

The script writes:

```text
local-ai-images-<timestamp>.zip
```

It excludes:

- `node_modules/`
- `dist/`
- `build/`
- `.git/`
- coverage output
- logs and temporary files
- local `.env` files
- generated local config JSON
- generated image artifacts

It includes `.env.example`, docs, source, tests, package files, scripts, README files, and deployment examples.

## Image API validation

```bash
export IMAGE_API_URL=http://127.0.0.1:8000
export IMAGE_API_KEY=replace-with-a-long-random-secret

curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" "$IMAGE_API_URL/api/v1/health" | jq
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" "$IMAGE_API_URL/api/v1/stats" | jq
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" "$IMAGE_API_URL/api/v1/models" | jq
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" "$IMAGE_API_URL/api/v1/workflows" | jq
curl -sS "$IMAGE_API_URL/openapi.json" | jq '.openapi, .info'
```

Compatibility GPU endpoints remain available:

```bash
curl http://127.0.0.1:8000/gpu | jq
curl http://127.0.0.1:8000/gpus | jq
```

## Common ComfyUI failures

### ComfyUI unavailable

Symptoms:

- `/api/v1/health` reports `engine.ok: false`.
- Generation jobs fail before ComfyUI prompt submission.

Checks:

```bash
systemctl status comfyui.service --no-pager
curl http://127.0.0.1:8188/system_stats | jq
journalctl -u comfyui.service -e --no-pager
```

Fixes:

```bash
sudo systemctl restart comfyui.service
sudo systemctl restart local-ai-images.service
```

Confirm `.env`:

```dotenv
IMAGE_BACKEND=comfyui
COMFYUI_BASE_URL=http://127.0.0.1:8188
```

### Workflow not found or incompatible

Symptoms:

- `/api/v1/generate` returns a workflow validation error.
- Jobs fail with ComfyUI prompt errors.

Checks:

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" "$IMAGE_API_URL/api/v1/workflows" | jq
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" "$IMAGE_API_URL/api/v1/workflows/sdxl-text-to-image" | jq
```

Fixes:

- Verify `IMAGE_DEFAULT_WORKFLOW_ID` exists.
- Verify custom workflow JSON is valid.
- Verify ComfyUI node IDs in `comfyui.mappings` match the prompt graph.
- Verify the referenced checkpoint exists in ComfyUI's model paths.

### Model inventory is empty

Symptoms:

- `/api/v1/models` returns zero models.

Checks:

```bash
ls -lah /home/<user>/local-ai-images/models
find /home/<user>/local-ai-images/models -maxdepth 3 -type f | head
```

Fixes:

- Confirm `IMAGE_MODEL_PATHS` points to the intended directories.
- Confirm service user can read those directories.
- Refresh inventory: `POST /api/v1/models/refresh`.

## Common NVIDIA failures

### `nvidia-smi` unavailable

Symptoms:

- `/api/v1/stats` reports `gpu.ok: false`.
- `/gpu` or `/gpus` returns `NVIDIA_SMI_UNAVAILABLE`.

Check:

```bash
command -v nvidia-smi
dpkg -l | grep -E 'nvidia-driver|nvidia-utils'
```

Install matching utilities for your driver branch.

### NVIDIA driver unavailable

Symptoms:

- `nvidia-smi` fails with NVML or driver messages.
- `/api/v1/stats` reports `NVIDIA_DRIVER_UNAVAILABLE`.

Check:

```bash
nvidia-smi
lsmod | grep nvidia
dmesg -T | grep -Ei 'nvidia|nvrm|xid' | tail -n 100
```

Try a reboot after driver installation or upgrades:

```bash
sudo reboot
```

### No GPUs detected

Symptoms:

- `/api/v1/stats` or `/gpus` returns no GPU entries.

Check PCI detection:

```bash
lspci | grep -Ei 'nvidia|vga|3d'
```

If the card is absent at PCI level, check hypervisor passthrough, IOMMU grouping, power, risers, BIOS slot settings, and physical seating.

## Out-of-VRAM failures

Symptoms:

- ComfyUI logs CUDA out-of-memory errors.
- Jobs fail after prompt submission.
- GPU memory is near full in `/api/v1/stats`.

Try:

- Set `IMAGE_QUEUE_CONCURRENCY=1`.
- Reduce width, height, batch size, or high-resolution upscale settings.
- Use a smaller checkpoint or lower-memory workflow.
- Stop other GPU workloads.
- Restart ComfyUI after repeated CUDA errors.

## Legacy Ollama disabled response

If a caller uses retained legacy routes while default image-only mode is active, it receives:

```json
{
  "ok": false,
  "error": {
    "code": "LEGACY_OLLAMA_DISABLED",
    "message": "Legacy Ollama compatibility endpoint /model/load is disabled. Set LEGACY_OLLAMA_ENABLED=true to enable retained Ollama routes. New image integrations should use /api/v1/generate and related /api/v1 endpoints."
  }
}
```

That is expected. Use `/api/v1/generate` for image generation, or see [03 - Optional legacy Ollama compatibility](03-ollama-installation-and-configuration.md) if you intentionally need old Ollama routes.
