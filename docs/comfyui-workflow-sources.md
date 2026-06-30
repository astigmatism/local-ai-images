# Compatible ComfyUI workflow generation sources

The image-generation portal has one **Generation source** selector. A source can be either:

- a checkpoint that has passed the app's text-to-image compatibility probe, or
- a registered ComfyUI workflow preset that the app can safely fill from the standard portal controls.

The portal intentionally does **not** list every file in a model directory and does **not** treat status strings as model names. Failed prewarm/probe messages such as `prewarm failed, ComfyUI prompt returned HTTP 400` are status/errors only; they are never selectable generation sources.

## Checkpoint discovery and probing

At backend startup, and whenever `/api/v1/generation-sources` or `/api/v1/generation-sources/refresh` needs source data, the generation-source registry scans the configured `IMAGE_MODEL_PATHS` inventory and builds a checkpoint candidate list.

Before a checkpoint is probed, the app excludes obvious invalid candidates:

- directories and non-files,
- files without checkpoint-like extensions (`.safetensors`, `.ckpt`, `.pt`, `.pth`),
- metadata, logs, configs, temporary/partial downloads, and status/error-looking file names,
- files located in known non-checkpoint folders such as `loras`, `vae`, `controlnet`, `embeddings`, `upscale_models`, `clip`, and `text_encoder`,
- filenames that look like LoRA, VAE-only, ControlNet, embedding, CLIP/text-encoder, or upscaler assets.

For each remaining candidate, the app runs a bounded compatibility probe. The preferred first check is ComfyUI's `CheckpointLoaderSimple` object info, which confirms that ComfyUI itself exposes the candidate as a checkpoint choice. The app then runs a tiny text-to-image probe through the configured preload/default workflow using a low step count, small dimensions, and a deterministic seed. A checkpoint is selectable only after that probe succeeds.

Probe results are cached in memory with the checkpoint identifier, file path, file modification timestamp, size, status (`pending`, `valid`, `invalid`, or `error`), probe timestamp, and failure reason. The cache is invalidated when the file signature changes, when a file disappears, or when a rescan is requested. This first implementation does not persist the cache across process restarts.

The probe queue is intentionally conservative: one checkpoint is probed at a time, each probe has a timeout, and a bad checkpoint does not block app startup. While probing is active, the frontend shows a compact probing/loading state and only renders sources whose status is valid.

### Refreshing checkpoint probes

The portal refresh control triggers `/api/v1/generation-sources/refresh`, which rescans models/workflows and schedules a fresh safe probe pass. You can also call it directly:

```bash
curl -X POST http://127.0.0.1:3000/api/v1/generation-sources/refresh
```

If API authentication is enabled, include the same bearer token or `X-API-Key` header used for other `/api/v1` image routes.

### Why a checkpoint may not appear

A checkpoint is hidden from the selector when it is not eligible or when its probe fails. Common reasons include:

- the file is in the wrong ComfyUI model subfolder,
- the file is a LoRA, VAE, ControlNet, embedding, text encoder, upscaler, config, log, metadata file, or partial download,
- ComfyUI does not list it as a `CheckpointLoaderSimple` checkpoint,
- the default/preload workflow cannot insert the checkpoint,
- ComfyUI returned HTTP 400 during prompt validation/submission,
- ComfyUI was unavailable or timed out during the probe,
- the file changed and is waiting to be re-probed.

Check backend logs or the `/api/v1/health` and `/api/v1/generation-sources` status sections for probe counts. Failure reasons are kept in logs/status/debug data, not in dropdown labels.

## Workflow source registry

Workflow/subgraph generation sources are explicit workflow presets. The app does not blindly treat every ComfyUI workflow JSON file as compatible.

Workflow presets are loaded from the built-in registry and from JSON files in `IMAGE_WORKFLOW_PATH`. A preset must pass structural compatibility checks before it appears in the selector. Invalid registry files are skipped and logged as workflow load warnings so one bad workflow file does not break the portal.

A workflow source summary returned by `/api/v1/generation-sources` includes:

- `id`, for example `workflow:sdxl-text-to-image`,
- `type: "workflow"`,
- display label,
- `workflowId`,
- optional default `checkpointName`,
- capabilities such as text-to-image, seed support, and checkpoint support.

## Required standard inputs

A compatible workflow must accept the same core controls used by the portal:

- positive prompt,
- negative prompt,
- width,
- height,
- steps,
- CFG scale,
- seed.

In the current ComfyUI preset format, those values are mapped onto known node IDs in `comfyui.mappings` or inferred from conventional node classes:

- `positivePromptNode` points to a `CLIPTextEncode` node whose `text` input receives the positive prompt,
- `negativePromptNode` points to a `CLIPTextEncode` node whose `text` input receives the negative prompt,
- `latentImageNode` points to an `EmptyLatentImage` node whose `width` and `height` inputs are updated,
- `samplerNode` points to a `KSampler` node whose `seed`, `steps`, `cfg`, `sampler_name`, and `scheduler` inputs are updated,
- `saveImageNode` points to a `SaveImage` node whose `filename_prefix` is set by the app.

If a mapping is omitted, the app tries to infer common node classes in the default order. Explicit mappings are safer and recommended.

## Optional inputs

A workflow can also support:

- `sampler_name`,
- `scheduler`,
- checkpoint/model through `checkpointNode`,
- denoise or batch size through defaults baked into the ComfyUI prompt,
- workflow-specific options stored in the preset prompt/defaults,
- other advanced fields preserved in the request payload for future compatibility.

The current portal maps the standard fields above. Workflow-specific UI controls are not generated automatically yet, so required workflow-specific values should have safe defaults inside the preset.

## Required output

A compatible workflow must produce at least one image artifact the backend can find in ComfyUI history. The current provider extracts image references from history outputs containing `images`, then downloads them from ComfyUI `/view` and stores portal artifacts under `IMAGE_ARTIFACT_PATH`.

Use a `SaveImage` output node or an equivalent ComfyUI node whose completed history includes image references. The app records the generated artifact URL, selected source identity, workflow id, resolved seed when available, status, and request payload in gallery/favorite metadata.

## Minimal workflow preset shape

Put JSON presets in `IMAGE_WORKFLOW_PATH`. The built-in preset uses this shape:

```json
{
  "id": "portrait-sdxl",
  "name": "Portrait SDXL workflow",
  "description": "Custom SDXL portrait pipeline for the portal.",
  "engine": "comfyui",
  "defaults": {
    "width": 1024,
    "height": 1024,
    "steps": 28,
    "cfgScale": 7,
    "seed": -1,
    "samplerName": "euler",
    "scheduler": "normal",
    "checkpoint": "sd_xl_base_1.0.safetensors"
  },
  "parameters": [
    "prompt",
    "negative_prompt",
    "model",
    "width",
    "height",
    "steps",
    "cfg_scale",
    "seed",
    "sampler_name",
    "scheduler"
  ],
  "comfyui": {
    "mappings": {
      "checkpointNode": "4",
      "latentImageNode": "5",
      "positivePromptNode": "6",
      "negativePromptNode": "7",
      "samplerNode": "3",
      "saveImageNode": "9"
    },
    "prompt": {
      "3": {
        "class_type": "KSampler",
        "inputs": {
          "seed": 1,
          "steps": 28,
          "cfg": 7,
          "sampler_name": "euler",
          "scheduler": "normal",
          "denoise": 1,
          "model": ["4", 0],
          "positive": ["6", 0],
          "negative": ["7", 0],
          "latent_image": ["5", 0]
        }
      },
      "4": {
        "class_type": "CheckpointLoaderSimple",
        "inputs": {
          "ckpt_name": "sd_xl_base_1.0.safetensors"
        }
      },
      "5": {
        "class_type": "EmptyLatentImage",
        "inputs": {
          "width": 1024,
          "height": 1024,
          "batch_size": 1
        }
      },
      "6": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "text": "",
          "clip": ["4", 1]
        }
      },
      "7": {
        "class_type": "CLIPTextEncode",
        "inputs": {
          "text": "",
          "clip": ["4", 1]
        }
      },
      "8": {
        "class_type": "VAEDecode",
        "inputs": {
          "samples": ["3", 0],
          "vae": ["4", 2]
        }
      },
      "9": {
        "class_type": "SaveImage",
        "inputs": {
          "filename_prefix": "local-ai-images",
          "images": ["8", 0]
        }
      }
    }
  }
}
```

## Compatibility validation

A workflow appears as a generation source only when it satisfies these checks:

1. the preset JSON loads and normalizes successfully,
2. it has a positive prompt text mapping,
3. it has a negative prompt text mapping,
4. it has an `EmptyLatentImage`-compatible width/height mapping,
5. it has a sampler mapping for seed, steps, and CFG,
6. it has a save-image output mapping,
7. any explicit checkpoint node mapping points to an existing node,
8. if it uses a checkpoint, it has a default checkpoint value in `defaults.checkpoint` or in the mapped checkpoint node.

The app validates registry structure before showing the workflow in the selector. ComfyUI can still reject a workflow at generation time if custom nodes are missing, links are invalid, checkpoint names are unavailable, or prompt data is incompatible with the installed ComfyUI version.

## Generation request identity

Generation requests now identify their source explicitly:

```json
{
  "prompt": "a lighthouse at sunset",
  "negative_prompt": "",
  "generation_source_type": "checkpoint",
  "generation_source_id": "checkpoint:abc123",
  "generation_source_label": "demo.safetensors",
  "checkpoint_name": "demo.safetensors",
  "model": "demo.safetensors",
  "workflow_id": "sdxl-text-to-image",
  "width": 1024,
  "height": 1024,
  "steps": 28,
  "cfg_scale": 7,
  "seed": 123
}
```

Workflow-source requests use the same standard controls but switch the discriminator:

```json
{
  "prompt": "a studio portrait",
  "generation_source_type": "workflow",
  "generation_source_id": "workflow:portrait-sdxl",
  "workflow_source_id": "workflow:portrait-sdxl",
  "workflow_id": "portrait-sdxl",
  "width": 1024,
  "height": 1024,
  "steps": 28,
  "cfg_scale": 7,
  "seed": 123
}
```

The backend stores these fields in job summaries, artifact metadata, request payload display, and favorites. Older favorites that only contain `model` or `workflow_id` still load; the portal maps them to a current source when possible and shows a warning if the referenced source no longer exists or is invalid.

## Seed handling

The portal sends a seed to the workflow sampler. A seed of `-1` is normalized by the backend into an operator-local random seed before the request reaches ComfyUI. Generated artifacts and favorites preserve the resolved seed when it is known so saved favorites can regenerate deterministically.

Custom workflows should keep the portal-controlled seed connected to the sampler path that determines image generation. If a workflow internally randomizes seed values after the mapped sampler, the portal may not be able to preserve deterministic regeneration.

## Troubleshooting HTTP 400 prompt validation errors

HTTP 400 from ComfyUI usually means ComfyUI rejected the prompt graph before generation. Check these items first:

- the checkpoint name in the workflow exists in ComfyUI and appears in `CheckpointLoaderSimple`,
- mapped node IDs still exist after editing/exporting the workflow,
- `positivePromptNode` and `negativePromptNode` are text encoder nodes with `text` inputs,
- `latentImageNode` accepts `width` and `height`,
- `samplerNode` accepts `seed`, `steps`, `cfg`, `sampler_name`, and `scheduler`,
- the output node produces image references in history,
- custom ComfyUI nodes used by the workflow are installed on the target machine,
- dimensions are multiples supported by the model/workflow,
- the workflow JSON is API-format ComfyUI prompt data, not only the visual editor format.

A workflow that fails these checks is hidden from the selector when the app can detect the problem. A checkpoint that returns HTTP 400 during the probe is marked invalid/error and hidden from the checkpoint group.

## Testing a workflow through the portal

1. Save the workflow preset JSON under `IMAGE_WORKFLOW_PATH`.
2. Restart the app or use the portal refresh control to rescan sources.
3. Open `/image-generator`.
4. Select the workflow under the **Workflows** group in the Generation source selector.
5. Use a simple prompt and modest dimensions first.
6. Generate once and inspect the gallery job details.
7. Confirm that the job shows `generation_source_type: "workflow"`, the expected `generation_source_id`, the requested standard controls, the artifact URL, and the resolved seed.
8. Save the result as a favorite and reload it to confirm the source and parameters restore.

## Current limitations

- Checkpoint probe results are cached in memory only; they are re-created after app restart.
- When validation-only probing is unavailable, the app runs a tiny real generation. The portal does not persist those probe images in its artifact store, but ComfyUI may still leave temporary/probe output files in its own output folder depending on the workflow's save node behavior.
- Workflow-specific controls are not auto-rendered yet; required custom values should be represented as safe defaults inside the workflow preset.
- The filename filter intentionally excludes common non-checkpoint tokens. A legitimate checkpoint with a misleading name such as one containing `vae` or `lora` may be hidden until renamed or moved into a clearer checkpoint path.
- The registry validates structure and standard mappings. It cannot prove every custom-node workflow will succeed until ComfyUI accepts and runs it.
