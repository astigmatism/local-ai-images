# 06 - Security and networking

## LAN-only assumption

This project assumes a trusted LAN or lab network. Ollama and the monitor portal are powerful local services. Do not expose either service directly to the public internet.

Expected services:

| Service | Port | Typical bind | Notes |
|---|---:|---|---|
| SSH | 22 | LAN/server address | Administrative access |
| Ollama | 11434 | `127.0.0.1` or LAN | LLM API and model management |
| Monitor/portal | 8000 | `0.0.0.0` on LAN | Compatibility API and web controls |

## Bind address choices

### Monitor portal

The orchestrator expects the monitor/control API on `0.0.0.0:8000`.

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

### Ollama

For orchestrator access to Ollama directly:

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
```

For monitor-only local access:

```ini
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
```

The monitor itself can still talk to Ollama locally with:

```text
OLLAMA_BASE_URL=http://127.0.0.1:11434
```

## Firewall guidance

Allow only known LAN ranges. Example for `192.168.1.0/24`:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp
sudo ufw allow from 192.168.1.0/24 to any port 11434 proto tcp
sudo ufw allow from 192.168.1.0/24 to any port 8000 proto tcp
sudo ufw enable
sudo ufw status verbose
```

If the orchestrator has a fixed IP, restrict to that IP instead of the whole LAN:

```bash
sudo ufw allow from <orchestrator-ip> to any port 11434 proto tcp
sudo ufw allow from <orchestrator-ip> to any port 8000 proto tcp
```

## Risks of broad exposure

Broad exposure can allow unknown users to:

- Use local GPUs and CPU heavily.
- Trigger large model loads and memory pressure.
- Query installed/running model information.
- Access model APIs that may process sensitive prompts.
- Exhaust disk, VRAM, or bandwidth if future model pull endpoints are added.

This version intentionally does not expose arbitrary shell command execution or destructive system-control endpoints.

## Authentication strategy

Authentication is not enabled by default because the legacy orchestrator compatibility contract expects unauthenticated access to `/health`, `/gpu`, and `/model/load`.

Recommended future-safe deployment patterns:

1. Keep the service LAN-only and firewall-restricted.
2. Put a reverse proxy such as Nginx, Caddy, or Traefik in front of the portal if users need browser access from less trusted networks.
3. Add basic auth, mTLS, VPN, or SSO at the proxy layer.
4. Keep orchestrator compatibility by allowing only the orchestrator IP to reach unauthenticated API paths.

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
journalctl -u local-ai-llm -f
journalctl -u ollama -f
```
