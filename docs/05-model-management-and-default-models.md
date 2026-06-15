# 05 - Image model lifecycle, defaults, and workflow management

Local AI Images does not bundle model files. Operators provide local ComfyUI-compatible checkpoints, LoRAs, VAEs, ControlNet models, upscalers, and workflow presets. The portal now separates the full checkpoint lifecycle instead of treating every model list entry as ready-to-use.

## Lifecycle terms used by the portal

| State | Meaning |
| --- | --- |
| Installed | A supported model file exists on disk under one of the configured `IMAGE_MODEL_PATHS` roots. Installed does not mean selected or loaded. |
| Selected | The checkpoint currently chosen in the Generate image form. Selection affects the next request preview and generation request only. |
| Default | The persisted app-level image checkpoint in `config/local-ai-images.json` as `image_default_model`. Generation requests that omit `model` use this default when the selected workflow has a checkpoint-loader mapping. |
| Loaded / prewarmed | A checkpoint that the app has last confirmed by successfully submitting a generation/preload request to the image backend. ComfyUI does not expose a reliable exact “currently loaded checkpoint in VRAM” API, so the portal labels this honestly as **Last confirmed loaded/prewarmed model**. |
| Preload on startup | A persisted boolean, `image_preload_default_on_startup`, that asks the app to load/prewarm the default checkpoint after service restart once ComfyUI is reachable. |
| Missing | A default checkpoint is configured, but the scanner cannot find a matching file on disk. The UI shows a warning and does not mark it as loaded. |

Setting a model as default does not load it. Scanning models does not load them. Loading/prewarming submits a bounded tiny workflow to ComfyUI/mock and records success or failure.

## Directory layout

A simple home-directory layout:

```bash
mkdir -p "$HOME/local-ai-images/models/checkpoints"
mkdir -p "$HOME/local-ai-images/models/loras"
mkdir -p "$HOME/local-ai-images/models/vae"
mkdir -p "$HOME/local-ai-images/models/controlnet"
mkdir -p "$HOME/local-ai-images/models/upscale_models"
mkdir -p "$HOME/local-ai-images/config/workflows"
mkdir -p "$HOME/local-ai-images/data/artifacts"
```

Configure `.env`:

```dotenv
IMAGE_MODEL_PATHS=/home/<user>/local-ai-images/models
COMFYUI_CHECKPOINT_PATH=/home/<user>/local-ai-images/models/checkpoints
COMFYUI_LORA_PATH=/home/<user>/local-ai-images/models/loras
COMFYUI_VAE_PATH=/home/<user>/local-ai-images/models/vae
COMFYUI_CONTROLNET_PATH=/home/<user>/local-ai-images/models/controlnet
COMFYUI_UPSCALER_PATH=/home/<user>/local-ai-images/models/upscale_models
IMAGE_WORKFLOW_PATH=/home/<user>/local-ai-images/config/workflows
IMAGE_ARTIFACT_PATH=/home/<user>/local-ai-images/data/artifacts
IMAGE_DEFAULT_WORKFLOW_ID=sdxl-text-to-image
```

`IMAGE_MODEL_PATHS` controls scanning. It may point at a ComfyUI model root such as `models`, or directly at a category folder such as `models/checkpoints`; files found directly under a configured checkpoints folder are treated as checkpoint models so load/default controls are available. The `COMFYUI_*_PATH` values are the approved install/delete destinations. Delete operations are allowed only inside those approved directories.

## Install a model

Use the portal **Install/download model** form or the API. A checkpoint install target is the configured ComfyUI checkpoint directory, normally `COMFYUI_CHECKPOINT_PATH`.

```bash
export IMAGE_API_URL=http://127.0.0.1:8000
export IMAGE_API_KEY=replace-with-a-long-random-secret

curl -sS -X POST "$IMAGE_API_URL/api/v1/model-downloads" \
  -H "Authorization: Bearer $IMAGE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://example.invalid/path/model.safetensors",
    "type": "checkpoint",
    "file_name": "model.safetensors",
    "set_default": true
  }' | jq .
```

Downloads stream to a `.part` file inside an approved model directory and are renamed into place only after success. The model inventory refreshes after a successful download. `set_default` is honored only for checkpoint downloads.

## Scan installed models

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/models" | jq .

curl -sS -X POST -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/models/refresh" | jq .
```

The scanner reports metadata and UI-ready lifecycle state. It does not load a checkpoint into VRAM. Each installed checkpoint row/card in the portal has **Load / Prewarm now**, **Set as default**, **Set default + preload after restart**, **Delete model**, and **Refresh scan** controls. The current default row also shows **Clear default**.

Important per-model fields returned by `/api/v1/models` include `isDefault`, `isLastConfirmedLoaded`, `canSetDefault`, `canPreload`, `canDelete`, `defaultWarning`, `loadedStatus`, and `deletePreview`.

## Set a checkpoint as default

Portal: click **Set as default** on an installed checkpoint row/card, or click **Set selected checkpoint as default** in the Generate image form.

API:

```bash
curl -sS -X POST "$IMAGE_API_URL/api/v1/models/default" \
  -H "Authorization: Bearer $IMAGE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"model.safetensors"}' | jq .
```

Clear it:

```bash
curl -sS -X DELETE -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/models/default" | jq .
```

The default is persisted in the JSON config file and survives app restart. It is distinct from the optional legacy Ollama `default_model`.

## Load or prewarm a checkpoint now

Portal: click **Load / Prewarm now** on the checkpoint row/card, click **Load default now** in the default status panel, or click **Load selected checkpoint now** in the Generate image form.

API:

```bash
curl -sS -X POST "$IMAGE_API_URL/api/v1/models/preload" \
  -H "Authorization: Bearer $IMAGE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"model.safetensors"}' | jq .
```

Omit `model` to preload the configured default:

```bash
curl -sS -X POST "$IMAGE_API_URL/api/v1/models/preload" \
  -H "Authorization: Bearer $IMAGE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{}' | jq .
```

The preload request validates that the target exists and is a checkpoint, waits for the image backend within `IMAGE_PRELOAD_TIMEOUT_MS`, submits a small preload workflow, and records success or failure in `/api/v1/models/preload`. The button remains visible for checkpoint files; if the selected preload workflow is missing a checkpoint-loader mapping, the backend reports that workflow configuration error instead of pretending the model was loaded.

## Set default and enable preload after restart

Portal: click **Set default + preload after restart** on a checkpoint row/card, or click **Set selected default + preload after restart** in the Generate image form.

API:

```bash
curl -sS -X POST "$IMAGE_API_URL/api/v1/models/default" \
  -H "Authorization: Bearer $IMAGE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"model.safetensors","preload_on_startup":true}' | jq .
```

Enable or disable preload after restart independently:

```bash
curl -sS -X POST "$IMAGE_API_URL/api/v1/models/preload/startup" \
  -H "Authorization: Bearer $IMAGE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"enabled":true}' | jq .

curl -sS -X POST "$IMAGE_API_URL/api/v1/models/preload/startup" \
  -H "Authorization: Bearer $IMAGE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"enabled":false}' | jq .
```

On app startup, when preload after restart is enabled and the default checkpoint exists, Local AI Images starts normally, waits for ComfyUI/mock to become reachable within the preload timeout, then runs a bounded background preload job. The web app does not block indefinitely if ComfyUI is unavailable. Startup logs include preload started, succeeded, skipped, or failed messages, and the portal default status panel shows the last attempt.

## Verify loaded/prewarmed status

Portal: read the **Default model status** panel. It shows:

- Current default checkpoint.
- Whether the default file exists.
- Whether preload after restart is enabled.
- Last preload attempt time.
- Last preload result.
- Last preload error, if any.
- Last confirmed loaded/prewarmed model.

API:

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/models/preload" | jq .
```

`lastConfirmedLoadedModel` is updated after a successful manual preload, preload after restart, or generation. If ComfyUI unloads a model later because of memory pressure or manual ComfyUI work, Local AI Images cannot observe that directly; it will still show the last checkpoint it successfully confirmed.

## Delete a model safely

Portal: click **Delete model** on a model row/card. The confirmation prompt shows the exact file name, model type, and size. Type the exact file name to continue.

API:

```bash
curl -sS -X DELETE "$IMAGE_API_URL/api/v1/models/model.safetensors" \
  -H "Authorization: Bearer $IMAGE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"confirm_file_name":"model.safetensors"}' | jq .
```

Safety rules:

- Deletes are limited to files inside approved ComfyUI model directories.
- No arbitrary path deletion and no shell execution are used.
- Path traversal is rejected by inventory lookup and path validation.
- The exact file name must be confirmed.
- Deleting the current default is blocked unless the default is cleared first or `delete_and_clear_default=true` is sent.
- The model inventory refreshes after delete.

Delete the current default and clear it in one explicit request:

```bash
curl -sS -X DELETE "$IMAGE_API_URL/api/v1/models/model.safetensors" \
  -H "Authorization: Bearer $IMAGE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"confirm_file_name":"model.safetensors","delete_and_clear_default":true}' | jq .
```

## Generate image form integration

The Generate image form defaults the checkpoint dropdown to the configured default when present. Dropdown labels show default and last loaded/prewarmed badges. The raw request preview clearly shows the model that will be sent. If no model is selected and no default exists, the portal warns before generation.

Generate image form controls:

- **Load selected checkpoint now**: prewarms the selected checkpoint.
- **Set selected checkpoint as default**: persists the selected checkpoint as the default.
- **Set selected default + preload after restart**: sets the selected checkpoint as default and enables preload after restart.

Successful generation updates the last confirmed loaded/prewarmed model because the backend accepted and ran a request using that checkpoint.

## Workflow presets

Workflow presets hide raw ComfyUI graph JSON behind stable application-level request fields such as `prompt`, `negative_prompt`, `width`, `height`, `steps`, `cfg_scale`, and `model`.

The repository includes a sample preset:

```text
config/workflows/sdxl-text-to-image.example.json
```

Copy or adapt it into the configured workflow path and update checkpoint names/mappings to match local models. A workflow should expose a checkpoint-loader mapping for default/preload model substitution. Without that mapping, generation can still run with the workflow's baked-in checkpoint, but explicit default/preload substitution will report a workflow configuration error.

## New API endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/models` | Scan/read installed model inventory with default/preload/delete state. |
| `POST` | `/api/v1/models/refresh` | Force a disk scan. |
| `POST` | `/api/v1/models/default` | Set a checkpoint as default; optional `preload_on_startup`. |
| `DELETE` | `/api/v1/models/default` | Clear the default checkpoint. |
| `GET` | `/api/v1/models/preload` | Read default and preload status. |
| `POST` | `/api/v1/models/preload` | Load/prewarm a checkpoint now. |
| `POST` | `/api/v1/models/preload/startup` | Enable or disable preload after restart. |
| `DELETE` | `/api/v1/models/{modelId}` | Safely delete an installed model file. |
| `GET`/`POST` | `/api/v1/model-downloads` | Existing model download/install job API. |

## New environment variables

| Variable | Default | Used for |
| --- | --- | --- |
| `IMAGE_DEFAULT_MODEL` | empty | Initial/fallback image checkpoint default when the config file has no `image_default_model`. |
| `IMAGE_PRELOAD_DEFAULT_ON_STARTUP` | `false` | Initial/fallback preload-after-restart setting when the config file has no `image_preload_default_on_startup`. |
| `IMAGE_PRELOAD_TIMEOUT_MS` | `120000` | Bound for manual and preload after restart attempts. |
| `IMAGE_PRELOAD_WORKFLOW_ID` | `IMAGE_DEFAULT_WORKFLOW_ID` | Workflow preset used for preload requests. |
| `IMAGE_PRELOAD_WIDTH` | `512` | Preload request width. |
| `IMAGE_PRELOAD_HEIGHT` | `512` | Preload request height. |
| `IMAGE_PRELOAD_STEPS` | `1` | Preload request step count. |
| `IMAGE_PRELOAD_KEEP_ARTIFACT` | `false` | Whether to keep the tiny preload artifact in artifact storage. |

## No default LLM model

The default Local AI Images runtime does not use `DEFAULT_MODEL`, does not prewarm a language model, and does not contact Ollama. Optional legacy Ollama model state is documented separately in [03 - Optional legacy Ollama compatibility](03-ollama-installation-and-configuration.md).
