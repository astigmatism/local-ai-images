# 03 - Ollama installation and configuration

## Install Ollama

Install with the official Linux installer:

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

Verify the binary and service:

```bash
ollama --version
systemctl status ollama --no-pager
curl http://127.0.0.1:11434/api/version
```

## Configure Ollama service bind address

The orchestrator expects Ollama on port `11434`. For a LAN-only appliance, Ollama may bind to all interfaces, but do not expose it to the public internet.

Create a systemd override:

```bash
sudo systemctl edit ollama
```

Example override:

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
```

Apply it:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
sudo systemctl status ollama --no-pager
ss -tulpn | grep 11434
```

If only local processes need Ollama, prefer:

```ini
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
```

## Optional: restrict GPU visibility

Ollama can see all supported NVIDIA GPUs by default. To restrict it to a subset, set `CUDA_VISIBLE_DEVICES` in the Ollama service override. UUIDs are safer than numeric IDs.

First list UUIDs:

```bash
nvidia-smi -L
```

Then use an override like:

```ini
[Service]
Environment="CUDA_VISIBLE_DEVICES=GPU-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee,GPU-ffffffff-1111-2222-3333-444444444444"
```

For a quick numeric test only:

```ini
[Service]
Environment="CUDA_VISIBLE_DEVICES=0,1"
```

Restart Ollama after changing service environment:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

## Pull a model

Choose a model that fits the available VRAM and your latency needs. Example:

```bash
ollama pull qwen3:14b
```

Other examples:

```bash
ollama pull llama3.2:latest
ollama pull gemma3:4b
```

List local models:

```bash
ollama list
curl http://127.0.0.1:11434/api/tags | jq
```

## Test generation

```bash
ollama run qwen3:14b "Say hello in one sentence."
```

Or through the API:

```bash
curl http://127.0.0.1:11434/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3:14b","prompt":"Say hello in one sentence.","stream":false}' | jq
```

## Load or pre-warm without a long generation

Ollama supports preloading a model by sending an empty API request. This project uses:

```json
{
  "model": "qwen3:14b",
  "stream": false,
  "keep_alive": -1
}
```

against:

```text
POST /api/generate
```

This causes Ollama to load the model but avoids a real prompt that would generate a long response. `keep_alive` controls how long Ollama keeps the model resident after the request. In this repository the value comes from `PREWARM_KEEP_ALIVE`; `.env.example` uses `-1`, meaning keep loaded until Ollama unloads/stops according to its lifecycle behavior.

Manual pre-warm test:

```bash
curl http://127.0.0.1:11434/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3:14b","stream":false,"keep_alive":-1}' | jq
```

Then check loaded models:

```bash
curl http://127.0.0.1:11434/api/ps | jq
ollama ps
```

## Verify GPU acceleration

Open two SSH sessions.

Session 1:

```bash
watch -n 1 nvidia-smi
```

Session 2:

```bash
ollama run qwen3:14b "Write a short paragraph about local AI."
```

GPU memory usage should increase while the model is loaded. If it does not, inspect Ollama logs:

```bash
journalctl -u ollama -e --no-pager
```

## Multi-GPU considerations

- Ollama discovers supported GPUs at service startup.
- Use `CUDA_VISIBLE_DEVICES` to limit which NVIDIA GPUs Ollama can use.
- UUIDs are preferred for persistent selection because numeric indices can change.
- Some models fit entirely on one GPU; some may be split/offloaded depending on memory and Ollama behavior.
- A mixed RTX 3090 + RTX 4080 setup has asymmetric VRAM; model placement and performance can differ per model.
- Increasing context length increases memory pressure.
- Quantized models usually fit better than full-precision models.

## Default model strategy

Ollama itself does not need to know this project's default model. Local AI Images stores the default model in its own JSON config file and uses Ollama's API to pre-warm that model on startup when enabled.

The app default model is controlled by:

1. The persisted JSON config at `CONFIG_PATH`.
2. `DEFAULT_MODEL` from `.env` when the config file does not exist yet.
3. A fallback used by the application if neither is provided.

The example default in `.env.example` is `qwen3:14b`; change it to a model that is pulled and suitable for the host.
