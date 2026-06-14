# 04 - Application installation

## Install Node

Local AI Images is designed for modern Node runtime behavior and uses native TypeScript type stripping. The project declares `node >=22.6.0`; Node 24 is recommended on Ubuntu.

One common server approach is NodeSource:

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
sudo -E bash /tmp/nodesource_setup.sh
sudo apt install -y nodejs
node -v
npm -v
```

Confirm the installed version satisfies the package engines:

```bash
node -p "process.versions.node"
```

nvm also works. The systemd example includes a commented nvm-based `ExecStart` line.

## Clone or unpack the repository

Recommended production location under the logged-in Ubuntu account:

```bash
mkdir -p "$HOME/local-ai-images"
git clone https://github.com/astigmatism/local-ai-images.git "$HOME/local-ai-images"
cd "$HOME/local-ai-images"
```

If you received a zip package instead of cloning directly, unpack it into `$HOME/local-ai-images`.

## Configure environment

```bash
cp .env.example .env
nano .env
```

Important settings:

```text
PORT=8000
HOST=0.0.0.0
CONFIG_PATH=./config/local-ai-images.json
DEFAULT_MODEL=qwen3:14b
PREWARM_DEFAULT_MODEL_ON_START=true
PREWARM_TIMEOUT_MS=120000
PREWARM_KEEP_ALIVE=-1
GPU_QUERY_TIMEOUT_MS=5000
LOG_LEVEL=info
```

Image-generation settings:

```text
IMAGE_GENERATION_ENABLED=true
IMAGE_BACKEND=comfyui
COMFYUI_BASE_URL=http://127.0.0.1:8188
IMAGE_MODEL_PATHS=/home/<user>/comfyui-models
IMAGE_WORKFLOW_PATH=/home/<user>/local-ai-images/config/workflows
IMAGE_ARTIFACT_PATH=/home/<user>/local-ai-images/data/artifacts
IMAGE_API_KEYS=<long-random-secret>
REQUIRE_IMAGE_API_AUTH=true
```

Replace `<user>` with the actual logged-in Ubuntu username. The retained Ollama/LLM compatibility endpoints continue to use `OLLAMA_BASE_URL` when Ollama is installed.

## Install dependencies, test, and build

This project intentionally has no external npm runtime dependencies. `npm ci` still validates the lockfile and project metadata. Node runs the `.ts` files directly through native type stripping, so `npm run build` is a no-output compatibility step.

```bash
npm ci
npm run validate
npm run build
```

The tests use Node's built-in test runner and do not require real GPUs, ComfyUI, or Ollama.

## Run locally for a smoke test

For app-only testing without ComfyUI or a GPU:

```bash
IMAGE_BACKEND=mock REQUIRE_IMAGE_API_AUTH=false npm start
```

In another SSH session:

```bash
curl http://127.0.0.1:8000/health | jq
curl http://127.0.0.1:8000/gpus | jq
curl http://127.0.0.1:8000/api/v1/health | jq
curl http://127.0.0.1:8000/openapi.json | jq '.info'
```

Open the portal from a LAN workstation:

```text
http://<server-ip>:8000/
```

## Install the systemd service

A template is included at:

```text
deploy/local-ai-images.service.example
```

The example unit is intended to run under the logged-in Ubuntu user from `/home/<user>/local-ai-images`. Install it by replacing the placeholder with the current username:

```bash
cd "$HOME/local-ai-images"
sed "s/<user>/$USER/g" deploy/local-ai-images.service.example | sudo tee /etc/systemd/system/local-ai-images.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now local-ai-images.service
systemctl status local-ai-images.service --no-pager
```

The example unit uses:

```ini
WorkingDirectory=/home/<user>/local-ai-images
EnvironmentFile=/home/<user>/local-ai-images/.env
ExecStart=/usr/bin/npm start
User=<user>
Group=<user>
ReadWritePaths=/home/<user>/local-ai-images/config /home/<user>/local-ai-images/data /home/<user>/local-ai-images/models
```

For nvm-based Node, edit `/etc/systemd/system/local-ai-images.service`, comment the `/usr/bin/npm` line, uncomment the nvm `ExecStart`, then run:

```bash
sudo systemctl daemon-reload
sudo systemctl restart local-ai-images.service
```

## Confirm port 8000 is reachable

On the server:

```bash
ss -tulpn | grep 8000
curl http://127.0.0.1:8000/health | jq
```

From another LAN machine:

```bash
curl http://<server-ip>:8000/health
```

If the server works locally but not from LAN, check:

```bash
sudo ufw status verbose
ip addr
systemctl status local-ai-images.service --no-pager
journalctl -u local-ai-images.service -e --no-pager
```
