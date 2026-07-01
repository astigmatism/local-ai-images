# Ollama / local LLM image-prompt builder

The image generator includes an optional **Large Language Model Image Prompt Guidance** drawer. The drawer sends short user guidance to a configured local LLM endpoint and places the returned text into the positive prompt field. It does not submit an image-generation job by itself.

## Model policy

This feature intentionally does **not** send a model name and does **not** select, load, unload, or swap Ollama models. The active or preloaded language model is expected to be managed outside Local AI Images.

Use an endpoint or gateway that already knows which model should handle the request. If a native Ollama endpoint in your environment requires a `model` field, front it with an active-model router/gateway or compatible wrapper rather than hardcoding a model in this app.

## Runtime configuration

Open the status portal and use **Ollama / local LLM image-prompt builder**. Saving commits settings to the runtime config store immediately; rebuilding or restarting the frontend is not required.

Fields:

- **Enable local LLM prompt builder**: allows image-prompt guidance requests.
- **Endpoint URL**: local LLM or gateway endpoint that accepts the selected request format without this app providing a model name.
- **Health/test URL**: optional URL used by the Test action. A version or health endpoint is preferred.
- **Request format**: one of `openai_chat`, `ollama_chat`, `ollama_generate`, or `simple_json`.
- **Timeout ms**: request timeout for both prompt-building and connection checks.
- **Temperature** and **Max tokens**: optional generation controls. Leave blank to use provider defaults.
- **Prompt-building instruction**: centralized instruction used to tell the LLM to return only positive image prompt text.

Equivalent environment defaults are available for first boot or deployment templates: `LLM_IMAGE_PROMPT_ENABLED`, `LLM_IMAGE_PROMPT_ENDPOINT_URL`, `LLM_IMAGE_PROMPT_HEALTH_URL`, `LLM_IMAGE_PROMPT_REQUEST_TIMEOUT_MS`, `LLM_IMAGE_PROMPT_REQUEST_FORMAT`, `LLM_IMAGE_PROMPT_INSTRUCTION`, `LLM_IMAGE_PROMPT_TEMPERATURE`, and `LLM_IMAGE_PROMPT_MAX_TOKENS`.

## Testing

Click **Test connection** after saving settings. The test uses the optional health URL when present; otherwise it sends an `OPTIONS` request to the configured endpoint. It does not send prompt guidance, does not generate an image, and does not send a model name.

Common failures:

- **Disabled**: enable the integration and save.
- **Needs endpoint / not configured**: provide an endpoint URL and save.
- **Provider error**: the endpoint rejected the selected request format or requires a model field. Use an active-model gateway or choose a compatible format.
- **Timeout/unavailable**: the local LLM service is unreachable from the Local AI Images process, or the timeout is too short.
- **Empty response**: the endpoint responded successfully but did not return recognizable prompt text.

## In-flight edits

When the image-generator guidance drawer is waiting for an LLM response, the user can still edit the positive prompt. If the positive prompt changed after the request was sent, the returned LLM prompt is not silently applied. The drawer shows an **Apply returned prompt** action so the user can explicitly replace the current positive prompt.
