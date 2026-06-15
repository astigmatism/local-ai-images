import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { ConfigStore } from './config/store.ts';
import { AppError, toErrorPayload, statusCodeForError } from './errors.ts';
import type { Logger } from './logger.ts';
import { buildOpenApiDocument } from './openapi.ts';
import { toLegacyGpu } from './services/gpuService.ts';
import { createImageRuntime, type ImageRuntime } from './services/image/runtime.ts';
import type { AppConfig, ArtifactMetadata, GpuServiceLike, ImageJob, OllamaClientLike, OllamaImageGenerateOptions, OutputDelivery, RuntimeConfig, WorkflowPreset } from './types.ts';
import { validateModelLoadRequest, validateModelName } from './utils/validation.ts';
import { authenticateImageApiRequest } from './utils/auth.ts';
import { normalizeResultDelivery, validateAndNormalizeGenerationRequest } from './utils/imageRequests.ts';
import { isDefaultModelLoaded } from './utils/modelState.ts';
import { APPLICATION_VERSION, RUNTIME_NAME, SERVICE_NAME } from './version.ts';

export interface AppDependencies {
  runtimeConfig: RuntimeConfig;
  configStore: ConfigStore;
  ollamaClient: OllamaClientLike;
  gpuService: GpuServiceLike;
  logger: Logger;
  imageRuntime?: ImageRuntime;
}

interface ResolvedAppDependencies extends AppDependencies {
  imageRuntime: ImageRuntime;
}

export type RequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

export function createRequestHandler(dependencies: AppDependencies): RequestHandler {
  const resolvedDependencies: ResolvedAppDependencies = {
    ...dependencies,
    imageRuntime: dependencies.imageRuntime ?? createImageRuntime(dependencies.runtimeConfig, dependencies.logger)
  };

  return async (request, response) => {
    const start = Date.now();
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

    try {
      await routeRequest(method, url, request, response, resolvedDependencies);
    } catch (error: unknown) {
      dependencies.logger.error({ err: error, method, path: url.pathname }, 'Unhandled request error');
      sendJson(response, statusCodeForError(error), toErrorPayload(error));
    } finally {
      dependencies.logger.info({
        method,
        path: url.pathname,
        statusCode: response.statusCode,
        durationMs: Date.now() - start
      }, 'request completed');
    }
  };
}

async function routeRequest(method: string, url: URL, request: IncomingMessage, response: ServerResponse, dependencies: ResolvedAppDependencies): Promise<void> {
  const { gpuService, runtimeConfig, logger } = dependencies;
  const pathName = url.pathname;

  if (method === 'GET' && pathName === '/') {
    sendText(response, 200, renderPortalHtml(), 'text/html; charset=utf-8');
    return;
  }

  if (method === 'GET' && pathName === '/assets/app.css') {
    sendText(response, 200, await readPublicAsset('app.css', logger), 'text/css; charset=utf-8');
    return;
  }

  if (method === 'GET' && pathName === '/assets/app.js') {
    sendText(response, 200, await readPublicAsset('app.js', logger), 'application/javascript; charset=utf-8');
    return;
  }

  if (method === 'GET' && pathName === '/openapi.json') {
    sendJson(response, 200, buildOpenApiDocument());
    return;
  }

  if (pathName.startsWith('/api/v1/')) {
    await routeImageApiV1(method, url, request, response, dependencies);
    return;
  }

  if (method === 'GET' && pathName === '/health') {
    if (runtimeConfig.legacyOllamaEnabled) {
      await handleLegacyHealth(response, dependencies.configStore, dependencies.ollamaClient, runtimeConfig);
      return;
    }
    await handleImageApiHealth(response, dependencies);
    return;
  }

  if (method === 'GET' && pathName === '/api/capabilities') {
    if (runtimeConfig.legacyOllamaEnabled) {
      await handleLegacyCapabilities(response, dependencies.configStore, dependencies.ollamaClient, runtimeConfig, logger);
      return;
    }
    await handleImageApiCapabilities(response, dependencies);
    return;
  }

  if (method === 'GET' && pathName === '/gpu') {
    try {
      const gpus = await gpuService.queryGpus();
      if (gpus.length === 0) {
        sendJson(response, 503, { ok: false, error: { code: 'NO_GPUS_DETECTED', message: 'No NVIDIA GPUs detected' } });
        return;
      }
      sendJson(response, 200, { ok: true, gpu: toLegacyGpu(gpus[0]!) });
    } catch (error: unknown) {
      sendJson(response, statusCodeForError(error, 503), toErrorPayload(error, 'GPU_TELEMETRY_FAILED'));
    }
    return;
  }

  if (method === 'GET' && pathName === '/gpus') {
    try {
      const gpus = await gpuService.queryGpus();
      sendJson(response, 200, { ok: true, gpus });
    } catch (error: unknown) {
      sendJson(response, statusCodeForError(error, 503), toErrorPayload(error, 'GPU_TELEMETRY_FAILED'));
    }
    return;
  }

  if (isLegacyOllamaRoute(method, pathName)) {
    if (!runtimeConfig.legacyOllamaEnabled) {
      sendLegacyOllamaDisabled(response, pathName);
      return;
    }
    await routeLegacyOllamaRequest(method, pathName, request, response, dependencies);
    return;
  }

  sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: `No route for ${method} ${pathName}` } });
}

async function routeLegacyOllamaRequest(
  method: string,
  pathName: string,
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ResolvedAppDependencies
): Promise<void> {
  const { configStore, ollamaClient, runtimeConfig, logger } = dependencies;

  if (method === 'POST' && pathName === '/api/images/generate') {
    await handleLegacyImageGeneration(request, response, configStore, ollamaClient, runtimeConfig, logger);
    return;
  }

  if (method === 'GET' && pathName === '/models/running') {
    try {
      const models = await ollamaClient.listRunningModels();
      sendJson(response, 200, { ok: true, models });
    } catch (error: unknown) {
      sendJson(response, statusCodeForError(error, 503), toErrorPayload(error));
    }
    return;
  }

  if (method === 'GET' && pathName === '/models/installed') {
    try {
      const models = await ollamaClient.listInstalledModels();
      sendJson(response, 200, { ok: true, models });
    } catch (error: unknown) {
      sendJson(response, statusCodeForError(error, 503), toErrorPayload(error));
    }
    return;
  }

  if (method === 'GET' && pathName === '/config') {
    try {
      const config = await configStore.readConfig();
      sendJson(response, 200, { ok: true, config, path: configStore.path });
    } catch (error: unknown) {
      sendJson(response, statusCodeForError(error), toErrorPayload(error));
    }
    return;
  }

  if (method === 'POST' && pathName === '/config') {
    const body = await readJsonBody(request);
    const defaultModel = isRecord(body) ? body.default_model : undefined;
    const errors = validateModelName(defaultModel, ['body', 'default_model']);
    if (errors.length > 0) {
      sendJson(response, 422, { detail: errors });
      return;
    }

    try {
      const config = await configStore.updateDefaultModel(String(defaultModel).trim());
      sendJson(response, 200, { ok: true, config, path: configStore.path });
    } catch (error: unknown) {
      sendJson(response, statusCodeForError(error), toErrorPayload(error));
    }
    return;
  }

  if (method === 'POST' && pathName === '/model/load') {
    const body = await readJsonBody(request);
    const parsed = validateModelLoadRequest(body);
    if (!parsed.ok) {
      sendJson(response, 422, parsed.response);
      return;
    }

    const { model, make_default: makeDefault } = parsed.value;

    try {
      const prewarm = await ollamaClient.prewarmModel(model, runtimeConfig.prewarmKeepAlive, runtimeConfig.prewarmTimeoutMs);
      const config = makeDefault
        ? await configStore.updateDefaultModel(model)
        : await configStore.readConfig();
      const runningModels = await safeListRunningModels(ollamaClient, logger);
      const loaded = isDefaultModelLoaded(model, runningModels);

      sendJson(response, 200, {
        ok: true,
        model,
        made_default: makeDefault,
        loaded,
        default_model: config.default_model,
        prewarm: prewarm.response,
        running_models: runningModels
      });
    } catch (error: unknown) {
      sendJson(response, statusCodeForError(error, 502), toErrorPayload(error, 'MODEL_LOAD_FAILED'));
    }
    return;
  }

  if (method === 'POST' && pathName === '/model/prewarm') {
    const body = await readJsonBody(request);
    let config: AppConfig;

    try {
      config = await configStore.readConfig();
    } catch (error: unknown) {
      sendJson(response, statusCodeForError(error), toErrorPayload(error));
      return;
    }

    const requestedModel = isRecord(body) && body.model !== undefined ? body.model : config.default_model;
    const errors = validateModelName(requestedModel, ['body', 'model']);
    if (errors.length > 0) {
      sendJson(response, 422, { detail: errors });
      return;
    }

    const model = String(requestedModel).trim();

    try {
      const prewarm = await ollamaClient.prewarmModel(model, runtimeConfig.prewarmKeepAlive, runtimeConfig.prewarmTimeoutMs);
      const runningModels = await safeListRunningModels(ollamaClient, logger);
      const loaded = isDefaultModelLoaded(model, runningModels);

      sendJson(response, 200, {
        ok: true,
        model,
        loaded,
        default_model: config.default_model,
        prewarm: prewarm.response,
        running_models: runningModels
      });
    } catch (error: unknown) {
      sendJson(response, statusCodeForError(error, 502), toErrorPayload(error, 'MODEL_PREWARM_FAILED'));
    }
  }
}

function isLegacyOllamaRoute(method: string, pathName: string): boolean {
  return (
    (method === 'POST' && pathName === '/api/images/generate') ||
    (method === 'GET' && pathName === '/models/running') ||
    (method === 'GET' && pathName === '/models/installed') ||
    ((method === 'GET' || method === 'POST') && pathName === '/config') ||
    (method === 'POST' && pathName === '/model/load') ||
    (method === 'POST' && pathName === '/model/prewarm')
  );
}

function sendLegacyOllamaDisabled(response: ServerResponse, pathName: string): void {
  sendJson(response, 410, {
    ok: false,
    error: {
      code: 'LEGACY_OLLAMA_DISABLED',
      message: `Legacy Ollama compatibility endpoint ${pathName} is disabled. Set LEGACY_OLLAMA_ENABLED=true to enable retained Ollama routes. New image integrations should use /api/v1/generate and related /api/v1 endpoints.`
    }
  });
}


async function routeImageApiV1(
  method: string,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ResolvedAppDependencies
): Promise<void> {
  const { runtimeConfig } = dependencies;

  try {
    authenticateImageApiRequest(request, runtimeConfig);
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error, 401), toErrorPayload(error));
    return;
  }

  const pathName = url.pathname;

  if (method === 'GET' && pathName === '/api/v1/health') {
    await handleImageApiHealth(response, dependencies);
    return;
  }

  if (method === 'GET' && pathName === '/api/v1/capabilities') {
    await handleImageApiCapabilities(response, dependencies);
    return;
  }

  if (method === 'GET' && pathName === '/api/v1/stats') {
    await handleImageApiStats(response, dependencies);
    return;
  }

  if (method === 'GET' && pathName === '/api/v1/models') {
    await handleImageApiModels(response, dependencies, false);
    return;
  }

  if (method === 'POST' && pathName === '/api/v1/models/refresh') {
    await handleImageApiModels(response, dependencies, true);
    return;
  }

  if (method === 'GET' && pathName === '/api/v1/workflows') {
    await handleImageApiWorkflows(response, dependencies);
    return;
  }

  const workflowMatch = /^\/api\/v1\/workflows\/([^/]+)$/u.exec(pathName);
  if (method === 'GET' && workflowMatch?.[1]) {
    await handleImageApiWorkflow(response, dependencies, decodeURIComponent(workflowMatch[1]));
    return;
  }

  if (method === 'POST' && pathName === '/api/v1/generate') {
    await handleImageApiGenerate(request, response, dependencies);
    return;
  }

  if (method === 'GET' && pathName === '/api/v1/jobs') {
    handleImageApiJobs(response, dependencies, url);
    return;
  }

  const jobMatch = /^\/api\/v1\/jobs\/([^/]+)(?:\/(result|cancel))?$/u.exec(pathName);
  if (jobMatch?.[1]) {
    const jobId = decodeURIComponent(jobMatch[1]);
    const suffix = jobMatch[2];
    if (method === 'GET' && suffix === undefined) {
      handleImageApiJob(response, dependencies, jobId);
      return;
    }
    if (method === 'GET' && suffix === 'result') {
      await handleImageApiJobResult(response, dependencies, jobId, url);
      return;
    }
    if (method === 'POST' && suffix === 'cancel') {
      await handleImageApiJobCancel(response, dependencies, jobId);
      return;
    }
  }

  const artifactMatch = /^\/api\/v1\/artifacts\/([^/]+)$/u.exec(pathName);
  if (method === 'GET' && artifactMatch?.[1]) {
    await handleImageApiArtifact(response, dependencies, decodeURIComponent(artifactMatch[1]), url);
    return;
  }

  sendJson(response, 404, { ok: false, error: { code: 'NOT_FOUND', message: `No route for ${method} ${pathName}` } });
}

async function handleImageApiHealth(response: ServerResponse, dependencies: ResolvedAppDependencies): Promise<void> {
  const { imageRuntime, runtimeConfig, gpuService } = dependencies;
  const [engine, workflows, gpus] = await Promise.all([
    imageRuntime.provider.health(),
    imageRuntime.workflowStore.list().catch(() => []),
    queryGpuSummary(gpuService)
  ]);

  sendJson(response, 200, {
    ok: runtimeConfig.imageGenerationEnabled && engine.ok,
    service: `${SERVICE_NAME} Image Generation API`,
    version: APPLICATION_VERSION,
    runtime: RUNTIME_NAME,
    enabled: runtimeConfig.imageGenerationEnabled,
    backend: runtimeConfig.imageBackend,
    engine,
    gpu: gpus,
    queue: imageRuntime.jobQueue.stats(),
    models: {
      paths: runtimeConfig.imageModelPaths,
      cached_count: imageRuntime.modelScanner.getCachedInventory()?.models.length ?? null
    },
    workflows: {
      default_workflow_id: runtimeConfig.imageDefaultWorkflowId,
      count: workflows.length
    },
    auth: authStatus(runtimeConfig)
  });
}

async function handleImageApiCapabilities(response: ServerResponse, dependencies: ResolvedAppDependencies): Promise<void> {
  const { imageRuntime, runtimeConfig } = dependencies;
  const workflows = await imageRuntime.workflowStore.list();
  sendJson(response, 200, {
    ok: true,
    service: 'local-ai-images',
    backend: runtimeConfig.imageBackend,
    engine: imageRuntime.provider.name,
    enabled: runtimeConfig.imageGenerationEnabled,
    auth: authStatus(runtimeConfig),
    api_version: 'v1',
    endpoints: {
      health: '/api/v1/health',
      stats: '/api/v1/stats',
      models: '/api/v1/models',
      workflows: '/api/v1/workflows',
      generate: '/api/v1/generate',
      jobs: '/api/v1/jobs',
      artifacts: '/api/v1/artifacts/{artifactId}'
    },
    generation: {
      async_jobs: true,
      sync_timeout: true,
      output_delivery: ['metadata', 'url', 'base64', 'binary'],
      max_prompt_chars: runtimeConfig.imageGenerationMaxPromptChars,
      parameters: ['prompt', 'negative_prompt', 'model', 'workflow_id', 'width', 'height', 'steps', 'cfg_scale', 'seed', 'sampler_name', 'scheduler']
    },
    workflows: workflows.map(publicWorkflowSummary)
  });
}

async function handleImageApiStats(response: ServerResponse, dependencies: ResolvedAppDependencies): Promise<void> {
  const { imageRuntime, gpuService } = dependencies;
  const [engine, gpus] = await Promise.all([
    imageRuntime.provider.health(),
    queryGpuSummary(gpuService)
  ]);
  sendJson(response, 200, {
    ok: true,
    engine,
    gpu: gpus,
    queue: imageRuntime.jobQueue.stats(),
    recent_jobs: imageRuntime.jobQueue.listJobs(10)
  });
}

async function handleImageApiModels(response: ServerResponse, dependencies: ResolvedAppDependencies, refresh: boolean): Promise<void> {
  try {
    const inventory = refresh
      ? await dependencies.imageRuntime.modelScanner.refresh()
      : await dependencies.imageRuntime.modelScanner.list();
    sendJson(response, 200, inventory);
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error, 'MODEL_SCAN_FAILED'));
  }
}

async function handleImageApiWorkflows(response: ServerResponse, dependencies: ResolvedAppDependencies): Promise<void> {
  try {
    const workflows = await dependencies.imageRuntime.workflowStore.list();
    sendJson(response, 200, {
      ok: true,
      default_workflow_id: dependencies.runtimeConfig.imageDefaultWorkflowId,
      workflows: workflows.map(publicWorkflowSummary)
    });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error, 'WORKFLOW_LOAD_FAILED'));
  }
}

async function handleImageApiWorkflow(response: ServerResponse, dependencies: ResolvedAppDependencies, workflowId: string): Promise<void> {
  try {
    const workflow = await dependencies.imageRuntime.workflowStore.get(workflowId);
    sendJson(response, 200, {
      ok: true,
      workflow: publicWorkflowDetails(workflow)
    });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error));
  }
}

async function handleImageApiGenerate(request: IncomingMessage, response: ServerResponse, dependencies: ResolvedAppDependencies): Promise<void> {
  const { imageRuntime, runtimeConfig } = dependencies;
  if (!runtimeConfig.imageGenerationEnabled) {
    sendJson(response, 503, {
      ok: false,
      error: {
        code: 'IMAGE_GENERATION_DISABLED',
        message: 'Image generation is disabled. Set IMAGE_GENERATION_ENABLED=true to enable /api/v1/generate.'
      }
    });
    return;
  }

  const body = await readJsonBody(request);
  const workflows = await imageRuntime.workflowStore.list();
  const parsed = validateAndNormalizeGenerationRequest(body, runtimeConfig, workflows);
  if (!parsed.ok) {
    sendJson(response, 422, parsed.response);
    return;
  }

  try {
    const job = imageRuntime.jobQueue.submit(parsed.value, parsed.workflow);
    const completedJob = await imageRuntime.jobQueue.waitForCompletion(job.id, parsed.value.syncTimeoutMs);

    if (!completedJob) {
      sendJson(response, 202, {
        ok: true,
        job: publicJob(job),
        result_url: `/api/v1/jobs/${encodeURIComponent(job.id)}/result`,
        status_url: `/api/v1/jobs/${encodeURIComponent(job.id)}`
      });
      return;
    }

    await sendJobResult(response, dependencies, completedJob, parsed.value.output);
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error, 500), toErrorPayload(error, 'IMAGE_GENERATION_FAILED'));
  }
}

function handleImageApiJobs(response: ServerResponse, dependencies: ResolvedAppDependencies, url: URL): void {
  const limit = readQueryInteger(url, 'limit', 50, 1, 250);
  sendJson(response, 200, {
    ok: true,
    queue: dependencies.imageRuntime.jobQueue.stats(),
    jobs: dependencies.imageRuntime.jobQueue.listJobs(limit)
  });
}

function handleImageApiJob(response: ServerResponse, dependencies: ResolvedAppDependencies, jobId: string): void {
  try {
    const job = dependencies.imageRuntime.jobQueue.getJob(jobId);
    sendJson(response, 200, { ok: true, job: publicJob(job) });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error));
  }
}

async function handleImageApiJobResult(response: ServerResponse, dependencies: ResolvedAppDependencies, jobId: string, url: URL): Promise<void> {
  try {
    const job = dependencies.imageRuntime.jobQueue.getJob(jobId);
    const requestedDelivery = normalizeResultDelivery(url.searchParams.get('format'), job.request.output);
    if (!requestedDelivery) {
      sendJson(response, 422, validationDetail(['query', 'format'], 'format must be metadata, url, base64, or binary', 'enum'));
      return;
    }
    await sendJobResult(response, dependencies, job, requestedDelivery);
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error));
  }
}

async function handleImageApiJobCancel(response: ServerResponse, dependencies: ResolvedAppDependencies, jobId: string): Promise<void> {
  try {
    const job = await dependencies.imageRuntime.jobQueue.cancel(jobId);
    sendJson(response, 200, { ok: true, job: publicJob(job) });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error));
  }
}

async function handleImageApiArtifact(response: ServerResponse, dependencies: ResolvedAppDependencies, artifactId: string, url: URL): Promise<void> {
  try {
    if (url.searchParams.get('metadata') === '1' || url.searchParams.get('format') === 'metadata') {
      const metadata = await dependencies.imageRuntime.artifactStore.getMetadata(artifactId);
      sendJson(response, 200, { ok: true, artifact: publicArtifact(metadata) });
      return;
    }

    const { metadata, buffer } = await dependencies.imageRuntime.artifactStore.getArtifact(artifactId);
    response.writeHead(200, {
      'content-type': metadata.mimeType,
      'content-length': buffer.byteLength,
      'cache-control': 'private, max-age=31536000, immutable',
      'x-artifact-id': metadata.id,
      'x-job-id': metadata.jobId
    });
    response.end(buffer);
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error));
  }
}

async function sendJobResult(
  response: ServerResponse,
  dependencies: ResolvedAppDependencies,
  job: ImageJob,
  delivery: OutputDelivery
): Promise<void> {
  if (job.status === 'queued' || job.status === 'running') {
    sendJson(response, 202, {
      ok: true,
      job: publicJob(job),
      result_url: `/api/v1/jobs/${encodeURIComponent(job.id)}/result`
    });
    return;
  }

  if (job.status !== 'succeeded') {
    sendJson(response, job.status === 'canceled' ? 409 : 502, {
      ok: false,
      job: publicJob(job),
      error: job.error ?? { code: 'IMAGE_JOB_FAILED', message: `Job ${job.id} finished with status ${job.status}.` }
    });
    return;
  }

  if (delivery === 'binary') {
    const artifact = job.artifacts[0];
    if (!artifact) {
      sendJson(response, 502, { ok: false, error: { code: 'ARTIFACT_MISSING', message: 'The completed job does not have an artifact.' } });
      return;
    }
    const { metadata, buffer } = await dependencies.imageRuntime.artifactStore.getArtifact(artifact.id);
    response.writeHead(200, {
      'content-type': metadata.mimeType,
      'content-length': buffer.byteLength,
      'cache-control': 'no-store',
      'x-artifact-id': metadata.id,
      'x-job-id': metadata.jobId
    });
    response.end(buffer);
    return;
  }

  const artifacts = job.artifacts.map(publicArtifact);
  if (delivery === 'base64') {
    const encodedArtifacts = [];
    for (const artifact of job.artifacts) {
      const { metadata, buffer } = await dependencies.imageRuntime.artifactStore.getArtifact(artifact.id);
      encodedArtifacts.push({
        ...publicArtifact(metadata),
        base64: buffer.toString('base64')
      });
    }
    sendJson(response, 200, {
      ok: true,
      job: publicJob(job),
      artifacts: encodedArtifacts,
      metadata: job.metadata
    });
    return;
  }

  sendJson(response, 200, {
    ok: true,
    job: publicJob(job),
    artifacts: delivery === 'metadata' ? artifacts.map((artifact) => ({ ...artifact, url: undefined })) : artifacts,
    metadata: job.metadata
  });
}

async function queryGpuSummary(gpuService: GpuServiceLike): Promise<{ ok: boolean; gpus: unknown[]; error?: unknown }> {
  try {
    const gpus = await gpuService.queryGpus();
    return { ok: true, gpus };
  } catch (error: unknown) {
    return { ok: false, gpus: [], error: toErrorPayload(error, 'GPU_TELEMETRY_FAILED').error };
  }
}

function authStatus(runtimeConfig: RuntimeConfig) {
  return {
    enabled: runtimeConfig.requireImageApiAuth || runtimeConfig.imageApiKeys.length > 0,
    required: runtimeConfig.requireImageApiAuth,
    configured_key_count: runtimeConfig.imageApiKeys.length,
    supported_headers: ['Authorization: Bearer <key>', 'X-API-Key']
  };
}

function publicWorkflowSummary(workflow: WorkflowPreset) {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    engine: workflow.engine,
    defaults: workflow.defaults,
    parameters: workflow.parameters,
    source: workflow.source,
    has_internal_template: true
  };
}

function publicWorkflowDetails(workflow: WorkflowPreset) {
  return {
    ...publicWorkflowSummary(workflow),
    mappings: workflow.comfyui.mappings
  };
}

function publicJob(job: ImageJob) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    provider: job.provider,
    providerJobId: job.providerJobId,
    workflowId: job.workflowId,
    model: job.model,
    request: job.request,
    artifacts: job.artifacts.map(publicArtifact),
    error: job.error,
    metadata: job.metadata
  };
}

function publicArtifact(artifact: ArtifactMetadata) {
  const { filePath: _filePath, ...publicMetadata } = artifact;
  return publicMetadata;
}

function readQueryInteger(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}


const OLLAMA_IMAGE_GENERATION_CAPABILITY = 'image';
const OLLAMA_IMAGE_INPUT_CAPABILITY = 'vision';

interface ImageGenerationCapability {
  enabled: boolean;
  provider: 'ollama';
  currentModel: string | null;
  installed: boolean | null;
  loaded: boolean | null;
  available: boolean;
  endpoint: '/api/images/generate';
  ollamaEndpoint: '/api/generate';
  requiredCapability: 'image';
  modelCapabilities: string[];
  supportsImageGeneration: boolean | null;
  supportsImageInput: boolean | null;
  maxPromptChars: number;
  reason?: string;
}

async function handleLegacyCapabilities(
  response: ServerResponse,
  configStore: ConfigStore,
  ollamaClient: OllamaClientLike,
  runtimeConfig: RuntimeConfig,
  logger: Logger
): Promise<void> {
  const imageGeneration = await resolveImageGenerationCapability(configStore, ollamaClient, runtimeConfig, logger);

  sendJson(response, 200, {
    ok: true,
    textGeneration: false,
    textStreaming: false,
    imageInput: imageGeneration.supportsImageInput === true,
    imageGeneration,
    modelCapabilities: buildModelCapabilityReport(imageGeneration)
  });
}

async function resolveImageGenerationCapability(
  configStore: ConfigStore,
  ollamaClient: OllamaClientLike,
  runtimeConfig: RuntimeConfig,
  logger: Logger
): Promise<ImageGenerationCapability> {
  const currentModel = await resolveCurrentModel(configStore);
  const baseCapability: Omit<ImageGenerationCapability, 'installed' | 'loaded' | 'available' | 'reason'> = {
    enabled: runtimeConfig.imageGenerationEnabled,
    provider: 'ollama',
    currentModel,
    endpoint: '/api/images/generate',
    ollamaEndpoint: '/api/generate',
    requiredCapability: OLLAMA_IMAGE_GENERATION_CAPABILITY,
    modelCapabilities: [],
    supportsImageGeneration: null,
    supportsImageInput: null,
    maxPromptChars: runtimeConfig.imageGenerationMaxPromptChars
  };

  if (!runtimeConfig.imageGenerationEnabled) {
    return {
      ...baseCapability,
      installed: null,
      loaded: null,
      available: false,
      reason: 'Image generation is disabled. Set IMAGE_GENERATION_ENABLED=true to enable it for an image-generation-capable provider/model.'
    };
  }

  if (!currentModel) {
    return {
      ...baseCapability,
      installed: null,
      loaded: null,
      available: false,
      reason: 'No current model is selected. Load or set a default model before generating images.'
    };
  }

  let installedModels;
  let runningModels;
  try {
    [installedModels, runningModels] = await Promise.all([
      ollamaClient.listInstalledModels(),
      safeListRunningModels(ollamaClient, logger)
    ]);
  } catch (error: unknown) {
    logger.warn({ err: error, model: currentModel }, 'Unable to verify current model for image generation');
    return {
      ...baseCapability,
      installed: null,
      loaded: null,
      available: false,
      reason: 'Unable to verify installed Ollama models for image generation.'
    };
  }

  const installed = modelListIncludes(installedModels, currentModel);
  const loaded = isDefaultModelLoaded(currentModel, runningModels);

  if (!installed) {
    return {
      ...baseCapability,
      installed,
      loaded,
      available: false,
      reason: `Current model ${currentModel} is not installed in Ollama.`
    };
  }

  try {
    const modelInfo = await ollamaClient.showModel(currentModel);
    const modelCapabilities = normalizeCapabilityList(modelInfo.capabilities);
    const supportsImageGeneration = capabilityListIncludes(modelCapabilities, OLLAMA_IMAGE_GENERATION_CAPABILITY);
    const supportsImageInput = capabilityListIncludes(modelCapabilities, OLLAMA_IMAGE_INPUT_CAPABILITY);

    return {
      ...baseCapability,
      installed,
      loaded,
      modelCapabilities,
      supportsImageGeneration,
      supportsImageInput,
      available: supportsImageGeneration,
      ...(supportsImageGeneration ? {} : { reason: unsupportedImageGenerationReason(currentModel, modelCapabilities, supportsImageInput) })
    };
  } catch (error: unknown) {
    logger.warn({ err: error, model: currentModel }, 'Unable to verify Ollama model capabilities for image generation');
    return {
      ...baseCapability,
      installed,
      loaded,
      available: false,
      reason: 'Unable to verify Ollama model capabilities. Image generation will not be routed to Ollama until the selected model reports capability "image".'
    };
  }
}

function buildModelCapabilityReport(imageGeneration: ImageGenerationCapability) {
  const supportsTextGeneration = capabilityListIncludes(imageGeneration.modelCapabilities, 'completion');
  const supportsImageInput = imageGeneration.supportsImageInput === true;

  return {
    provider: imageGeneration.provider,
    currentModel: imageGeneration.currentModel,
    installed: imageGeneration.installed,
    loaded: imageGeneration.loaded,
    ollamaCapabilities: imageGeneration.modelCapabilities,
    textGeneration: {
      available: supportsTextGeneration,
      exposedByService: false,
      providerEndpoint: '/api/generate'
    },
    chatCompletion: {
      available: supportsTextGeneration,
      exposedByService: false,
      providerEndpoint: '/api/chat'
    },
    textStreaming: {
      available: supportsTextGeneration,
      exposedByService: false,
      providerEndpoint: '/api/generate'
    },
    imageInput: {
      available: supportsImageInput,
      exposedByService: false,
      providerEndpoint: '/api/chat',
      note: 'Vision/image input is a separate capability from image-generation output.'
    },
    imageGeneration: {
      available: imageGeneration.available,
      exposedByService: true,
      serviceEndpoint: imageGeneration.endpoint,
      providerEndpoint: imageGeneration.ollamaEndpoint,
      requiredCapability: imageGeneration.requiredCapability,
      reason: imageGeneration.reason
    }
  };
}

function normalizeCapabilityList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

function capabilityListIncludes(capabilities: string[], capability: string): boolean {
  const normalizedCapability = capability.toLowerCase();
  return capabilities.some((item) => item.toLowerCase() === normalizedCapability);
}

function unsupportedImageGenerationReason(model: string, capabilities: string[], supportsImageInput: boolean): string {
  const reported = capabilities.length > 0
    ? ` Reported Ollama capabilities: ${capabilities.join(', ')}.`
    : ' No Ollama capabilities were reported for the selected model.';
  const imageInputNote = supportsImageInput
    ? ' The model supports image input/vision, but vision is not image-generation output.'
    : '';

  return `Current model ${model} does not report Ollama image-generation capability "image".${reported}${imageInputNote} Select an Ollama image-generation model or configure a separate image-generation provider.`;
}

async function handleLegacyImageGeneration(
  request: IncomingMessage,
  response: ServerResponse,
  configStore: ConfigStore,
  ollamaClient: OllamaClientLike,
  runtimeConfig: RuntimeConfig,
  logger: Logger
): Promise<void> {
  const body = await readJsonBody(request);
  const prompt = readBodyString(body, 'prompt');

  if (!runtimeConfig.imageGenerationEnabled) {
    sendJson(response, 503, {
      ok: false,
      error: {
        code: 'IMAGE_GENERATION_DISABLED',
        message: 'Image generation is disabled in Local AI Images. Set IMAGE_GENERATION_ENABLED=true to enable image generation with the current model.'
      }
    });
    return;
  }

  const currentModel = await resolveCurrentModel(configStore);
  if (!currentModel) {
    sendJson(response, 503, {
      ok: false,
      error: {
        code: 'IMAGE_MODEL_NOT_SELECTED',
        message: 'Image generation requires a current model. Load or set a default model before generating images.'
      }
    });
    return;
  }

  if (!prompt) {
    sendJson(response, 422, validationDetail(['body', 'prompt'], 'Prompt must be a non-empty string.', 'string_too_short'));
    return;
  }

  if (prompt.length > runtimeConfig.imageGenerationMaxPromptChars) {
    sendJson(response, 422, validationDetail(['body', 'prompt'], `Prompt must be ${runtimeConfig.imageGenerationMaxPromptChars} characters or fewer.`, 'string_too_long'));
    return;
  }

  const requestedModel = readBodyString(body, 'model');
  if (requestedModel && requestedModel !== currentModel) {
    sendJson(response, 400, {
      ok: false,
      error: {
        code: 'IMAGE_MODEL_OVERRIDE_NOT_ALLOWED',
        message: 'Image generation model overrides are not allowed. The current loaded/default model is used for image generation.'
      }
    });
    return;
  }

  const imageGenerationCapability = await resolveImageGenerationCapability(configStore, ollamaClient, runtimeConfig, logger);

  if (imageGenerationCapability.installed === false) {
    sendJson(response, 404, {
      ok: false,
      error: {
        code: 'IMAGE_MODEL_NOT_INSTALLED',
        message: imageGenerationCapability.reason ?? `Current model ${currentModel} is not installed in Ollama.`,
        details: {
          provider: 'ollama',
          model: currentModel,
          requiredCapability: imageGenerationCapability.requiredCapability,
          reportedCapabilities: imageGenerationCapability.modelCapabilities
        }
      }
    });
    return;
  }

  if (imageGenerationCapability.supportsImageGeneration === false) {
    sendJson(response, 422, {
      ok: false,
      error: {
        code: 'IMAGE_GENERATION_UNSUPPORTED_MODEL',
        message: imageGenerationCapability.reason ?? `Current model ${currentModel} does not support image generation through Ollama.`,
        details: {
          provider: 'ollama',
          model: currentModel,
          requiredCapability: imageGenerationCapability.requiredCapability,
          reportedCapabilities: imageGenerationCapability.modelCapabilities,
          supportsImageInput: imageGenerationCapability.supportsImageInput,
          supportsImageGeneration: imageGenerationCapability.supportsImageGeneration,
          endpoint: imageGenerationCapability.endpoint,
          ollamaEndpoint: imageGenerationCapability.ollamaEndpoint
        }
      }
    });
    return;
  }

  if (!imageGenerationCapability.available) {
    sendJson(response, 503, {
      ok: false,
      error: {
        code: 'IMAGE_MODEL_CAPABILITY_UNVERIFIED',
        message: imageGenerationCapability.reason ?? 'Unable to verify that the selected model supports image generation through Ollama.',
        details: {
          provider: 'ollama',
          model: currentModel,
          requiredCapability: imageGenerationCapability.requiredCapability,
          reportedCapabilities: imageGenerationCapability.modelCapabilities
        }
      }
    });
    return;
  }

  const options = readImageOptions(body);
  const abortController = new AbortController();
  const abortImageGeneration = () => {
    if (!response.writableEnded) abortController.abort();
  };
  request.on('aborted', abortImageGeneration);
  response.on('close', abortImageGeneration);

  try {
    const result = await ollamaClient.generateImage({
      model: currentModel,
      prompt,
      timeoutMs: runtimeConfig.imageGenerationTimeoutMs,
      signal: abortController.signal,
      ...options
    });

    sendJson(response, 200, {
      ok: true,
      model: result.model,
      images: result.images,
      metadata: {
        provider: 'ollama',
        endpoint: '/api/generate',
        experimental: true,
        ...result.metadata
      }
    });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error, 502), toErrorPayload(error, 'IMAGE_GENERATION_FAILED'));
  } finally {
    request.off('aborted', abortImageGeneration);
    response.off('close', abortImageGeneration);
  }
}

async function resolveCurrentModel(configStore: ConfigStore): Promise<string | null> {
  const config = await configStore.readConfig();
  const currentModel = config.default_model.trim();
  return currentModel === '' ? null : currentModel;
}

function readImageOptions(body: unknown): OllamaImageGenerateOptions {
  const record = isRecord(body) ? body : {};
  const optionsRecord = isRecord(record.options) ? record.options : {};
  const width = readPositiveInteger(record.width ?? optionsRecord.width, 4096);
  const height = readPositiveInteger(record.height ?? optionsRecord.height, 4096);
  const steps = readPositiveInteger(record.steps ?? optionsRecord.steps, 250);

  return {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(steps !== undefined ? { steps } : {})
  };
}

function readPositiveInteger(value: unknown, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new AppError('IMAGE_OPTION_INVALID', `Image generation option must be a positive integer no larger than ${max}.`, 422);
  }
  return parsed;
}

function readBodyString(body: unknown, key: string): string | null {
  if (!isRecord(body)) return null;
  const value = body[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function modelListIncludes(models: Array<{ name?: string; model?: string }>, model: string): boolean {
  const normalizedModel = model.toLowerCase();
  return models.some((item) => item.name?.toLowerCase() === normalizedModel || item.model?.toLowerCase() === normalizedModel);
}

function validationDetail(loc: Array<string | number>, msg: string, type: string) {
  return {
    detail: [
      {
        loc,
        msg,
        type,
        ctx: {}
      }
    ]
  };
}

async function handleLegacyHealth(response: ServerResponse, configStore: ConfigStore, ollamaClient: OllamaClientLike, runtimeConfig: RuntimeConfig): Promise<void> {
  let config: AppConfig;
  try {
    config = await configStore.readConfig();
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error));
    return;
  }

  try {
    const [runningModels, ollamaVersion] = await Promise.all([
      ollamaClient.listRunningModels(),
      ollamaClient.getVersion().catch(() => null)
    ]);
    const defaultModelLoaded = isDefaultModelLoaded(config.default_model, runningModels);

    sendJson(response, 200, {
      ok: true,
      service: SERVICE_NAME,
      version: APPLICATION_VERSION,
      runtime: RUNTIME_NAME,
      default_model: config.default_model,
      default_model_loaded: defaultModelLoaded,
      running_models: runningModels,
      ollama: {
        ok: true,
        base_url: runtimeConfig.ollamaBaseUrl,
        version: ollamaVersion
      }
    });
  } catch (error: unknown) {
    const payload = toErrorPayload(error);
    sendJson(response, statusCodeForError(error, 503), {
      ok: false,
      service: SERVICE_NAME,
      version: APPLICATION_VERSION,
      runtime: RUNTIME_NAME,
      default_model: config.default_model,
      default_model_loaded: false,
      running_models: [],
      ollama: {
        ok: false,
        base_url: runtimeConfig.ollamaBaseUrl
      },
      error: payload.error
    });
  }
}

async function safeListRunningModels(ollamaClient: OllamaClientLike, logger: Logger) {
  try {
    return await ollamaClient.listRunningModels();
  } catch (error: unknown) {
    logger.warn({ err: error }, 'Model was pre-warmed but running model verification failed');
    return [];
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > 1024 * 1024) {
      throw new Error('Request body is too large');
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

function sendText(response: ServerResponse, statusCode: number, body: string, contentType: string): void {
  response.writeHead(statusCode, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  response.end(body);
}

async function readPublicAsset(fileName: string, logger: Logger): Promise<string> {
  const assetPath = path.resolve(process.cwd(), 'public', fileName);
  try {
    return await fs.readFile(assetPath, 'utf8');
  } catch (error: unknown) {
    logger.error({ err: error, assetPath }, 'Unable to read public asset');
    return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function renderPortalHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${SERVICE_NAME}</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body>
  <header class="site-header">
    <div>
      <p class="eyebrow">Local AI image-generation appliance</p>
      <h1>${SERVICE_NAME}</h1>
      <p class="muted">ComfyUI image API, hosted control panel, async job queue, artifact storage, and NVIDIA GPU telemetry.</p>
    </div>
    <button id="refresh-button" type="button">Refresh</button>
  </header>

  <main>
    <section class="card">
      <div class="section-heading">
        <div>
          <h2>Image API access</h2>
          <p class="hint">The browser stores this key only in local storage and sends it to <code>/api/v1</code> as a bearer token.</p>
        </div>
        <div id="image-auth-status"></div>
      </div>
      <form id="api-key-form" class="auth-row">
        <label>
          Image API key
          <input id="api-key-input" type="password" autocomplete="off" placeholder="Paste IMAGE_API_KEYS value for dashboard API calls">
        </label>
        <button type="submit">Save key</button>
        <button id="clear-key-button" class="secondary" type="button">Clear key</button>
      </form>
      <div id="image-feedback" class="feedback" aria-live="polite"></div>
    </section>

    <section class="grid two">
      <article class="card">
        <h2>Image service health</h2>
        <div id="image-health-content" class="placeholder">Loading image API health...</div>
      </article>
      <article class="card">
        <h2>Image job queue</h2>
        <div id="image-queue-content" class="placeholder">Loading queue stats...</div>
      </article>
    </section>

    <section class="grid three">
      <article class="card">
        <div class="section-heading">
          <h2>Image models</h2>
          <button id="refresh-models-button" class="secondary" type="button">Refresh scan</button>
        </div>
        <div id="image-models" class="placeholder">Loading model inventory...</div>
      </article>
      <article class="card">
        <h2>Workflow presets</h2>
        <div id="image-workflows" class="placeholder">Loading workflow presets...</div>
      </article>
      <article class="card">
        <h2>Recent image jobs</h2>
        <div id="image-jobs" class="placeholder">Loading recent image jobs...</div>
      </article>
    </section>

    <section class="card">
      <div class="section-heading">
        <h2>GPU telemetry</h2>
        <p class="hint">GPU telemetry is read from <code>/api/v1/stats</code>. Compatibility endpoints <code>/gpu</code> and <code>/gpus</code> remain available for existing integrations.</p>
      </div>
      <div id="gpu-list" class="gpu-grid placeholder">Loading GPU telemetry...</div>
    </section>
  </main>

  <footer>
    <span>${SERVICE_NAME} ${APPLICATION_VERSION}</span>
    <a href="/openapi.json">OpenAPI</a>
  </footer>
  <script src="/assets/app.js" type="module"></script>
</body>
</html>`;
}
