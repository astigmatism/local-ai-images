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
    model: { type: 'string' },
    workflow_id: { type: 'string' },
    width: { type: 'number' },
    height: { type: 'number' },
    steps: { type: 'number' },
    cfg_scale: { type: 'number' },
    seed: { type: 'number' },
    sampler_name: { type: 'string' },
    scheduler: { type: 'string' },
    output: { enum: ['metadata', 'url', 'base64', 'binary'] },
    sync_timeout_ms: { type: 'number' }
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

const jobSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    status: { enum: ['queued', 'running', 'succeeded', 'failed', 'canceled'] },
    provider: { type: 'string' },
    workflowId: { type: 'string' },
    model: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    artifacts: { type: 'array', items: artifactSchema }
  }
} as const;

const bearerSecurity = [{ bearerAuth: [] }, { apiKeyAuth: [] }];

export function buildOpenApiDocument() {
  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: SERVICE_NAME,
      version: APPLICATION_VERSION,
      description: `Node-based ${SERVICE_NAME} ComfyUI image-generation API and control-panel runtime (${RUNTIME_NAME}). Legacy Ollama endpoints are optional and disabled unless LEGACY_OLLAMA_ENABLED=true.`
    },
    servers: [
      { url: 'http://127.0.0.1:8000', description: 'Local AI Images URL' }
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
        Job: jobSchema,
        Artifact: artifactSchema
      }
    },
    paths: {
      '/health': {
        get: {
          summary: 'Image service health',
          description: 'Unauthenticated compatibility health endpoint. In the default image-only mode this reports the same image-service state as /api/v1/health and does not contact Ollama.',
          responses: {
            '200': { description: 'Image service health state' }
          }
        }
      },
      '/api/v1/health': {
        get: {
          summary: 'Image API health',
          security: bearerSecurity,
          responses: {
            '200': { description: 'Image service, ComfyUI/mock provider, queue, workflow, model-path, auth, and GPU state' },
            '401': { description: 'Image API authentication failed', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/v1/capabilities': {
        get: {
          summary: 'Image API capabilities',
          security: bearerSecurity,
          responses: {
            '200': { description: 'Supported image-generation features and workflow summaries' },
            '401': { description: 'Image API authentication failed', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/v1/stats': {
        get: {
          summary: 'Runtime stats',
          security: bearerSecurity,
          responses: {
            '200': { description: 'ComfyUI/mock provider state, GPU telemetry, queue stats, and recent jobs' },
            '401': { description: 'Image API authentication failed', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/v1/models': {
        get: {
          summary: 'Scanned local image model inventory',
          security: bearerSecurity,
          responses: {
            '200': { description: 'Model files discovered under IMAGE_MODEL_PATHS' },
            '401': { description: 'Image API authentication failed', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/v1/models/refresh': {
        post: {
          summary: 'Refresh local image model inventory',
          security: bearerSecurity,
          responses: {
            '200': { description: 'Refreshed model inventory' },
            '401': { description: 'Image API authentication failed', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/v1/workflows': {
        get: {
          summary: 'Workflow presets',
          security: bearerSecurity,
          responses: {
            '200': { description: 'Workflow presets loaded from built-ins and IMAGE_WORKFLOW_PATH' },
            '401': { description: 'Image API authentication failed', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/v1/workflows/{workflowId}': {
        get: {
          summary: 'Workflow preset details',
          security: bearerSecurity,
          parameters: [{ name: 'workflowId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Workflow preset details and ComfyUI mappings' },
            '401': { description: 'Image API authentication failed', content: { 'application/json': { schema: errorSchema } } },
            '404': { description: 'Workflow not found', content: { 'application/json': { schema: errorSchema } } }
          }
        }
      },
      '/api/v1/generate': {
        post: {
          summary: 'Submit an image-generation job',
          security: bearerSecurity,
          requestBody: { required: true, content: { 'application/json': { schema: generationRequestSchema } } },
          responses: {
            '200': { description: 'Job completed within sync timeout and result is included' },
            '202': { description: 'Job queued or running; poll the job/result URLs' },
            '401': { description: 'Image API authentication failed', content: { 'application/json': { schema: errorSchema } } },
            '422': { description: 'Invalid generation request' },
            '503': { description: 'Image generation is disabled' }
          }
        }
      },
      '/api/v1/jobs': {
        get: {
          summary: 'List recent image jobs',
          security: bearerSecurity,
          responses: { '200': { description: 'Queue stats and recent jobs' } }
        }
      },
      '/api/v1/jobs/{jobId}': {
        get: {
          summary: 'Get image job status',
          security: bearerSecurity,
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Job status', content: { 'application/json': { schema: { type: 'object', properties: { ok: { const: true }, job: jobSchema } } } } } }
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
          responses: { '200': { description: 'Completed job result' }, '202': { description: 'Job is still queued or running' } }
        }
      },
      '/api/v1/jobs/{jobId}/cancel': {
        post: {
          summary: 'Cancel an image job',
          security: bearerSecurity,
          parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: 'Canceled or current job state' } }
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
          responses: { '200': { description: 'Artifact bytes, or metadata when requested' }, '404': { description: 'Artifact not found' } }
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
