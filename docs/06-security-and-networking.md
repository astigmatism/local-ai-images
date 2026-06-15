# 06 - Security and networking

## LAN-only assumption

Local AI Images controls local GPU workloads and can create large image artifacts. Do not expose it directly to the public internet.

Expected services for normal image-generation deployment:

| Service | Port | Typical bind | Notes |
|---|---:|---|---|
| SSH | 22 | LAN/server address | Administrative access |
| ComfyUI | 8188 | `127.0.0.1` | Raw backend, local-only |
| Local AI Images portal/API | 8000 | `0.0.0.0` on trusted LAN | Control panel and `/api/v1` image API |

## Bind address choices

### Local AI Images portal/API

The orchestrator should use the Local AI Images API on `0.0.0.0:8000` or through a reverse proxy.

`.env`:

```text
HOST=0.0.0.0
PORT=8000
```

For single-machine-only use:

```text
HOST=127.0.0.1
PORT=8000
```

### ComfyUI

Keep raw ComfyUI local-only:

```bash
python main.py --listen 127.0.0.1 --port 8188
```

`.env`:

```text
COMFYUI_BASE_URL=http://127.0.0.1:8188
```

## Firewall guidance

Allow only known LAN ranges. Example for `192.168.1.0/24`:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp
sudo ufw allow from 192.168.1.0/24 to any port 8000 proto tcp
sudo ufw enable
sudo ufw status verbose
```

If the orchestrator has a fixed IP, restrict to that IP instead of the whole LAN:

```bash
sudo ufw allow from <orchestrator-ip> to any port 8000 proto tcp
```

Do not open `8188/tcp` unless you intentionally want direct ComfyUI access from another trusted host.

## API authentication

Use API keys for every LAN deployment:

```dotenv
IMAGE_API_KEYS=replace-with-a-long-random-secret
REQUIRE_IMAGE_API_AUTH=true
```

Clients may send either:

```text
Authorization: Bearer <key>
X-API-Key: <key>
```

The static dashboard can load without a key, but its `/api/v1` calls require the key when auth is enabled. The key is stored only in browser local storage.

## Risks of broad exposure

Broad exposure can allow unknown users to:

- Use local GPUs and CPU heavily.
- Trigger long-running image jobs and VRAM pressure.
- Exhaust disk with generated artifacts.
- Query local model inventory and workflow metadata.
- Submit prompts and retrieve generated outputs.

This version intentionally does not expose arbitrary shell command execution, model download endpoints, or destructive system-control endpoints.

## SSH hardening notes

Common SSH hardening steps:

```bash
sudo cp /etc/ssh/sshd_config /etc/ssh/sshd_config.backup
sudo nano /etc/ssh/sshd_config
```

Consider:

```text
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

Apply carefully:

```bash
sudo sshd -t
sudo systemctl reload ssh
```

Keep an existing SSH session open while testing a new one.

## Logging guidance

The app redacts `authorization` and `cookie` headers from request logs. Avoid placing secrets in URLs, model names, or `.env` values that will be printed in logs.

View logs:

```bash
journalctl -u local-ai-images.service -f
```

Optional legacy Ollama logs are relevant only when `LEGACY_OLLAMA_ENABLED=true` and an Ollama service is installed separately.
