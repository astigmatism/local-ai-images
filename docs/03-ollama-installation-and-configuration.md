# 03 - Optional legacy Ollama compatibility

Local AI Images does **not** require Ollama for normal image-generation operation. The default deployment is ComfyUI-backed and `LEGACY_OLLAMA_ENABLED=false`.

This appendix exists only for operators who still need the reference application's retained compatibility endpoints:

- `GET /models/running`
- `GET /models/installed`
- `GET /config`
- `POST /config`
- `POST /model/load`
- `POST /model/prewarm`
- `POST /api/images/generate`

When legacy mode is disabled, those routes return `LEGACY_OLLAMA_DISABLED`, `/health` is image-focused, `/api/capabilities` is image-focused, and startup does not contact Ollama.

## Enable legacy mode deliberately

Add these settings only if you have installed Ollama separately and need legacy routes:

```dotenv
LEGACY_OLLAMA_ENABLED=true
OLLAMA_BASE_URL=http://127.0.0.1:11434
DEFAULT_MODEL=
PREWARM_DEFAULT_MODEL_ON_START=false
PREWARM_TIMEOUT_MS=120000
PREWARM_KEEP_ALIVE=-1
```

No default LLM model is assumed. Set `DEFAULT_MODEL` only if you want legacy `/model/prewarm` calls without an explicit model body or if you intentionally enable startup prewarm.

## Install Ollama, optional

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama --version
systemctl status ollama --no-pager
```

For a Local AI Images deployment, keep Ollama local-only unless another trusted system explicitly requires direct Ollama access:

```bash
sudo systemctl edit ollama
```

Example local-only override:

```ini
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
```

Restart after changes:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
sudo systemctl status ollama --no-pager
```

## Pull a legacy model, optional

```bash
ollama pull qwen3:14b
ollama list
```

Set the model as the legacy default only if required:

```bash
curl -X POST http://127.0.0.1:8000/config \
  -H 'content-type: application/json' \
  -d '{"default_model":"qwen3:14b"}' | jq .
```

Prewarm explicitly:

```bash
curl -X POST http://127.0.0.1:8000/model/prewarm \
  -H 'content-type: application/json' \
  -d '{"model":"qwen3:14b"}' | jq .
```

## Legacy startup prewarm, optional and off by default

Startup prewarm only runs when both settings are true/non-empty:

```dotenv
LEGACY_OLLAMA_ENABLED=true
PREWARM_DEFAULT_MODEL_ON_START=true
DEFAULT_MODEL=qwen3:14b
```

Do not enable this on a normal ComfyUI image VM. It consumes VRAM and can interfere with image generation.

## Troubleshooting legacy mode

```bash
systemctl status ollama --no-pager
journalctl -u ollama -e --no-pager
curl -sS http://127.0.0.1:11434/api/version | jq .
```

If Local AI Images reports `LEGACY_OLLAMA_DISABLED`, confirm `LEGACY_OLLAMA_ENABLED=true` is present in the same `.env` used by `local-ai-images.service`, then restart:

```bash
sudo systemctl restart local-ai-images.service
```
