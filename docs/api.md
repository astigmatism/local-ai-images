# Image-generation API

The `/api/v1` API is the stable machine-to-machine surface for local image generation. It hides raw ComfyUI workflow JSON behind workflow presets and normalized request fields, while still allowing operators to add or edit ComfyUI presets on disk.

## Authentication

Set `IMAGE_API_KEYS` in `.env` and send one of these headers:

```http
Authorization: Bearer <key>
X-API-Key: <key>
```

If `IMAGE_API_KEYS` is empty and `REQUIRE_IMAGE_API_AUTH=false`, `/api/v1` runs open for development. Production LAN deployments should set both `IMAGE_API_KEYS` and `REQUIRE_IMAGE_API_AUTH=true`.

## Health and capacity

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/health" | jq .
```

Returns app version, enabled/backend state, engine health, GPU telemetry summary, queue counts, model paths, workflow count, and auth state.

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/stats" | jq .
```

Returns engine health, GPU stats, queue stats, and recent jobs.

## Capabilities

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/capabilities" | jq .
```

Key fields:

- `backend`: `comfyui` or `mock`.
- `generation.async_jobs`: always true.
- `generation.sync_timeout`: true.
- `generation.output_delivery`: `metadata`, `url`, `base64`, and `binary`.
- `workflows`: stable workflow preset summaries.

## Model inventory

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/models" | jq .

curl -sS -X POST -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/models/refresh" | jq .
```

The scanner reads `IMAGE_MODEL_PATHS` and reports known local model file extensions such as `.safetensors`, `.ckpt`, `.pt`, `.pth`, `.bin`, `.gguf`, and `.onnx`. It does not download, validate, or mutate models.

## Workflow presets

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/workflows" | jq .

curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/workflows/sdxl-text-to-image" | jq .
```

The public response shows preset metadata, defaults, supported parameters, and internal mapping IDs. It intentionally does not require callers to submit raw ComfyUI JSON.

Operator presets live in `IMAGE_WORKFLOW_PATH` as JSON files. A preset can override the built-in `sdxl-text-to-image` ID or define new IDs. The app maps request fields onto nodes listed in `comfyui.mappings`.

## Submit generation job

Asynchronous request:

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "prompt":"a cinematic photo of a lunar greenhouse",
    "negative_prompt":"blurry, low quality",
    "model":"sd_xl_base_1.0.safetensors",
    "workflow_id":"sdxl-text-to-image",
    "width":1024,
    "height":1024,
    "steps":28,
    "cfg_scale":7,
    "seed":-1,
    "output":"url",
    "sync_timeout_ms":0,
    "metadata":{"caller":"gateway-a"}
  }' \
  "$IMAGE_API_URL/api/v1/generate" | jq .
```

A `202` response means the job was accepted and is still queued or running. Poll `status_url` or `result_url`.

Synchronous request:

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"prompt":"a watercolor fox in a library","model":"sd_xl_base_1.0.safetensors","sync_timeout_ms":60000,"output":"base64"}' \
  "$IMAGE_API_URL/api/v1/generate" | jq .
```

If the job completes within `sync_timeout_ms`, the API returns `200`. If not, it returns `202` with job URLs. The timeout is bounded by `IMAGE_MAX_SYNC_TIMEOUT_MS`.

## Request fields

| Field | Type | Notes |
| --- | --- | --- |
| `prompt` | string | Required. Trimmed. Limited by `IMAGE_GENERATION_MAX_PROMPT_CHARS`. |
| `negative_prompt` | string | Optional. |
| `model` | string | Optional ComfyUI checkpoint name/path. Defaults to the workflow checkpoint. |
| `workflow_id` | string | Defaults to `IMAGE_DEFAULT_WORKFLOW_ID`. |
| `width`, `height` | integer | 64 to 4096. Defaults come from the workflow. |
| `steps` | integer | 1 to 150. |
| `cfg_scale` | number | 0 to 30. |
| `seed` | integer | Use `-1` or omit for a local random seed. |
| `sampler_name` | string | Defaults to workflow sampler. |
| `scheduler` | string | Defaults to workflow scheduler. |
| `output` | string | `metadata`, `url`, `base64`, or `binary`. |
| `sync_timeout_ms` | integer | `0` for async-only. |
| `metadata` | object | Caller metadata persisted in job/artifact metadata. |

## Jobs

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/jobs?limit=20" | jq .

curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/jobs/JOB_ID" | jq .
```

Retrieve result:

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/jobs/JOB_ID/result?format=url" | jq .
```

For binary result delivery:

```bash
curl -L -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/jobs/JOB_ID/result?format=binary" \
  --output result.png
```

Cancel queued or running jobs:

```bash
curl -sS -X POST -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/jobs/JOB_ID/cancel" | jq .
```

ComfyUI cancellation uses ComfyUI's interrupt endpoint, which is process-wide. Avoid running unrelated manual ComfyUI work on the same backend when orchestrated cancellations are expected.

## Artifacts

Artifact bytes:

```bash
curl -L -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/artifacts/ARTIFACT_ID" \
  --output output.png
```

Artifact metadata:

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/artifacts/ARTIFACT_ID?metadata=1" | jq .
```

Artifact metadata includes job ID, model, workflow ID, prompt, negative prompt, seed, request options, provider metadata, and artifact URL. Internal filesystem paths are removed from API responses.

## Legacy endpoints

The original LLM/Ollama monitor endpoints remain available: `/health`, `/gpu`, `/gpus`, `/models/running`, `/models/installed`, `/config`, `/model/load`, `/model/prewarm`, and `/api/images/generate`. New image integrations should use `/api/v1/*`.
