# 05 - Image model and workflow management

Local AI Images does not bundle model files. Operators provide local ComfyUI-compatible checkpoints, LoRAs, VAEs, ControlNet models, and workflow presets.

## Directory layout

A simple home-directory layout:

```bash
mkdir -p "$HOME/local-ai-images/models/checkpoints"
mkdir -p "$HOME/local-ai-images/models/loras"
mkdir -p "$HOME/local-ai-images/models/vae"
mkdir -p "$HOME/local-ai-images/models/controlnet"
mkdir -p "$HOME/local-ai-images/config/workflows"
mkdir -p "$HOME/local-ai-images/data/artifacts"
```

Configure `.env`:

```dotenv
IMAGE_MODEL_PATHS=/home/<user>/local-ai-images/models
IMAGE_WORKFLOW_PATH=/home/<user>/local-ai-images/config/workflows
IMAGE_ARTIFACT_PATH=/home/<user>/local-ai-images/data/artifacts
IMAGE_DEFAULT_WORKFLOW_ID=sdxl-text-to-image
```

You can also point `IMAGE_MODEL_PATHS` at existing ComfyUI model directories or a shared model volume. Multiple paths can be separated by commas, semicolons, or colons.

## Model inventory API

Scan configured paths:

```bash
export IMAGE_API_URL=http://127.0.0.1:8000
export IMAGE_API_KEY=replace-with-a-long-random-secret

curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/models" | jq .

curl -sS -X POST -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/models/refresh" | jq .
```

The scanner reports metadata only. It does not load models into VRAM and does not validate that a checkpoint is compatible with a specific workflow.

## Workflow presets

Workflow presets hide raw ComfyUI graph JSON behind stable application-level request fields such as `prompt`, `negative_prompt`, `width`, `height`, `steps`, `cfg_scale`, and `model`.

The repository includes a sample preset:

```text
config/workflows/sdxl-text-to-image.example.json
```

Copy or adapt it into the configured workflow path and update checkpoint names/mappings to match local models.

List workflows:

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/workflows" | jq .
```

Inspect one workflow:

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/workflows/sdxl-text-to-image" | jq .
```

## First generation request

```bash
curl -sS -X POST "$IMAGE_API_URL/api/v1/generate" \
  -H "Authorization: Bearer $IMAGE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "prompt": "cinematic photo of a small cabin in snowy mountains",
    "workflow_id": "sdxl-text-to-image",
    "width": 1024,
    "height": 1024,
    "steps": 25,
    "output": "url",
    "sync_timeout_ms": 1000
  }' | jq .
```

If the response is `202`, poll the returned `status_url` or `result_url`.

## Artifact storage

Generated image files and JSON sidecars are written under `IMAGE_ARTIFACT_PATH`. Do not commit this directory.

Retrieve bytes:

```bash
curl -L -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/artifacts/ARTIFACT_ID" --output output.png
```

Retrieve metadata:

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/artifacts/ARTIFACT_ID?metadata=1" | jq .
```

## No default LLM model

The default Local AI Images runtime does not use `DEFAULT_MODEL`, does not prewarm a language model, and does not contact Ollama. Optional legacy Ollama model state is documented separately in [03 - Optional legacy Ollama compatibility](03-ollama-installation-and-configuration.md).
