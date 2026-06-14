# 04 - Application installation

## Install Node 24

This project is designed for Node 24-compatible runtime behavior and uses Node 24 native TypeScript type stripping. Do not rely on Ubuntu's default Node package unless it provides Node 24 on your host.

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

Confirm major version 24:

```bash
node -p "process.versions.node"
```

## Clone the repository

Recommended production location:

```bash
sudo mkdir -p /opt/local-ai-llm
sudo chown "$USER":"$USER" /opt/local-ai-llm
git clone https://github.com/astigmatism/local-ai-llm.git /opt/local-ai-llm
cd /opt/local-ai-llm
```

If you received a zip package instead of cloning directly, unpack it into `/opt/local-ai-llm` and initialize/push to the GitHub repository as needed.

## Configure environment

```bash
cp .env.example .env
nano .env
```

Important settings:

```text
PORT=8000
HOST=0.0.0.0
OLLAMA_BASE_URL=http://127.0.0.1:11434
CONFIG_PATH=./config/local-ai-llm.json
DEFAULT_MODEL=qwen3:14b
PREWARM_DEFAULT_MODEL_ON_START=true
PREWARM_TIMEOUT_MS=120000
PREWARM_KEEP_ALIVE=-1
GPU_QUERY_TIMEOUT_MS=5000
LOG_LEVEL=info
```

Use an absolute `CONFIG_PATH` for systemd deployments if you prefer:

```text
CONFIG_PATH=/opt/local-ai-llm/config/local-ai-llm.json
```

## Install dependencies, test, and build

This project intentionally has no external npm runtime dependencies. `npm ci` still validates the lockfile and project metadata. Node 24 runs the `.ts` files directly through native type stripping, so `npm run build` is a no-output compatibility step.

```bash
npm ci
npm run validate
npm run build
```

The tests use Node's built-in test runner and do not require real GPUs or a running Ollama service.

## Run locally for a smoke test

```bash
npm start
```

In another SSH session:

```bash
curl http://127.0.0.1:8000/health | jq
curl http://127.0.0.1:8000/gpus | jq
curl http://127.0.0.1:8000/openapi.json | jq '.info'
```

Open the portal from a LAN workstation:

```text
http://<server-ip>:8000/
```

## Create a service user

Use a dedicated unprivileged account:

```bash
sudo useradd --system --home /opt/local-ai-llm --shell /usr/sbin/nologin local-ai-llm || true
sudo chown -R local-ai-llm:local-ai-llm /opt/local-ai-llm
```

The monitor only reads GPU telemetry through `nvidia-smi` and talks to Ollama through HTTP. It does not need root.

## Install the systemd service

A template is included at:

```text
deploy/local-ai-llm.service.example
```

Install it:

```bash
sudo cp deploy/local-ai-llm.service.example /etc/systemd/system/local-ai-llm.service
sudo systemctl daemon-reload
sudo systemctl enable --now local-ai-llm
sudo systemctl status local-ai-llm --no-pager
```

The example unit uses:

```ini
WorkingDirectory=/opt/local-ai-llm
EnvironmentFile=-/opt/local-ai-llm/.env
ExecStart=/usr/bin/npm start
User=local-ai-llm
Group=local-ai-llm
ReadWritePaths=/opt/local-ai-llm/config
```

Adjust paths if you deploy somewhere else.

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
systemctl status local-ai-llm --no-pager
journalctl -u local-ai-llm -e --no-pager
```
