# Deployment guide

Local AI Images follows the reference app's host-service/systemd style. The default image backend is ComfyUI on `127.0.0.1:8188`; the public LAN service is this app on port `8000`.

The intended deployment model is simple: run both the app and ComfyUI under the logged-in Ubuntu account from that user's home directory. Do not create a `local-ai-images` service account unless you intentionally choose a hardened custom layout.

## Directory layout

Recommended home-directory layout, using `<user>` as a placeholder for the logged-in Ubuntu account:

```text
/home/<user>/local-ai-images/          # this application
/home/<user>/ComfyUI/                  # ComfyUI checkout and Python venv
/home/<user>/comfyui-models/           # operator-supplied model files
/home/<user>/local-ai-images/data/     # generated artifacts and runtime data
```

Create the directories as the logged-in user:

```bash
mkdir -p "$HOME/local-ai-images" \
  "$HOME/ComfyUI" \
  "$HOME/comfyui-models/checkpoints" \
  "$HOME/comfyui-models/loras" \
  "$HOME/comfyui-models/vae" \
  "$HOME/comfyui-models/controlnet" \
  "$HOME/local-ai-images/data/artifacts"
```

## Install the Node application

Copy or clone the source tree into `$HOME/local-ai-images`:

```bash
cd "$HOME/local-ai-images"
npm ci
cp .env.example .env
mkdir -p config/workflows data/artifacts models
chmod 600 .env
```

Edit the environment file:

```bash
nano "$HOME/local-ai-images/.env"
```

Minimum production values:

```dotenv
CONFIG_PATH=./config/local-ai-images.json
IMAGE_GENERATION_ENABLED=true
IMAGE_BACKEND=comfyui
COMFYUI_BASE_URL=http://127.0.0.1:8188
IMAGE_MODEL_PATHS=/home/<user>/comfyui-models
IMAGE_WORKFLOW_PATH=/home/<user>/local-ai-images/config/workflows
IMAGE_ARTIFACT_PATH=/home/<user>/local-ai-images/data/artifacts
IMAGE_ARTIFACT_PUBLIC_BASE_URL=/api/v1/artifacts
IMAGE_API_KEYS=<long-random-secret>
REQUIRE_IMAGE_API_AUTH=true
```

Replace `<user>` with the actual Ubuntu username. For local app-only testing without a GPU or ComfyUI, use:

```dotenv
IMAGE_BACKEND=mock
IMAGE_GENERATION_ENABLED=true
REQUIRE_IMAGE_API_AUTH=false
IMAGE_API_KEYS=
```

## Install ComfyUI

Follow `docs/image-generation-vm.md` for GPU driver and Python setup. A typical home-directory ComfyUI install is:

```bash
cd "$HOME"
git clone https://github.com/comfyanonymous/ComfyUI.git ComfyUI
cd "$HOME/ComfyUI"
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt
```

Install the PyTorch CUDA wheel appropriate for your driver/CUDA stack using the command from the official PyTorch selector, then validate CUDA from the ComfyUI venv:

```bash
"$HOME/ComfyUI/venv/bin/python" - <<'PY'
import torch
print(torch.__version__)
print(torch.cuda.is_available())
print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'no cuda')
PY
```

Point ComfyUI at the operator model directories with symlinks:

```bash
ln -sfn "$HOME/comfyui-models/checkpoints" "$HOME/ComfyUI/models/checkpoints"
ln -sfn "$HOME/comfyui-models/loras" "$HOME/ComfyUI/models/loras"
ln -sfn "$HOME/comfyui-models/vae" "$HOME/ComfyUI/models/vae"
ln -sfn "$HOME/comfyui-models/controlnet" "$HOME/ComfyUI/models/controlnet"
```

## Install systemd services

The example units contain `<user>` placeholders. Install them by replacing the placeholder with the current Ubuntu username:

```bash
cd "$HOME/local-ai-images"
sed "s/<user>/$USER/g" deploy/comfyui.service.example | sudo tee /etc/systemd/system/comfyui.service >/dev/null
sed "s/<user>/$USER/g" deploy/local-ai-images.service.example | sudo tee /etc/systemd/system/local-ai-images.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now comfyui.service
sudo systemctl enable --now local-ai-images.service
```

Check status and logs:

```bash
systemctl status comfyui.service --no-pager
systemctl status local-ai-images.service --no-pager
journalctl -u comfyui.service -f
journalctl -u local-ai-images.service -f
```

For nvm-based Node installs, edit `/etc/systemd/system/local-ai-images.service`, comment the `/usr/bin/npm` `ExecStart`, uncomment the nvm `ExecStart`, then reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart local-ai-images.service
```

ComfyUI should listen only on localhost in this deployment. Do not expose ComfyUI directly to the LAN unless you understand and accept the risk.

## Firewall and network exposure

Expose only the app port to trusted hosts:

```bash
sudo ufw allow from TRUSTED_GATEWAY_IP to any port 8000 proto tcp
sudo ufw allow from ADMIN_WORKSTATION_IP to any port 22 proto tcp
sudo ufw enable
```

Keep raw ComfyUI bound to `127.0.0.1`. The stable orchestrator API is `/api/v1` on this app.

## First deployment validation

```bash
export IMAGE_API_URL=http://127.0.0.1:8000
export IMAGE_API_KEY=<long-random-secret>

curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" "$IMAGE_API_URL/api/v1/health" | jq .
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" "$IMAGE_API_URL/api/v1/capabilities" | jq .
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" "$IMAGE_API_URL/api/v1/models" | jq .
```

Submit a real generation request only after at least one checkpoint appears in ComfyUI and in `/api/v1/models`:

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "prompt": "cinematic photo of a cozy cabin in snowy mountains",
    "workflow_id": "sdxl-text-to-image",
    "width": 1024,
    "height": 1024,
    "steps": 25,
    "output": "url",
    "sync_timeout_ms": 1000
  }' \
  "$IMAGE_API_URL/api/v1/generate" | jq .
```

Retrieve an artifact:

```bash
curl -L -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/artifacts/ARTIFACT_ID" \
  --output output.png

curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/artifacts/ARTIFACT_ID?metadata=1" | jq .
```

## Update flow

With systemd installed:

```bash
cd "$HOME/local-ai-images"
./update-and-restart.sh
```

Manual update flow:

```bash
cd "$HOME/local-ai-images"
sudo systemctl stop local-ai-images.service
npm ci
npm run validate
sudo systemctl start local-ai-images.service
```

## Environment reference

| Variable | Purpose |
| --- | --- |
| `PORT` / `HOST` | App bind address. |
| `CONFIG_PATH` | Local AI Images runtime config JSON. Defaults to `./config/local-ai-images.json`. |
| `IMAGE_GENERATION_ENABLED` | Enables the `/api/v1` image-generation runtime. Keep true for normal deployments. |
| `LEGACY_OLLAMA_ENABLED` | Optional compatibility switch for retained reference-app Ollama routes. Defaults to false and should remain false for image-only deployments. |
| `OLLAMA_BASE_URL` | Optional legacy Ollama endpoint base URL, used only when `LEGACY_OLLAMA_ENABLED=true`. |
| `IMAGE_BACKEND` | `comfyui` or `mock`. |
| `COMFYUI_BASE_URL` | Local ComfyUI API URL. |
| `COMFYUI_REQUEST_TIMEOUT_MS` | Provider request and generation wait timeout. |
| `COMFYUI_POLL_INTERVAL_MS` | History polling interval. |
| `IMAGE_MODEL_PATHS` | Comma-separated model inventory roots. |
| `IMAGE_WORKFLOW_PATH` | Operator workflow preset directory. |
| `IMAGE_ARTIFACT_PATH` | Generated image and metadata storage. |
| `IMAGE_ARTIFACT_PUBLIC_BASE_URL` | URL prefix used in artifact metadata. |
| `IMAGE_DEFAULT_WORKFLOW_ID` | Default workflow preset ID. |
| `IMAGE_DEFAULT_MODEL` | Initial/fallback default checkpoint when config has no `image_default_model`. |
| `IMAGE_PRELOAD_DEFAULT_ON_STARTUP` | Initial/fallback setting for prewarming the default checkpoint after app restart. |
| `IMAGE_PRELOAD_TIMEOUT_MS` | Bound for manual preload and preload-after-restart attempts. |
| `IMAGE_PRELOAD_WORKFLOW_ID` | Workflow preset used for preload requests. Defaults to `IMAGE_DEFAULT_WORKFLOW_ID`. |
| `IMAGE_PRELOAD_WIDTH` / `IMAGE_PRELOAD_HEIGHT` | Dimensions for the tiny preload request. |
| `IMAGE_PRELOAD_STEPS` | Step count for the tiny preload request. |
| `IMAGE_PRELOAD_KEEP_ARTIFACT` | Keep or discard the tiny preload artifact. |
| `IMAGE_QUEUE_CONCURRENCY` | Number of jobs to run concurrently. Use `1` for RTX 3080 unless you have a reason to raise it. |
| `IMAGE_MAX_QUEUED_JOBS` | Back-pressure limit. |
| `IMAGE_DEFAULT_SYNC_TIMEOUT_MS` | Default synchronous wait. `0` means async by default. |
| `IMAGE_MAX_SYNC_TIMEOUT_MS` | Upper bound for caller-requested sync waits. |
| `IMAGE_API_KEYS` | Comma/newline-separated machine API keys. |
| `REQUIRE_IMAGE_API_AUTH` | Fail closed when true. |
| `IMAGE_MOCK_DELAY_MS` | Mock backend delay for local tests. |

## Troubleshooting

### GPU not visible in the guest

```bash
lspci -nn | grep -i nvidia
nvidia-smi
```

If PCI devices are absent, fix passthrough on the hypervisor. If PCI devices exist but `nvidia-smi` fails, reinstall the guest NVIDIA driver, confirm secure boot policy, and check `dmesg` for NVIDIA or VFIO errors.

### ComfyUI cannot use CUDA

Run the PyTorch CUDA validation command from `docs/image-generation-vm.md`. If `torch.cuda.is_available()` is false, reinstall the matching PyTorch CUDA wheel and confirm `nvidia-smi` works for the logged-in Ubuntu user.

### App says ComfyUI unavailable

```bash
systemctl status comfyui.service --no-pager
curl -sS http://127.0.0.1:8188/system_stats | jq .
grep '^COMFYUI_BASE_URL=' "$HOME/local-ai-images/.env"
```

### Models are not listed

Check `IMAGE_MODEL_PATHS`, file permissions, and supported extensions. The scanner ignores dotfiles and unknown extensions. Portal/API downloads are available only when model installs are enabled and always write inside approved ComfyUI model directories.

### Workflow not found

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" "$IMAGE_API_URL/api/v1/workflows" | jq .
```

Confirm `workflow_id` matches one of the returned IDs. Invalid JSON in `IMAGE_WORKFLOW_PATH` causes workflow loading errors.

### Permission denied writing artifacts

Ensure `IMAGE_ARTIFACT_PATH` is writable by the logged-in Ubuntu user that runs the service:

```bash
mkdir -p "$HOME/local-ai-images/data/artifacts"
sudo chown -R "$USER:$USER" "$HOME/local-ai-images/data"
sudo systemctl restart local-ai-images.service
```

### Out-of-VRAM failures

Reduce width, height, batch size inside the workflow, steps, ControlNet count, and loaded LoRAs. Keep `IMAGE_QUEUE_CONCURRENCY=1` for RTX 3080. Restart ComfyUI if VRAM fragmentation persists.
