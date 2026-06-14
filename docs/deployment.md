# Deployment guide

This project follows the reference app's host-service/systemd style. No new npm dependencies are required. The default image backend is ComfyUI on `127.0.0.1:8188`; the public LAN service is this app on port `8000`.

## Directory layout

Recommended production layout:

```text
/opt/local-ai-llm/              # this application
/opt/ComfyUI/                   # ComfyUI checkout and Python venv
/srv/comfyui/models/            # operator-supplied model files
/var/lib/local-ai-image/artifacts/  # generated images and sidecar metadata
```

Create the service account and directories:

```bash
sudo useradd --system --create-home --home-dir /opt/local-ai-llm --shell /usr/sbin/nologin local-ai-llm || true
sudo mkdir -p /opt/local-ai-llm /opt/ComfyUI /srv/comfyui/models /var/lib/local-ai-image/artifacts
sudo chown -R local-ai-llm:local-ai-llm /opt/local-ai-llm /opt/ComfyUI /srv/comfyui /var/lib/local-ai-image
```

## Install Node application

Copy the source tree to `/opt/local-ai-llm` and install:

```bash
cd /opt/local-ai-llm
sudo -u local-ai-llm npm ci
sudo -u local-ai-llm cp .env.example .env
sudo -u local-ai-llm mkdir -p config/workflows data/artifacts
sudo -u local-ai-llm chmod 600 .env
```

Edit `/opt/local-ai-llm/.env`:

```bash
sudoedit /opt/local-ai-llm/.env
```

Minimum production values:

```dotenv
IMAGE_GENERATION_ENABLED=true
IMAGE_BACKEND=comfyui
COMFYUI_BASE_URL=http://127.0.0.1:8188
IMAGE_MODEL_PATHS=/srv/comfyui/models
IMAGE_WORKFLOW_PATH=/opt/local-ai-llm/config/workflows
IMAGE_ARTIFACT_PATH=/var/lib/local-ai-image/artifacts
IMAGE_ARTIFACT_PUBLIC_BASE_URL=/api/v1/artifacts
IMAGE_API_KEYS=<long-random-secret>
REQUIRE_IMAGE_API_AUTH=true
```

For local app-only testing without a GPU or ComfyUI:

```dotenv
IMAGE_BACKEND=mock
IMAGE_GENERATION_ENABLED=true
REQUIRE_IMAGE_API_AUTH=false
IMAGE_API_KEYS=
```

## Install ComfyUI host service

Follow `docs/image-generation-vm.md` for GPU driver and Python setup. After ComfyUI works from the shell, install the service file:

```bash
cd /opt/local-ai-llm
sudo cp deploy/comfyui.service.example /etc/systemd/system/comfyui.service
sudo systemctl daemon-reload
sudo systemctl enable --now comfyui.service
sudo systemctl status comfyui.service --no-pager
curl -sS http://127.0.0.1:8188/system_stats | jq .
```

ComfyUI should listen only on localhost in this deployment. Do not expose ComfyUI directly to the LAN unless you understand and accept the risk.

## Install app systemd service

```bash
cd /opt/local-ai-llm
sudo cp deploy/local-ai-llm.service.example /etc/systemd/system/local-ai-llm.service
sudo systemctl daemon-reload
sudo systemctl enable --now local-ai-llm.service
sudo systemctl status local-ai-llm.service --no-pager
```

View logs:

```bash
journalctl -u local-ai-llm.service -f
journalctl -u comfyui.service -f
```

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
  -d '{"prompt":"a production smoke test image","model":"YOUR_CHECKPOINT.safetensors","sync_timeout_ms":60000,"output":"url"}' \
  "$IMAGE_API_URL/api/v1/generate" | jq .
```

## Updating

The existing helper remains available:

```bash
cd /opt/local-ai-llm
sudo -u local-ai-llm ./update-and-restart.sh
```

Or manually:

```bash
cd /opt/local-ai-llm
sudo systemctl stop local-ai-llm.service
sudo -u local-ai-llm npm ci
sudo -u local-ai-llm npm run validate
sudo systemctl start local-ai-llm.service
```

## Environment variable reference

| Variable | Purpose |
| --- | --- |
| `IMAGE_GENERATION_ENABLED` | Enables `/api/v1/generate`. |
| `IMAGE_BACKEND` | `comfyui` or `mock`. |
| `COMFYUI_BASE_URL` | Local ComfyUI API URL. |
| `COMFYUI_REQUEST_TIMEOUT_MS` | Provider request and generation wait timeout. |
| `COMFYUI_POLL_INTERVAL_MS` | History polling interval. |
| `IMAGE_MODEL_PATHS` | Comma-separated model inventory roots. |
| `IMAGE_WORKFLOW_PATH` | Operator workflow preset directory. |
| `IMAGE_ARTIFACT_PATH` | Generated image and metadata storage. |
| `IMAGE_ARTIFACT_PUBLIC_BASE_URL` | URL prefix used in artifact metadata. |
| `IMAGE_DEFAULT_WORKFLOW_ID` | Default workflow preset ID. |
| `IMAGE_QUEUE_CONCURRENCY` | Number of jobs to run concurrently. Use `1` for RTX 3080 unless you have a reason to raise it. |
| `IMAGE_MAX_QUEUED_JOBS` | Back-pressure limit. |
| `IMAGE_DEFAULT_SYNC_TIMEOUT_MS` | Default synchronous wait. `0` means async by default. |
| `IMAGE_MAX_SYNC_TIMEOUT_MS` | Upper bound for caller-requested sync waits. |
| `IMAGE_API_KEYS` | Comma/newline-separated machine API keys. |
| `REQUIRE_IMAGE_API_AUTH` | Fail closed when true. |
| `IMAGE_MOCK_DELAY_MS` | Mock backend delay for local tests. |

## Troubleshooting

### GPU not visible in the guest

Run:

```bash
lspci -nn | grep -i nvidia
nvidia-smi
```

If PCI devices are absent, fix passthrough on the hypervisor. If PCI devices exist but `nvidia-smi` fails, reinstall the guest NVIDIA driver, confirm secure boot policy, and check `dmesg` for NVIDIA or VFIO errors.

### ComfyUI cannot use CUDA

Run the PyTorch CUDA validation command from `docs/image-generation-vm.md`. If `torch.cuda.is_available()` is false, reinstall the matching PyTorch CUDA wheel and confirm `nvidia-smi` works for the `local-ai-llm` user.

### App says ComfyUI unavailable

Check:

```bash
systemctl status comfyui.service --no-pager
curl -sS http://127.0.0.1:8188/system_stats | jq .
grep '^COMFYUI_BASE_URL=' /opt/local-ai-llm/.env
```

### Models are not listed

Check `IMAGE_MODEL_PATHS`, file permissions, and supported extensions. The scanner ignores dotfiles and unknown extensions. The app never downloads models.

### Workflow not found

Use:

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" "$IMAGE_API_URL/api/v1/workflows" | jq .
```

Confirm `workflow_id` matches one of the returned IDs. Invalid JSON in `IMAGE_WORKFLOW_PATH` causes workflow loading errors.

### Permission denied writing artifacts

Ensure `IMAGE_ARTIFACT_PATH` is writable by the service user:

```bash
sudo chown -R local-ai-llm:local-ai-llm /var/lib/local-ai-image
sudo systemctl restart local-ai-llm.service
```

### Out-of-VRAM failures

Reduce width, height, batch size inside the workflow, steps, ControlNet count, and loaded LoRAs. Keep `IMAGE_QUEUE_CONCURRENCY=1` for RTX 3080. Restart ComfyUI if VRAM fragmentation persists.
