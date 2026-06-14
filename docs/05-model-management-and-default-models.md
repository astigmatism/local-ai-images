# 05 - Model management and default models

## Config file behavior

The app stores local configuration in JSON:

```json
{
  "default_model": "qwen3:14b"
}
```

The path is controlled by `CONFIG_PATH`.

Startup behavior:

1. The app reads `CONFIG_PATH`.
2. If the file does not exist, the app creates it using `DEFAULT_MODEL` from `.env`.
3. If `DEFAULT_MODEL` is unset, the app uses its documented fallback.
4. If startup pre-warm is enabled, the app asks Ollama to pre-warm `default_model` after the HTTP service starts.

## Portal workflows

Open:

```text
http://<server-ip>:8000/
```

The portal shows:

- Monitor service state.
- Ollama connectivity and version when available.
- Current default model.
- Whether the default model appears in Ollama's running model list.
- Running models from Ollama `/api/ps`.
- Installed models from Ollama `/api/tags`.
- All detected NVIDIA GPUs from `/gpus`.
- Controls to save the default model.
- Controls to load/pre-warm a model and optionally make it default.
- A button to pre-warm the default model.

## API: read config

```bash
curl http://127.0.0.1:8000/config | jq
```

Example:

```json
{
  "ok": true,
  "config": {
    "default_model": "qwen3:14b"
  },
  "path": "/opt/local-ai-llm/config/local-ai-llm.json"
}
```

## API: update default model

```bash
curl -X POST http://127.0.0.1:8000/config \
  -H 'Content-Type: application/json' \
  -d '{"default_model":"qwen3:14b"}' | jq
```

This only changes the app config. It does not pull the model and does not guarantee the model is loaded.

## API: load/pre-warm a model

```bash
curl -X POST http://127.0.0.1:8000/model/load \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3:14b","make_default":false}' | jq
```

Suggested success shape:

```json
{
  "ok": true,
  "model": "qwen3:14b",
  "made_default": false,
  "loaded": true,
  "default_model": "qwen3:14b"
}
```

To load and make default:

```bash
curl -X POST http://127.0.0.1:8000/model/load \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3:14b","make_default":true}' | jq
```

## API: pre-warm default model

```bash
curl -X POST http://127.0.0.1:8000/model/prewarm \
  -H 'Content-Type: application/json' \
  -d '{}' | jq
```

To pre-warm a specific model without changing the default:

```bash
curl -X POST http://127.0.0.1:8000/model/prewarm \
  -H 'Content-Type: application/json' \
  -d '{"model":"llama3.2:latest"}' | jq
```

## How pre-warming works

The app calls Ollama's native API instead of shelling out to `ollama`:

```text
POST <OLLAMA_BASE_URL>/api/generate
```

Body:

```json
{
  "model": "qwen3:14b",
  "stream": false,
  "keep_alive": -1
}
```

Ollama treats this as an empty model request and loads the model without a normal prompt. The app then checks `/api/ps` and sets `loaded` based on whether the requested model appears in the running model list.

## Startup pre-warm

Controlled by:

```text
PREWARM_DEFAULT_MODEL_ON_START=true
PREWARM_TIMEOUT_MS=120000
PREWARM_KEEP_ALIVE=-1
```

On service start, the app:

1. Starts listening on port `8000`.
2. Reads the default model from config.
3. Asynchronously asks Ollama to pre-warm it.
4. Logs success or failure to the app journal.

The HTTP service starts even if pre-warming fails. This is intentional so an operator can use the portal to inspect and repair the system.

## Validation rules

Model names must:

- Be strings.
- Be 1 to 128 characters.
- Start with a letter or number.
- Use only letters, numbers, dot, dash, underscore, slash, and colon.

Invalid requests return FastAPI-style `422` responses:

```json
{
  "detail": [
    {
      "loc": ["body", "model"],
      "msg": "String should have at least 1 character",
      "type": "string_too_short",
      "input": "",
      "ctx": { "min_length": 1 }
    }
  ]
}
```

## Pulling models

This monitor does not automatically pull models during `/model/load`. Pull intentionally through Ollama first:

```bash
ollama pull qwen3:14b
```

Then load/pre-warm through the portal or API. This avoids accidental huge downloads from a control API call.
