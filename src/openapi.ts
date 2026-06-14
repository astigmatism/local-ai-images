import { APPLICATION_VERSION, OPENAPI_VERSION, RUNTIME_NAME, SERVICE_NAME } from './version.ts';

const errorSchema = {
  type: 'object',
  required: ['ok', 'error'],
  properties: {
    ok: { const: false },
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: {}
      }
    }
  }
} as const;

const validationErrorSchema = {
  type: 'object',
  required: ['detail'],
  properties: {
    detail: {
      type: 'array',
      items: {
        type: 'object',
        required: ['loc', 'msg', 'type', 'ctx'],
        properties: {
          loc: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
          msg: { type: 'string' },
          type: { type: 'string' },
          input: {},
          ctx: { type: 'object', additionalProperties: true }
        }
      }
    }
  }
} as const;

const modelDetailsSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    parent_model: { type: 'string' },
    format: { type: 'string' },
    family: { type: 'string' },
    families: { type: 'array', items: { type: 'string' } },
    parameter_size: { type: 'string' },
    quantization_level: { type: 'string' }
  }
} as const;

const runningModelSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    name: { type: 'string' },
    model: { type: 'string' },
    size: { type: 'number' },
    digest: { type: 'string' },
    details: modelDetailsSchema,
    expires_at: { type: 'string' },
    size_vram: { type: 'number' },
    context_length: { type: 'number' }
  }
} as const;

const installedModelSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    name: { type: 'string' },
    model: { type: 'string' },
    modified_at: { type: 'string' },
    size: { type: 'number' },
    digest: { type: 'string' },
    details: modelDetailsSchema,
    capabilities: { type: 'array', items: { type: 'string' } }
  }
} as const;

const nullableNumber = { oneOf: [{ type: 'number' }, { type: 'null' }] } as const;
const nullableString = { oneOf: [{ type: 'string' }, { type: 'null' }] } as const;
const nullableBoolean = { oneOf: [{ type: 'boolean' }, { type: 'null' }] } as const;

const gpuSchema = {
  type: 'object',
  required: [
    'index',
    'uuid',
    'name',
    'driver_version',
    'memory_total_mib',
    'memory_used_mib',
    'memory_free_mib',
    'utilization_gpu_percent',
    'temperature_c',
    'power_draw_w',
    'power_limit_w'
  ],
  properties: {
    index: { type: 'number' },
    uuid: nullableString,
    name: { type: 'string' },
    driver_version: nullableString,
    memory_total_mib: nullableNumber,
    memory_used_mib: nullableNumber,
    memory_free_mib: nullableNumber,
    utilization_gpu_percent: nullableNumber,
    temperature_c: nullableNumber,
    power_draw_w: nullableNumber,
    power_limit_w: nullableNumber,
    warnings: { type: 'array', items: { type: 'string' } }
  }
} as const;

const generatedImageSchema = {
  type: 'object',
  required: ['mimeType', 'base64'],
  properties: {
    mimeType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'] },
    base64: { type: 'string' },
    width: { type: 'number' },
    height: { type: 'number' }
  }
} as const;

const imageGenerationCapabilitySchema = {
  type: 'object',
  required: [
    'enabled',
    'provider',
    'currentModel',
    'installed',
    'loaded',
    'available',
    'endpoint',
    'ollamaEndpoint',
    'requiredCapability',
    'modelCapabilities',
    'supportsImageGeneration',
    'supportsImageInput',
    'maxPromptChars'
  ],
  properties: {
    enabled: { type: 'boolean' },
    provider: { const: 'ollama' },
    currentModel: { ...nullableString, description: 'Model currently selected by local-ai-llm for generation.' },
    installed: { ...nullableBoolean, description: 'Whether the current model is installed, or null when disabled/unverified.' },
    loaded: { ...nullableBoolean, description: 'Whether the current model appears in Ollama running-model state, or null when disabled/unverified.' },
    available: { type: 'boolean', description: 'True only when image generation is enabled, the model is installed, and Ollama reports the image-generation capability.' },
    endpoint: { const: '/api/images/generate' },
    ollamaEndpoint: { const: '/api/generate' },
    requiredCapability: { const: 'image' },
    modelCapabilities: { type: 'array', items: { type: 'string' }, description: 'Raw capability names reported by Ollama POST /api/show.' },
    supportsImageGeneration: { ...nullableBoolean, description: 'True when Ollama reports capability "image" for the selected model.' },
    supportsImageInput: { ...nullableBoolean, description: 'True when Ollama reports capability "vision". This is input understanding, not image output.' },
    maxPromptChars: { type: 'number' },
    reason: { type: 'string' }
  }
} as const;

const capabilityAvailabilitySchema = {
  type: 'object',
  required: ['available', 'exposedByService'],
  additionalProperties: true,
  properties: {
    available: { type: 'boolean' },
    exposedByService: { type: 'boolean' },
    providerEndpoint: { type: 'string' },
    serviceEndpoint: { type: 'string' },
    requiredCapability: { type: 'string' },
    reason: { type: 'string' },
    note: { type: 'string' }
  }
} as const;

const modelCapabilityReportSchema = {
  type: 'object',
  required: [
    'provider',
    'currentModel',
    'installed',
    'loaded',
    'ollamaCapabilities',
    'textGeneration',
    'chatCompletion',
    'textStreaming',
    'imageInput',
    'imageGeneration'
  ],
  properties: {
    provider: { const: 'ollama' },
    currentModel: nullableString,
    installed: nullableBoolean,
    loaded: nullableBoolean,
    ollamaCapabilities: { type: 'array', items: { type: 'string' } },
    textGeneration: capabilityAvailabilitySchema,
    chatCompletion: capabilityAvailabilitySchema,
    textStreaming: capabilityAvailabilitySchema,
    imageInput: capabilityAvailabilitySchema,
    imageGeneration: capabilityAvailabilitySchema
  }
} as const;


const legacyGpuSchema = {
  type: 'object',
  required: [
    'name',
    'driver_version',
    'memory_total_mib',
    'memory_used_mib',
    'memory_free_mib',
    'utilization_gpu_percent',
    'temperature_c',
    'power_draw_w',
    'power_limit_w'
  ],
  properties: {
    name: { type: 'string' },
    driver_version: nullableString,
    memory_total_mib: nullableNumber,
    memory_used_mib: nullableNumber,
    memory_free_mib: nullableNumber,
    utilization_gpu_percent: nullableNumber,
    temperature_c: nullableNumber,
    power_draw_w: nullableNumber,
    power_limit_w: nullableNumber
  }
} as const;

export function buildOpenApiDocument() {
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: SERVICE_NAME,
      version: APPLICATION_VERSION,
      description: `Node-based ${SERVICE_NAME} compatibility API and portal runtime (${RUNTIME_NAME}).`
    },
    servers: [
      { url: 'http://127.0.0.1:8000', description: 'Local monitor URL' }
    ],
    paths: {
      '/health': {
        get: {
          summary: 'Monitor and Ollama health',
          responses: {
            '200': {
              description: 'Monitor can contact Ollama and report running/default model state',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['ok', 'default_model', 'default_model_loaded', 'running_models'],
                    properties: {
                      ok: { const: true },
                      service: { type: 'string' },
                      version: { type: 'string' },
                      runtime: { type: 'string' },
                      default_model: { type: 'string' },
                      default_model_loaded: { type: 'boolean' },
                      running_models: { type: 'array', items: runningModelSchema },
                      ollama: { type: 'object', additionalProperties: true }
                    }
                  }
                }
              }
            },
            '503': { description: 'Ollama unavailable', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/capabilities': {
        get: {
          summary: 'Service capability report',
          description: 'Reports provider/model capabilities separately from service-exposed endpoints. Vision/image input and image-generation output are separate capabilities.',
          responses: {
            '200': {
              description: 'Capability report',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['ok', 'textGeneration', 'textStreaming', 'imageInput', 'imageGeneration', 'modelCapabilities'],
                    properties: {
                      ok: { const: true },
                      textGeneration: { type: 'boolean', description: 'Compatibility field for this service API. Detailed provider capability is in modelCapabilities.textGeneration.' },
                      textStreaming: { type: 'boolean', description: 'Compatibility field for this service API. Detailed provider capability is in modelCapabilities.textStreaming.' },
                      imageInput: { type: 'boolean', description: 'Whether the selected Ollama model reports vision/image-input support.' },
                      imageGeneration: imageGenerationCapabilitySchema,
                      modelCapabilities: modelCapabilityReportSchema
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/api/images/generate': {
        post: {
          summary: 'Generate an image with the current Ollama model',
          description: 'Private orchestrator-facing endpoint. It calls Ollama POST /api/generate with stream=false only when the current model reports Ollama image-generation capability "image".',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['prompt'],
                  properties: {
                    prompt: { type: 'string', minLength: 1 },
                    model: { type: 'string', description: 'Optional compatibility field. When supplied, it must match the current model.' },
                    options: {
                      type: 'object',
                      properties: {
                        width: { type: 'number' },
                        height: { type: 'number' },
                        steps: { type: 'number' }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Generated image data',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['ok', 'model', 'images', 'metadata'],
                    properties: {
                      ok: { const: true },
                      model: { type: 'string' },
                      images: { type: 'array', items: generatedImageSchema },
                      metadata: { type: 'object', additionalProperties: true }
                    }
                  }
                }
              }
            },
            '400': { description: 'Unsupported model override', content: { 'application/json': { schema: errorSchema } } },
            '404': { description: 'Current/default model is not installed', content: { 'application/json': { schema: errorSchema } } },
            '422': { description: 'Validation error or unsupported image-generation capability', content: { 'application/json': { schema: { oneOf: [validationErrorSchema, errorSchema] } } } },
            '502': { description: 'Ollama returned no valid image data after capability gating', content: { 'application/json': { schema: errorSchema } } },
            '503': { description: 'Image generation disabled, no current model, or Ollama unavailable', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/v1/health': {
        get: {
          summary: 'Image-generation service health',
          description: 'Reports app, ComfyUI/mock engine, GPU, queue, model, workflow, and auth state for machine-to-machine orchestrators.',
          responses: {
            '200': { description: 'Image service health and capacity snapshot' },
            '401': { description: 'API key required when image API auth is enabled', content: { 'application/json': { schema: errorSchema } } },
            '403': { description: 'Invalid API key', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/v1/capabilities': {
        get: {
          summary: 'Stable image API capabilities',
          responses: {
            '200': { description: 'Supported providers, outputs, parameters, and workflow presets' },
            '401': { description: 'API key required', content: { 'application/json': { schema: errorSchema } } },
            '403': { description: 'Invalid API key', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/v1/stats': {
        get: {
          summary: 'Image service engine, GPU, queue, and recent-job stats',
          responses: {
            '200': { description: 'Capacity and runtime stats' },
            '401': { description: 'API key required', content: { 'application/json': { schema: errorSchema } } },
            '403': { description: 'Invalid API key', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/v1/models': {
        get: {
          summary: 'List locally scanned image model files',
          responses: {
            '200': { description: 'Model inventory from IMAGE_MODEL_PATHS' },
            '401': { description: 'API key required', content: { 'application/json': { schema: errorSchema } } },
            '403': { description: 'Invalid API key', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/v1/models/refresh': {
        post: {
          summary: 'Refresh local image model inventory',
          responses: {
            '200': { description: 'Refreshed model inventory' },
            '401': { description: 'API key required', content: { 'application/json': { schema: errorSchema } } },
            '403': { description: 'Invalid API key', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/v1/workflows': {
        get: {
          summary: 'List application-level workflow presets',
          description: 'Returns stable workflow metadata and defaults without requiring callers to send raw ComfyUI workflow JSON.',
          responses: {
            '200': { description: 'Workflow preset summaries' },
            '401': { description: 'API key required', content: { 'application/json': { schema: errorSchema } } },
            '403': { description: 'Invalid API key', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/v1/workflows/{workflowId}': {
        get: {
          summary: 'Read one application-level workflow preset',
          parameters: [{ name: 'workflowId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Workflow preset detail' },
            '404': { description: 'Workflow not found', content: { 'application/json': { schema: errorSchema } } },
            '401': { description: 'API key required', content: { 'application/json': { schema: errorSchema } } },
            '403': { description: 'Invalid API key', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/v1/generate': {
        post: {
          summary: 'Submit an image-generation job',
          description: 'Stable app-level API that maps prompt/model/options onto a configured ComfyUI workflow preset. Supports async jobs and optional sync_timeout_ms.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['prompt'],
                  properties: {
                    prompt: { type: 'string', minLength: 1 },
                    negative_prompt: { type: 'string' },
                    model: { type: 'string', description: 'ComfyUI checkpoint name/path relative to the configured model directory.' },
                    workflow_id: { type: 'string', default: 'sdxl-text-to-image' },
                    width: { type: 'integer', minimum: 64, maximum: 4096 },
                    height: { type: 'integer', minimum: 64, maximum: 4096 },
                    steps: { type: 'integer', minimum: 1, maximum: 150 },
                    cfg_scale: { type: 'number', minimum: 0, maximum: 30 },
                    seed: { type: 'integer', description: 'Use -1 or omit for local random seed.' },
                    output: { enum: ['metadata', 'url', 'base64', 'binary'], default: 'url' },
                    sync_timeout_ms: { type: 'integer', minimum: 0 },
                    metadata: { type: 'object', additionalProperties: true }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Completed sync result, JSON or binary depending on output' },
            '202': { description: 'Accepted async job with status and result URLs' },
            '422': { description: 'Validation error', content: { 'application/json': { schema: validationErrorSchema } } },
            '429': { description: 'Queue full', content: { 'application/json': { schema: errorSchema } } },
            '503': { description: 'Image generation disabled or backend unavailable', content: { 'application/json': { schema: errorSchema } } },
            '401': { description: 'API key required', content: { 'application/json': { schema: errorSchema } } },
            '403': { description: 'Invalid API key', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/v1/jobs': {
        get: {
          summary: 'List image-generation jobs',
          parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 250 } }],
          responses: { '200': { description: 'Recent jobs and queue stats' } }
        }
      },
      '/api/v1/jobs/{jobId}': {
        get: {
          summary: 'Read one image-generation job',
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Job status, request, artifacts, and metadata' },
            '404': { description: 'Job not found', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/v1/jobs/{jobId}/result': {
        get: {
          summary: 'Retrieve a completed job result',
          parameters: [
            { name: 'jobId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'format', in: 'query', required: false, schema: { enum: ['metadata', 'url', 'base64', 'binary'] } }
          ],
          responses: {
            '200': { description: 'Completed JSON or binary result' },
            '202': { description: 'Job still queued or running' },
            '404': { description: 'Job not found', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/v1/jobs/{jobId}/cancel': {
        post: {
          summary: 'Cancel a queued or running image job',
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Job canceled or already terminal' },
            '404': { description: 'Job not found', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/v1/artifacts/{artifactId}': {
        get: {
          summary: 'Retrieve image artifact bytes or sidecar metadata',
          parameters: [
            { name: 'artifactId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'metadata', in: 'query', required: false, schema: { enum: ['1'] } },
            { name: 'format', in: 'query', required: false, schema: { enum: ['metadata'] } }
          ],
          responses: {
            '200': { description: 'Image bytes by default, or artifact metadata when requested' },
            '404': { description: 'Artifact not found', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/gpu': {
        get: {
          summary: 'Legacy primary GPU telemetry',
          description: 'Compatibility endpoint that returns only one deterministic primary GPU. New consumers should use /gpus.',
          responses: {
            '200': {
              description: 'Primary GPU telemetry',
              content: { 'application/json': { schema: { type: 'object', required: ['ok', 'gpu'], properties: { ok: { const: true }, gpu: legacyGpuSchema } } } }
            },
            '503': { description: 'GPU telemetry unavailable', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/gpus': {
        get: {
          summary: 'All detected NVIDIA GPUs',
          responses: {
            '200': {
              description: 'All GPU telemetry rows',
              content: { 'application/json': { schema: { type: 'object', required: ['ok', 'gpus'], properties: { ok: { const: true }, gpus: { type: 'array', items: gpuSchema } } } } }
            },
            '503': { description: 'GPU telemetry unavailable', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/models/running': {
        get: {
          summary: 'Running Ollama models',
          responses: {
            '200': { description: 'Models currently loaded into memory', content: { 'application/json': { schema: { type: 'object', required: ['ok', 'models'], properties: { ok: { const: true }, models: { type: 'array', items: runningModelSchema } } } } } },
            '503': { description: 'Ollama unavailable', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/models/installed': {
        get: {
          summary: 'Installed/pulled Ollama models',
          responses: {
            '200': { description: 'Models available locally to Ollama', content: { 'application/json': { schema: { type: 'object', required: ['ok', 'models'], properties: { ok: { const: true }, models: { type: 'array', items: installedModelSchema } } } } } },
            '503': { description: 'Ollama unavailable', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/config': {
        get: {
          summary: 'Read local monitor configuration',
          responses: {
            '200': { description: 'Configuration', content: { 'application/json': { schema: { type: 'object', required: ['ok', 'config'], properties: { ok: { const: true }, config: { type: 'object', required: ['default_model'], properties: { default_model: { type: 'string' } } } } } } } },
            '500': { description: 'Config read failed', content: { 'application/json': { schema: errorSchema } } }
          }
        },
        post: {
          summary: 'Update default model configuration',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { type: 'object', required: ['default_model'], properties: { default_model: { type: 'string', minLength: 1, maxLength: 128 } } } } }
          },
          responses: {
            '200': { description: 'Updated configuration', content: { 'application/json': { schema: { type: 'object', required: ['ok', 'config'], properties: { ok: { const: true }, config: { type: 'object', required: ['default_model'], properties: { default_model: { type: 'string' } } } } } } } },
            '422': { description: 'Validation error', content: { 'application/json': { schema: validationErrorSchema } } },
            '500': { description: 'Config write failed', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/model/load': {
        post: {
          summary: 'Load/pre-warm an Ollama model',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['model'],
                  properties: {
                    model: { type: 'string', minLength: 1, maxLength: 128 },
                    make_default: { type: 'boolean', default: false }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Model pre-warmed',
              content: { 'application/json': { schema: { type: 'object', required: ['ok', 'model', 'made_default', 'loaded', 'default_model'], properties: { ok: { const: true }, model: { type: 'string' }, made_default: { type: 'boolean' }, loaded: { type: 'boolean' }, default_model: { type: 'string' }, prewarm: { type: 'object', additionalProperties: true } } } } }
            },
            '404': { description: 'Model not found by Ollama', content: { 'application/json': { schema: errorSchema } } },
            '422': { description: 'Validation error', content: { 'application/json': { schema: validationErrorSchema } } },
            '503': { description: 'Ollama unavailable', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/model/prewarm': {
        post: {
          summary: 'Pre-warm a model or the configured default model',
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    model: { type: 'string', minLength: 1, maxLength: 128 }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Model pre-warmed',
              content: { 'application/json': { schema: { type: 'object', required: ['ok', 'model', 'loaded', 'default_model'], properties: { ok: { const: true }, model: { type: 'string' }, loaded: { type: 'boolean' }, default_model: { type: 'string' }, prewarm: { type: 'object', additionalProperties: true } } } } }
            },
            '404': { description: 'Model not found by Ollama', content: { 'application/json': { schema: errorSchema } } },
            '422': { description: 'Validation error', content: { 'application/json': { schema: validationErrorSchema } } },
            '503': { description: 'Ollama unavailable', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/openapi.json': {
        get: {
          summary: 'OpenAPI document',
          responses: {
            '200': { description: 'OpenAPI 3.1 document' }
          }
        }
      }
    },
    components: {
      schemas: {
        ErrorResponse: errorSchema,
        ValidationError: validationErrorSchema,
        RunningModel: runningModelSchema,
        InstalledModel: installedModelSchema,
        GpuTelemetry: gpuSchema,
        LegacyGpuTelemetry: legacyGpuSchema,
        GeneratedImage: generatedImageSchema,
        ImageGenerationCapability: imageGenerationCapabilitySchema,
        ModelCapabilityReport: modelCapabilityReportSchema
      }
    }
  };
}
