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

const gpuSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    index: { type: 'number' },
    uuid: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    name: { type: 'string' },
    driver_version: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    memory_total_mib: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    memory_used_mib: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    memory_free_mib: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    utilization_gpu_percent: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    temperature_c: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    power_draw_w: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    power_limit_w: { oneOf: [{ type: 'number' }, { type: 'null' }] }
  }
} as const;

const generationRequestSchema = {
  type: 'object',
  required: ['prompt'],
  additionalProperties: true,
  properties: {
    prompt: { type: 'string' },
    negative_prompt: { type: 'string' },
    model: { type: 'string', description: 'Optional checkpoint filename/name. If omitted, the persisted image_default_model is used when compatible with the workflow; otherwise the workflow default is used.' },
    workflow_id: { type: 'string' },
    width: { type: 'number' },
    height: { type: 'number' },
    steps: { type: 'number' },
    cfg_scale: { type: 'number' },
    seed: { type: 'number' },
    sampler_name: { type: 'string' },
    scheduler: { type: 'string' },
    output: { enum: ['metadata', 'url', 'base64', 'binary'] },
    sync_timeout_ms: { type: 'number' },
    metadata: { type: 'object', additionalProperties: true }
  }
} as const;


const favoriteImagePromptSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    description: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    requestPayload: generationRequestSchema,
    prompt: { type: 'string' },
    negativePrompt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    promptPreview: { type: 'string' },
    negativePromptPreview: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    model: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    workflow: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    workflowId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    sampler: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    scheduler: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    width: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    height: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    steps: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    cfgScale: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    seed: { oneOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' }
  }
} as const;

const favoriteImagePromptCreateSchema = {
  type: 'object',
  required: ['request_payload'],
  additionalProperties: true,
  properties: {
    title: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    notes: { type: 'string' },
    request_payload: generationRequestSchema,
    requestPayload: generationRequestSchema
  }
} as const;

const favoriteImagePromptPatchSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    title: { type: 'string' },
    name: { type: 'string' },
    description: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    notes: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    request_payload: generationRequestSchema,
    requestPayload: generationRequestSchema
  }
} as const;

const imageFavoriteSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    description: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    requestPayload: generationRequestSchema,
    prompt: { type: 'string' },
    negativePrompt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    promptPreview: { type: 'string' },
    negativePromptPreview: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    model: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    workflow: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    workflowId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    sampler: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    scheduler: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    width: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    height: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    steps: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    cfgScale: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    seed: { oneOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }] },
    artifactId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    artifactUrl: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    imageUrl: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    jobId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    artifact: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
    artifacts: { type: 'array', items: { type: 'object', additionalProperties: true } },
    job: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
    metadata: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' }
  }
} as const;

const imageFavoriteCreateSchema = {
  type: 'object',
  required: ['request_payload'],
  additionalProperties: true,
  properties: {
    title: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    notes: { type: 'string' },
    request_payload: generationRequestSchema,
    requestPayload: generationRequestSchema,
    artifact_id: { type: 'string' },
    artifactId: { type: 'string' },
    artifact_url: { type: 'string' },
    artifactUrl: { type: 'string' },
    image_url: { type: 'string' },
    imageUrl: { type: 'string' },
    artifact: { type: 'object', additionalProperties: true },
    artifacts: { type: 'array', items: { type: 'object', additionalProperties: true } },
    job_id: { type: 'string' },
    jobId: { type: 'string' },
    job: { type: 'object', additionalProperties: true },
    metadata: { type: 'object', additionalProperties: true }
  }
} as const;

const imageFavoritePatchSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    title: { type: 'string' },
    name: { type: 'string' },
    description: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    notes: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    request_payload: generationRequestSchema,
    requestPayload: generationRequestSchema,
    artifact_id: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    artifactId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    artifact_url: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    artifactUrl: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    image_url: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    imageUrl: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    artifact: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
    artifacts: { type: 'array', items: { type: 'object', additionalProperties: true } },
    job_id: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    jobId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    job: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
    metadata: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] }
  }
} as const;

const deletePreviewSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    fileName: { type: 'string' },
    type: { type: 'string' },
    sizeBytes: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    path: { type: 'string' },
    requiresConfirmation: { type: 'boolean' },
    confirmationField: { type: 'string' },
    confirmationValue: { type: 'string' },
    isDefault: { type: 'boolean' },
    deleteRequiresDefaultClear: { type: 'boolean' }
  }
} as const;

const modelSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    displayName: { type: 'string' },
    fileName: { type: 'string' },
    type: { type: 'string' },
    category: { type: 'string' },
    path: { type: 'string' },
    rootPath: { type: 'string' },
    relativePath: { type: 'string' },
    comfyName: { type: 'string' },
    sizeBytes: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    modifiedAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    extension: { type: 'string' },
    isDefault: { type: 'boolean' },
    isLastConfirmedLoaded: { type: 'boolean' },
    canSetDefault: { type: 'boolean' },
    canPreload: { type: 'boolean' },
    canDelete: { type: 'boolean' },
    deleteRequiresDefaultClear: { type: 'boolean' },
    defaultWarning: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    loadedStatus: { enum: ['last_confirmed_loaded', 'default_not_confirmed_loaded', 'not_confirmed_loaded', 'not_applicable'] },
    usableByDefaultWorkflow: { type: 'boolean' },
    deletePreview: deletePreviewSchema
  }
} as const;

const modelPreloadStatusSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { const: true },
    currentDefaultCheckpoint: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    defaultModel: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    defaultFileExists: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
    preloadOnStartup: { type: 'boolean' },
    lastPreloadAttemptTime: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    lastPreloadCompletedTime: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    lastPreloadResult: { enum: ['not_attempted', 'running', 'succeeded', 'failed', 'skipped'] },
    lastPreloadError: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
    lastPreloadModel: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    lastConfirmedLoadedModel: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    lastConfirmedLoadedAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    lastConfirmedLoadedSource: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    active: { type: 'boolean' },
    defaultWarning: { oneOf: [{ type: 'string' }, { type: 'null' }] }
  }
} as const;

const modelInventoryResponseSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { const: true },
    defaultModel: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    default_model: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    defaultWorkflowId: { type: 'string' },
    defaultStatus: modelPreloadStatusSchema,
    preload: modelPreloadStatusSchema,
    models: { type: 'array', items: modelSchema }
  }
} as const;

const artifactSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    jobId: { type: 'string' },
    fileName: { type: 'string' },
    mimeType: { type: 'string' },
    sizeBytes: { type: 'number' },
    url: { type: 'string' }
  }
} as const;

const timingSchema = {
  type: 'object',
  properties: {
    queueWaitMs: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    executionMs: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    totalMs: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    secondsPerStep: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    stepsPerSecond: { oneOf: [{ type: 'number' }, { type: 'null' }] }
  }
} as const;

const jobSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    status: { enum: ['queued', 'running', 'succeeded', 'failed', 'canceled'] },
    provider: { type: 'string' },
    providerJobId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    workflowId: { type: 'string' },
    model: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    prompt: { type: 'string' },
    negativePrompt: { type: 'string' },
    seed: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
    steps: { type: 'number' },
    cfgScale: { type: 'number' },
    samplerName: { type: 'string' },
    scheduler: { type: 'string' },
    output: { enum: ['metadata', 'url', 'base64', 'binary'] },
    createdAt: { type: 'string' },
    queuedAt: { type: 'string' },
    startedAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    completedAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    artifactCount: { type: 'number' },
    artifactSizes: { type: 'array', items: { type: 'number' } },
    timings: timingSchema,
    request: generationRequestSchema,
    metadata: { type: 'object', additionalProperties: true },
    artifacts: { type: 'array', items: artifactSchema }
  }
} as const;

const modelCatalogEntrySchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    type: { enum: ['checkpoint', 'lora', 'vae', 'controlnet', 'upscaler', 'other'] },
    base: { type: 'string' },
    recommendedFor: { type: 'array', items: { type: 'string' } },
    minimumVramGb: { type: 'number' },
    license: { type: 'string' },
    sourceName: { type: 'string' },
    sourceUrl: { type: 'string' },
    downloadUrl: { type: 'string' },
    fileName: { type: 'string' },
    notes: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } }
  }
} as const;

const modelDownloadRequestSchema = {
  type: 'object',
  required: ['url', 'type'],
  additionalProperties: false,
  properties: {
    url: { type: 'string' },
    type: { enum: ['checkpoint', 'lora', 'vae', 'controlnet', 'upscaler', 'other'] },
    destination: { type: 'string', description: 'Optional explicit approved destination directory for the selected type.' },
    file_name: { type: 'string' },
    overwrite: { type: 'boolean' },
    set_default: { type: 'boolean', description: 'Only applies to checkpoint downloads.' }
  }
} as const;

const modelDownloadJobSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    status: { enum: ['queued', 'downloading', 'succeeded', 'failed', 'canceled'] },
    type: { enum: ['checkpoint', 'lora', 'vae', 'controlnet', 'upscaler', 'other'] },
    sourceUrl: { type: 'string' },
    finalUrl: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    fileName: { type: 'string' },
    destinationDirectory: { type: 'string' },
    destinationPath: { type: 'string' },
    createdAt: { type: 'string' },
    startedAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    completedAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    totalBytes: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    downloadedBytes: { type: 'number' },
    progress: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    warnings: { type: 'array', items: { type: 'string' } }
  }
} as const;

const modelDefaultRequestSchema = {
  type: 'object',
  required: ['model'],
  additionalProperties: false,
  properties: {
    model: { type: 'string' },
    preload_on_startup: { type: 'boolean', description: 'When true, also enables default checkpoint preload during future app startup.' }
  }
} as const;

const modelPreloadRequestSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    model: { type: 'string', description: 'Checkpoint identifier or filename. If omitted, the current default checkpoint is preloaded.' },
    set_default: { type: 'boolean', description: 'When true, persist the checkpoint as image_default_model before preloading.' }
  }
} as const;

const modelPreloadStartupRequestSchema = {
  type: 'object',
  required: ['enabled'],
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' }
  }
} as const;

const deleteModelRequestSchema = {
  type: 'object',
  required: ['confirm_file_name'],
  additionalProperties: false,
  properties: {
    confirm_file_name: { type: 'string', description: 'Exact file name from the model row/card delete preview.' },
    delete_and_clear_default: { type: 'boolean', description: 'Required when deleting the current default checkpoint without clearing it first.' }
  }
} as const;

const bearerSecurity = [{ bearerAuth: [] }, { apiKeyAuth: [] }];
const authErrorResponses = {
  '401': { description: 'Image API authentication failed', content: { 'application/json': { schema: errorSchema } } },
  '403': { description: 'Image API authentication forbidden or feature disabled', content: { 'application/json': { schema: errorSchema } } }
} as const;

export function buildOpenApiDocument() {
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: SERVICE_NAME,
      version: APPLICATION_VERSION,
      description: `Node-based ${SERVICE_NAME} ComfyUI image-generation API and control-panel runtime (${RUNTIME_NAME}). Legacy Ollama endpoints are optional and disabled unless LEGACY_OLLAMA_ENABLED=true.`
    },
    servers: [
      { url: 'http://127.0.0.1:3000', description: 'Local AI Images URL' }
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' }
      },
      schemas: {
        Error: errorSchema,
        Gpu: gpuSchema,
        GenerationRequest: generationRequestSchema,
        FavoriteImagePrompt: favoriteImagePromptSchema,
        FavoriteImagePromptCreateRequest: favoriteImagePromptCreateSchema,
        FavoriteImagePromptPatchRequest: favoriteImagePromptPatchSchema,
        ImageFavorite: imageFavoriteSchema,
        ImageFavoriteCreateRequest: imageFavoriteCreateSchema,
        ImageFavoritePatchRequest: imageFavoritePatchSchema,
        Model: modelSchema,
        ModelInventoryResponse: modelInventoryResponseSchema,
        ModelPreloadStatus: modelPreloadStatusSchema,
        DeleteModelRequest: deleteModelRequestSchema,
        Job: jobSchema,
        JobTimings: timingSchema,
        Artifact: artifactSchema,
        ModelCatalogEntry: modelCatalogEntrySchema,
        ModelDownloadRequest: modelDownloadRequestSchema,
        ModelDownloadJob: modelDownloadJobSchema
      }
    },
    paths: {
      '/health': {
        get: {
          summary: 'Image service health',
          description: 'Unauthenticated compatibility health endpoint. In the default image-only mode this reports the same image-service state as /api/v1/health and does not contact Ollama.',
          responses: { '200': { description: 'Image service health state' } }
        }
      },
      '/api/v1/health': {
        get: {
          summary: 'Image API health',
          security: bearerSecurity,
          responses: { '200': { description: 'Image service, ComfyUI/mock provider, queue, workflow, model-path, default-model, install, preload, auth, and GPU state' }, ...authErrorResponses }
        }
      },
      '/api/v1/capabilities': {
        get: {
          summary: 'Image API capabilities',
          security: bearerSecurity,
          responses: { '200': { description: 'Supported image-generation, default-model, model-lifecycle, model-install, and workflow features' }, ...authErrorResponses }
        }
      },
      '/api/v1/stats': {
        get: {
          summary: 'Runtime stats',
          security: bearerSecurity,
          responses: { '200': { description: 'ComfyUI/mock provider state, GPU telemetry, queue stats, and recent jobs' }, ...authErrorResponses }
        }
      },
      '/api/v1/models': {
        get: {
          summary: 'Scanned local image model inventory',
          description: 'Returns disk inventory plus UI-ready lifecycle state such as default, canPreload, canDelete, and last confirmed loaded/prewarmed flags. Scanning does not load a model into VRAM.',
          security: bearerSecurity,
          responses: {
            '200': { description: 'Model files discovered under IMAGE_MODEL_PATHS with default/preload/delete state', content: { 'application/json': { schema: modelInventoryResponseSchema } } },
            ...authErrorResponses
          }
        }
      },
      '/api/v1/models/refresh': {
        post: {
          summary: 'Refresh local image model inventory',
          security: bearerSecurity,
          responses: { '200': { description: 'Refreshed model inventory', content: { 'application/json': { schema: modelInventoryResponseSchema } } }, ...authErrorResponses }
        }
      },
      '/api/v1/models/default': {
        post: {
          summary: 'Set the default image checkpoint model',
          description: 'Persists image_default_model. This does not mark the model loaded; use /api/v1/models/preload or generate an image to confirm load/prewarm.',
          security: bearerSecurity,
          requestBody: { required: true, content: { 'application/json': { schema: modelDefaultRequestSchema } } },
          responses: { '200': { description: 'Persisted image_default_model and refreshed inventory' }, '404': { description: 'Model not found', content: { 'application/json': { schema: errorSchema } } }, '422': { description: 'Model is not an installed checkpoint' }, ...authErrorResponses }
        },
        delete: {
          summary: 'Clear the default image checkpoint model',
          security: bearerSecurity,
          responses: { '200': { description: 'Cleared persisted image_default_model and returned refreshed inventory' }, ...authErrorResponses }
        }
      },
      '/api/v1/models/preload': {
        get: {
          summary: 'Read default checkpoint preload status',
          security: bearerSecurity,
          responses: { '200': { description: 'Default, startup preload, and last confirmed loaded/prewarmed state', content: { 'application/json': { schema: modelPreloadStatusSchema } } }, ...authErrorResponses }
        },
        post: {
          summary: 'Load/prewarm a checkpoint in ComfyUI now',
          description: 'Submits a bounded tiny generation request using the preload workflow. On success the checkpoint is recorded as the last confirmed loaded/prewarmed model.',
          security: bearerSecurity,
          requestBody: { required: false, content: { 'application/json': { schema: modelPreloadRequestSchema } } },
          responses: { '200': { description: 'Preload succeeded and inventory was refreshed' }, '404': { description: 'Model not found', content: { 'application/json': { schema: errorSchema } } }, '422': { description: 'Missing model/default, non-checkpoint model, or invalid workflow mapping' }, '503': { description: 'ComfyUI unavailable' }, '504': { description: 'Preload timed out' }, ...authErrorResponses }
        }
      },
      '/api/v1/models/preload/startup': {
        post: {
          summary: 'Enable or disable default checkpoint preload on app startup',
          security: bearerSecurity,
          requestBody: { required: true, content: { 'application/json': { schema: modelPreloadStartupRequestSchema } } },
          responses: { '200': { description: 'Persisted startup preload setting and returned refreshed status/inventory' }, '422': { description: 'enabled must be true or false' }, ...authErrorResponses }
        }
      },
      '/api/v1/models/{modelId}': {
        delete: {
          summary: 'Safely delete one installed model file',
          description: 'Deletes only files inside approved ComfyUI model directories. Requires exact file-name confirmation and blocks deleting the current default unless delete_and_clear_default=true is sent.',
          security: bearerSecurity,
          parameters: [{ name: 'modelId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: deleteModelRequestSchema } } },
          responses: { '200': { description: 'Deleted model file and refreshed inventory' }, '403': { description: 'Path is outside approved model install directories', content: { 'application/json': { schema: errorSchema } } }, '404': { description: 'Model not found', content: { 'application/json': { schema: errorSchema } } }, '409': { description: 'Model is the current default and was not explicitly cleared' }, '422': { description: 'Missing or mismatched delete confirmation' }, ...authErrorResponses }
        }
      },
      '/api/v1/model-catalog': {
        get: {
          summary: 'Load local model catalog entries',
          security: bearerSecurity,
          responses: { '200': { description: 'Runtime, example, or empty operator-editable catalog', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, source: { enum: ['runtime', 'example', 'empty'] }, path: { type: 'string' }, entries: { type: 'array', items: modelCatalogEntrySchema } } } } } }, ...authErrorResponses }
        }
      },
      '/api/v1/model-downloads': {
        get: {
          summary: 'List model download jobs',
          security: bearerSecurity,
          parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 250 } }],
          responses: { '200': { description: 'Recent in-memory and completed logged model downloads', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, enabled: { type: 'boolean' }, jobs: { type: 'array', items: modelDownloadJobSchema } } } } } }, ...authErrorResponses }
        },
        post: {
          summary: 'Start a streamed model download/install job',
          description: 'Downloads are streamed by Node/fetch to a .part file under an approved model directory, then atomically renamed on success. Checkpoint downloads can set the persisted default model.',
          security: bearerSecurity,
          requestBody: { required: true, content: { 'application/json': { schema: modelDownloadRequestSchema } } },
          responses: { '202': { description: 'Download job queued', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, job: modelDownloadJobSchema } } } } }, '409': { description: 'Destination file exists and overwrite was not requested' }, '422': { description: 'Invalid URL, filename, extension, or destination' }, ...authErrorResponses }
        }
      },
      '/api/v1/model-downloads/{downloadId}': {
        get: {
          summary: 'Get one model download job',
          security: bearerSecurity,
          parameters: [{ name: 'downloadId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Download job status', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, job: modelDownloadJobSchema } } } } }, '404': { description: 'Download job not found', content: { 'application/json': { schema: errorSchema } } }, ...authErrorResponses }
        }
      },
      '/api/v1/model-downloads/{downloadId}/cancel': {
        post: {
          summary: 'Cancel an in-progress model download',
          security: bearerSecurity,
          parameters: [{ name: 'downloadId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Canceled or current download job state' }, '404': { description: 'Download job not found', content: { 'application/json': { schema: errorSchema } } }, ...authErrorResponses }
        }
      },
      '/api/v1/workflows': {
        get: {
          summary: 'Workflow presets',
          security: bearerSecurity,
          responses: { '200': { description: 'Workflow presets loaded from built-ins and IMAGE_WORKFLOW_PATH' }, ...authErrorResponses }
        }
      },
      '/api/v1/workflows/{workflowId}': {
        get: {
          summary: 'Workflow preset details',
          security: bearerSecurity,
          parameters: [{ name: 'workflowId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Workflow preset details and ComfyUI mappings' }, '404': { description: 'Workflow not found', content: { 'application/json': { schema: errorSchema } } }, ...authErrorResponses }
        }
      },

      '/api/v1/favorite-prompts': {
        get: {
          summary: 'List saved favorite image-generation prompts',
          description: 'Returns compact favorite records without generated image binaries. Use the item endpoint to retrieve the stored full generation request payload.',
          security: bearerSecurity,
          parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 250 } }],
          responses: { '200': { description: 'Saved favorite generation requests', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, favorites: { type: 'array', items: favoriteImagePromptSchema } } } } } }, ...authErrorResponses }
        },
        post: {
          summary: 'Save a favorite image-generation request payload',
          description: 'Persists the full generation request payload, including unknown future fields, after validating that a prompt exists.',
          security: bearerSecurity,
          requestBody: { required: true, content: { 'application/json': { schema: favoriteImagePromptCreateSchema } } },
          responses: { '201': { description: 'Favorite prompt saved', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, favorite: favoriteImagePromptSchema } } } } }, '422': { description: 'Invalid favorite payload' }, ...authErrorResponses }
        }
      },
      '/api/v1/favorite-prompts/{favoriteId}': {
        get: {
          summary: 'Read one saved favorite prompt',
          security: bearerSecurity,
          parameters: [{ name: 'favoriteId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Favorite prompt including the full stored generation request payload', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, favorite: favoriteImagePromptSchema } } } } }, '404': { description: 'Favorite not found', content: { 'application/json': { schema: errorSchema } } }, ...authErrorResponses }
        },
        patch: {
          summary: 'Rename, annotate, or replace a saved favorite prompt',
          security: bearerSecurity,
          parameters: [{ name: 'favoriteId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: favoriteImagePromptPatchSchema } } },
          responses: { '200': { description: 'Updated favorite prompt', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, favorite: favoriteImagePromptSchema } } } } }, '404': { description: 'Favorite not found', content: { 'application/json': { schema: errorSchema } } }, '422': { description: 'Invalid favorite update' }, ...authErrorResponses }
        },
        delete: {
          summary: 'Delete a saved favorite prompt',
          security: bearerSecurity,
          parameters: [{ name: 'favoriteId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Deleted favorite prompt' }, '404': { description: 'Favorite not found', content: { 'application/json': { schema: errorSchema } } }, ...authErrorResponses }
        }
      },
      '/api/v1/image-favorites': {
        get: {
          summary: 'List saved favorite generated images',
          description: 'Returns compact favorite records with image/artifact references. Use the item endpoint to retrieve the stored full generation request payload and job metadata.',
          security: bearerSecurity,
          parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 250 } }],
          responses: { '200': { description: 'Saved generated-image favorites', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, favorites: { type: 'array', items: imageFavoriteSchema } } } } } }, ...authErrorResponses }
        },
        post: {
          summary: 'Save a generated image as a favorite',
          description: 'Persists the generated image artifact reference plus the full generation request payload, including unknown future fields. Image bytes are not stored in the favorites file.',
          security: bearerSecurity,
          requestBody: { required: true, content: { 'application/json': { schema: imageFavoriteCreateSchema } } },
          responses: { '201': { description: 'Image favorite saved', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, favorite: imageFavoriteSchema } } } } }, '422': { description: 'Invalid image favorite payload' }, ...authErrorResponses }
        }
      },
      '/api/v1/image-favorites/{favoriteId}': {
        get: {
          summary: 'Read one saved generated-image favorite',
          security: bearerSecurity,
          parameters: [{ name: 'favoriteId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Image favorite including full request payload, artifact reference, and saved job metadata', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, favorite: imageFavoriteSchema } } } } }, '404': { description: 'Image favorite not found', content: { 'application/json': { schema: errorSchema } } }, ...authErrorResponses }
        },
        patch: {
          summary: 'Rename, annotate, or replace a saved generated-image favorite',
          security: bearerSecurity,
          parameters: [{ name: 'favoriteId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: imageFavoritePatchSchema } } },
          responses: { '200': { description: 'Updated image favorite', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, favorite: imageFavoriteSchema } } } } }, '404': { description: 'Image favorite not found', content: { 'application/json': { schema: errorSchema } } }, '422': { description: 'Invalid image favorite update' }, ...authErrorResponses }
        },
        delete: {
          summary: 'Delete a saved generated-image favorite',
          security: bearerSecurity,
          parameters: [{ name: 'favoriteId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Deleted image favorite' }, '404': { description: 'Image favorite not found', content: { 'application/json': { schema: errorSchema } } }, ...authErrorResponses }
        }
      },
      '/api/v1/generate': {
        post: {
          summary: 'Submit an image-generation job',
          description: 'If model is omitted and a compatible image_default_model exists, that default checkpoint is sent to ComfyUI. Successful generations update last confirmed loaded/prewarmed model state.',
          security: bearerSecurity,
          requestBody: { required: true, content: { 'application/json': { schema: generationRequestSchema } } },
          responses: { '200': { description: 'Job completed within sync timeout and result is included' }, '202': { description: 'Job queued or running; poll the job/result URLs' }, '422': { description: 'Invalid generation request' }, '503': { description: 'Image generation is disabled' }, ...authErrorResponses }
        }
      },
      '/api/v1/jobs': {
        get: {
          summary: 'List paginated image jobs',
          description: 'Includes in-memory jobs and completed jobs reconstructed from artifact sidecar metadata. Results are sorted newest-first and paginated with a default page size of 9.',
          security: bearerSecurity,
          parameters: [
            { name: 'page', in: 'query', required: false, schema: { type: 'integer', minimum: 1, default: 1 } },
            { name: 'pageSize', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 250, default: 9 } },
            { name: 'page_size', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 250 }, description: 'Snake-case alias for pageSize.' },
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 250 }, description: 'Backward-compatible alias for pageSize.' },
            { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0 }, description: 'Optional offset alias. When provided, the response page is derived from offset and pageSize.' }
          ],
          responses: { '200': { description: 'Queue stats and paginated jobs with diffusion timing metrics', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, jobs: { type: 'array', items: jobSchema }, items: { type: 'array', items: jobSchema }, page: { type: 'integer' }, pageSize: { type: 'integer' }, offset: { type: 'integer' }, totalItems: { type: 'integer' }, totalPages: { type: 'integer' }, hasNextPage: { type: 'boolean' }, hasPreviousPage: { type: 'boolean' } } } } } }, ...authErrorResponses }
        }
      },
      '/api/v1/jobs/{jobId}': {
        get: {
          summary: 'Get image job status/details',
          security: bearerSecurity,
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Job status/details', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, job: jobSchema } } } } }, '404': { description: 'Job not found', content: { 'application/json': { schema: errorSchema } } }, ...authErrorResponses }
        }
      },
      '/api/v1/jobs/{jobId}/result': {
        get: {
          summary: 'Get image job result',
          security: bearerSecurity,
          parameters: [
            { name: 'jobId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'format', in: 'query', required: false, schema: { enum: ['metadata', 'url', 'base64', 'binary'] } }
          ],
          responses: { '200': { description: 'Completed job result' }, '202': { description: 'Job is still queued or running' }, ...authErrorResponses }
        }
      },
      '/api/v1/jobs/{jobId}/cancel': {
        post: {
          summary: 'Cancel an image job',
          security: bearerSecurity,
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Canceled or current job state' }, ...authErrorResponses }
        }
      },
      '/api/v1/jobs/{jobId}/replay': {
        post: {
          summary: 'Replay/resubmit an in-memory image job request',
          security: bearerSecurity,
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '202': { description: 'New job submitted using the original normalized request' }, '404': { description: 'Original job is not in memory' }, ...authErrorResponses }
        }
      },
      '/api/v1/artifacts/{artifactId}': {
        get: {
          summary: 'Retrieve generated artifact bytes or metadata',
          security: bearerSecurity,
          parameters: [
            { name: 'artifactId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'metadata', in: 'query', required: false, schema: { enum: ['1'] } },
            { name: 'format', in: 'query', required: false, schema: { enum: ['metadata'] } }
          ],
          responses: { '200': { description: 'Artifact bytes, or metadata when requested' }, '404': { description: 'Artifact not found' }, ...authErrorResponses }
        }
      },
      '/gpu': {
        get: {
          summary: 'Compatibility single-GPU telemetry',
          responses: {
            '200': { description: 'Primary GPU in the older response shape' },
            '503': { description: 'No GPU or nvidia-smi unavailable', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/gpus': {
        get: {
          summary: 'Compatibility GPU telemetry list',
          responses: {
            '200': { description: 'All GPUs visible through nvidia-smi', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, gpus: { type: 'array', items: gpuSchema } } } } } },
            '503': { description: 'nvidia-smi unavailable', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      }
    }
  };
}
