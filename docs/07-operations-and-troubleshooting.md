# 07 - Operations and troubleshooting

## Check service status

```bash
systemctl status local-ai-images.service --no-pager
systemctl status ollama --no-pager
```

## View logs

```bash
journalctl -u local-ai-images.service -e --no-pager
journalctl -u local-ai-images.service -f
journalctl -u ollama -e --no-pager
journalctl -u ollama -f
```

## Restart services

```bash
sudo systemctl restart local-ai-images.service
sudo systemctl restart ollama
```

If Ollama is restarted, any loaded models will be unloaded and should be pre-warmed again by the app or manually.

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

It includes `.env.example`, docs, source, tests, package files, scripts, README files, and deployment examples.

## Compatibility validation

```bash
curl http://127.0.0.1:8000/health | jq
curl http://127.0.0.1:8000/gpu | jq
curl http://127.0.0.1:8000/gpus | jq
curl -X POST http://127.0.0.1:8000/model/load \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3:14b","make_default":false}' | jq
curl http://127.0.0.1:8000/openapi.json | jq '.openapi, .info'
```

`/gpu` should return one primary GPU in the legacy shape. `/gpus` should return the detected GPU inventory when drivers are healthy.

## Common Ollama failures

### Ollama unavailable from Local AI Images

Symptoms:

- `/health` returns `ok: false`.
- Error code `OLLAMA_UNAVAILABLE`.

Checks:

```bash
systemctl status ollama --no-pager
curl http://127.0.0.1:11434/api/version
journalctl -u ollama -e --no-pager
```

Fixes:

```bash
sudo systemctl restart ollama
sudo systemctl daemon-reload
```

Confirm `OLLAMA_BASE_URL` in `.env` matches the actual Ollama bind address.

### Model not found

Symptoms:

- `/model/load` returns `OLLAMA_MODEL_NOT_FOUND`.

Fix:

```bash
ollama pull <model-name>
ollama list
```

Then retry `/model/load`.

### Pre-warm timeout

Symptoms:

- `/model/load` or `/model/prewarm` returns `OLLAMA_TIMEOUT`.

Causes:

- First load of a large model is slow.
- Disk is slow.
- Model is too large for available VRAM/RAM.
- Ollama is busy with another request.

Adjust:

```text
PREWARM_TIMEOUT_MS=300000
```

Restart Local AI Images after editing `.env`:

```bash
sudo systemctl restart local-ai-images.service
```

## Common NVIDIA failures

### `nvidia-smi` unavailable

Symptoms:

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
- `/gpus` returns `NVIDIA_DRIVER_UNAVAILABLE`.

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

- `/gpus` returns `NO_GPUS_DETECTED`.

Check PCI detection:

```bash
lspci | grep -Ei 'nvidia|vga|3d'
```

If a card is absent at PCI level, check power, risers, BIOS slot settings, motherboard lane sharing, and physical seating.

## Common multi-GPU issues

### Only one GPU used by Ollama

This can be normal if the model fits on one GPU or Ollama chooses one device for the workload. Check visibility:

```bash
nvidia-smi -L
systemctl show ollama --property=Environment
journalctl -u ollama -e --no-pager
```

If you set `CUDA_VISIBLE_DEVICES`, ensure it includes both GPU UUIDs or both indices.

### Model does not fit

Try:

- A smaller model.
- A more aggressively quantized tag.
- Lower context length.
- Allowing both GPUs through `CUDA_VISIBLE_DEVICES`.
- Avoiding other processes that consume VRAM.

### GPU order changed

Use UUIDs in `CUDA_VISIBLE_DEVICES`, not numeric IDs.

## API error shape examples

Structured operational error:

```json
{
  "ok": false,
  "error": {
    "code": "OLLAMA_UNAVAILABLE",
    "message": "Unable to connect to Ollama"
  }
}
```

Validation error:

```json
{
  "detail": [
    {
      "loc": ["body", "model"],
      "msg": "Field required",
      "type": "missing",
      "input": {},
      "ctx": {}
    }
  ]
}
```
