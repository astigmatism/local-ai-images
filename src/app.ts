import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { ConfigStore } from './config/store.ts';
import { AppError, toErrorPayload, statusCodeForError } from './errors.ts';
import type { Logger } from './logger.ts';
import { buildOpenApiDocument } from './openapi.ts';
import { toLegacyGpu } from './services/gpuService.ts';
import { createImageRuntime, type ImageRuntime } from './services/image/runtime.ts';
import { findInventoryModel, modelMatchesDefault } from './services/image/modelIdentity.ts';
import type { AppConfig, ArtifactMetadata, FavoriteImagePrompt, ImageFavorite, GpuServiceLike, ImageJob, ModelInventory, ModelInventoryItem, OllamaClientLike, OllamaImageGenerateOptions, OutputDelivery, RuntimeConfig, WorkflowPreset } from './types.ts';
import { validateModelLoadRequest, validateModelName } from './utils/validation.ts';
import { authenticateImageApiRequest } from './utils/auth.ts';
import { generationRequestToApiPayload, normalizeResultDelivery, validateAndNormalizeGenerationRequest } from './utils/imageRequests.ts';
import { summarizeImageJob } from './utils/jobMetrics.ts';
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

const IMAGE_HISTORY_DEFAULT_PAGE_SIZE = 9;
const IMAGE_HISTORY_MAX_PAGE_SIZE = 250;

export function createRequestHandler(dependencies: AppDependencies): RequestHandler {
  const resolvedDependencies: ResolvedAppDependencies = {
    ...dependencies,
    imageRuntime: dependencies.imageRuntime ?? createImageRuntime(dependencies.runtimeConfig, dependencies.logger, dependencies.configStore)
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

  if (method === 'GET' && pathName === '/image-generator') {
    sendText(response, 200, renderImageGeneratorHtml(), 'text/html; charset=utf-8');
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

  if (method === 'GET' && pathName === '/assets/image-generator.js') {
    sendText(response, 200, await readPublicAsset('image-generator.js', logger), 'application/javascript; charset=utf-8');
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

  if (method === 'POST' && pathName === '/api/v1/models/default') {
    await handleImageApiSetDefaultModel(request, response, dependencies);
    return;
  }

  if (method === 'DELETE' && pathName === '/api/v1/models/default') {
    await handleImageApiClearDefaultModel(response, dependencies);
    return;
  }

  if (method === 'GET' && pathName === '/api/v1/models/preload') {
    await handleImageApiPreloadStatus(response, dependencies);
    return;
  }

  if (method === 'POST' && pathName === '/api/v1/models/preload') {
    await handleImageApiPreloadModel(request, response, dependencies);
    return;
  }

  if (method === 'POST' && pathName === '/api/v1/models/preload/startup') {
    await handleImageApiPreloadStartup(request, response, dependencies);
    return;
  }

  const modelDeleteMatch = /^\/api\/v1\/models\/([^/]+)$/u.exec(pathName);
  if (method === 'DELETE' && modelDeleteMatch?.[1]) {
    await handleImageApiDeleteModel(request, response, dependencies, decodeURIComponent(modelDeleteMatch[1]));
    return;
  }

  if (method === 'GET' && pathName === '/api/v1/model-catalog') {
    await handleImageApiModelCatalog(response, dependencies);
    return;
  }

  if (method === 'GET' && pathName === '/api/v1/model-downloads') {
    await handleImageApiModelDownloads(response, dependencies, url);
    return;
  }

  if (method === 'POST' && pathName === '/api/v1/model-downloads') {
    await handleImageApiStartModelDownload(request, response, dependencies);
    return;
  }

  const modelDownloadMatch = /^\/api\/v1\/model-downloads\/([^/]+)(?:\/(cancel))?$/u.exec(pathName);
  if (modelDownloadMatch?.[1]) {
    const downloadId = decodeURIComponent(modelDownloadMatch[1]);
    const suffix = modelDownloadMatch[2];
    if (method === 'GET' && suffix === undefined) {
      handleImageApiModelDownload(response, dependencies, downloadId);
      return;
    }
    if (method === 'POST' && suffix === 'cancel') {
      await handleImageApiCancelModelDownload(response, dependencies, downloadId);
      return;
    }
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


  if (method === 'GET' && pathName === '/api/v1/favorite-prompts') {
    await handleImageApiFavoritePrompts(response, dependencies, url);
    return;
  }

  if (method === 'POST' && pathName === '/api/v1/favorite-prompts') {
    await handleImageApiCreateFavoritePrompt(request, response, dependencies);
    return;
  }

  const favoritePromptMatch = /^\/api\/v1\/favorite-prompts\/([^/]+)$/u.exec(pathName);
  if (favoritePromptMatch?.[1]) {
    const favoriteId = decodeURIComponent(favoritePromptMatch[1]);
    if (method === 'GET') {
      await handleImageApiFavoritePrompt(response, dependencies, favoriteId);
      return;
    }
    if (method === 'PATCH') {
      await handleImageApiUpdateFavoritePrompt(request, response, dependencies, favoriteId);
      return;
    }
    if (method === 'DELETE') {
      await handleImageApiDeleteFavoritePrompt(response, dependencies, favoriteId);
      return;
    }
  }


  if (method === 'GET' && pathName === '/api/v1/image-favorites') {
    await handleImageApiImageFavorites(response, dependencies, url);
    return;
  }

  if (method === 'POST' && pathName === '/api/v1/image-favorites') {
    await handleImageApiCreateImageFavorite(request, response, dependencies);
    return;
  }

  const imageFavoriteMatch = /^\/api\/v1\/image-favorites\/([^/]+)$/u.exec(pathName);
  if (imageFavoriteMatch?.[1]) {
    const favoriteId = decodeURIComponent(imageFavoriteMatch[1]);
    if (method === 'GET') {
      await handleImageApiImageFavorite(response, dependencies, favoriteId);
      return;
    }
    if (method === 'PATCH') {
      await handleImageApiUpdateImageFavorite(request, response, dependencies, favoriteId);
      return;
    }
    if (method === 'DELETE') {
      await handleImageApiDeleteImageFavorite(response, dependencies, favoriteId);
      return;
    }
  }

  if (method === 'POST' && pathName === '/api/v1/generate') {
    await handleImageApiGenerate(request, response, dependencies);
    return;
  }

  if (method === 'GET' && pathName === '/api/v1/jobs') {
    await handleImageApiJobs(response, dependencies, url);
    return;
  }

  const jobMatch = /^\/api\/v1\/jobs\/([^/]+)(?:\/(result|cancel|replay))?$/u.exec(pathName);
  if (jobMatch?.[1]) {
    const jobId = decodeURIComponent(jobMatch[1]);
    const suffix = jobMatch[2];
    if (method === 'GET' && suffix === undefined) {
      await handleImageApiJob(response, dependencies, jobId);
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
    if (method === 'POST' && suffix === 'replay') {
      await handleImageApiJobReplay(response, dependencies, jobId);
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
  const [engine, workflows, gpus, appConfig, preload] = await Promise.all([
    imageRuntime.provider.health(),
    imageRuntime.workflowStore.list().catch(() => []),
    queryGpuSummary(gpuService),
    dependencies.configStore.readConfig().catch(() => ({ default_model: '' })),
    imageRuntime.modelLifecycle.getStatus().catch(() => null)
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
      cached_count: imageRuntime.modelScanner.getCachedInventory()?.models.length ?? null,
      default_model: appConfig.image_default_model || null,
      preload_on_startup: appConfig.image_preload_default_on_startup === true,
      preload,
      installs_enabled: runtimeConfig.modelInstallsEnabled,
      install_destinations: runtimeConfig.modelInstallDirectories
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
      favorite_prompts: '/api/v1/favorite-prompts',
      image_favorites: '/api/v1/image-favorites',
      artifacts: '/api/v1/artifacts/{artifactId}',
      model_catalog: '/api/v1/model-catalog',
      model_downloads: '/api/v1/model-downloads',
      model_default: '/api/v1/models/default',
      model_preload: '/api/v1/models/preload',
      model_preload_startup: '/api/v1/models/preload/startup',
      model_delete: '/api/v1/models/{modelId}'
    },
    generation: {
      async_jobs: true,
      sync_timeout: true,
      output_delivery: ['metadata', 'url', 'base64', 'binary'],
      max_prompt_chars: runtimeConfig.imageGenerationMaxPromptChars,
      parameters: ['prompt', 'negative_prompt', 'model', 'workflow_id', 'width', 'height', 'steps', 'cfg_scale', 'seed', 'sampler_name', 'scheduler'],
      default_model_source: 'config.image_default_model, when set and compatible with the selected workflow'
    },
    model_installs: {
      enabled: runtimeConfig.modelInstallsEnabled,
      max_bytes: runtimeConfig.modelInstallMaxBytes,
      allow_ckpt: runtimeConfig.modelInstallAllowCkpt,
      destinations: runtimeConfig.modelInstallDirectories
    },
    model_lifecycle: {
      default_endpoint: '/api/v1/models/default',
      preload_endpoint: '/api/v1/models/preload',
      preload_startup_endpoint: '/api/v1/models/preload/startup',
      safe_delete_endpoint: 'DELETE /api/v1/models/{modelId}',
      loaded_state_label: 'last confirmed loaded/prewarmed model'
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
    sendJson(response, 200, await decorateModelInventory(inventory, dependencies));
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error, 'MODEL_SCAN_FAILED'));
  }
}

async function handleImageApiSetDefaultModel(request: IncomingMessage, response: ServerResponse, dependencies: ResolvedAppDependencies): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const requestedModel = isRecord(body) ? readBodyString(body, 'model') || readBodyString(body, 'file_name') || readBodyString(body, 'fileName') : '';
    if (!requestedModel) {
      sendJson(response, 422, validationDetail(['body', 'model'], 'model must be a non-empty installed checkpoint model identifier or filename', 'string_too_short'));
      return;
    }

    const inventory = await dependencies.imageRuntime.modelScanner.list();
    const model = findInventoryModel(inventory.models, requestedModel);
    if (!model) {
      sendJson(response, 404, { ok: false, error: { code: 'MODEL_NOT_FOUND', message: `Installed model ${requestedModel} was not found in the scanned model inventory.` } });
      return;
    }
    if (model.type !== 'checkpoint') {
      sendJson(response, 422, { ok: false, error: { code: 'MODEL_DEFAULT_REQUIRES_CHECKPOINT', message: 'Only installed checkpoint models can be set as the default image model.' } });
      return;
    }

    const config = await dependencies.configStore.updateImageDefaultModel(model.comfyName || model.fileName);
    const preloadOnStartup = readBodyBoolean(body, 'preload_on_startup') || readBodyBoolean(body, 'preloadOnStartup');
    const updatedConfig = preloadOnStartup
      ? await dependencies.imageRuntime.modelLifecycle.setPreloadOnStartup(true)
      : config;
    const refreshed = await decorateModelInventory(await dependencies.imageRuntime.modelScanner.list(), dependencies);
    sendJson(response, 200, {
      ok: true,
      config: updatedConfig,
      path: dependencies.configStore.path,
      default_model: updatedConfig.image_default_model ?? '',
      preload_on_startup: updatedConfig.image_preload_default_on_startup === true,
      model: decorateSingleModel(model, updatedConfig.image_default_model ?? '', await defaultWorkflowFor(dependencies), await dependencies.imageRuntime.modelLifecycle.getStatus().catch(() => null), dependencies),
      inventory: refreshed
    });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error, 'MODEL_DEFAULT_UPDATE_FAILED'));
  }
}

async function handleImageApiPreloadStatus(response: ServerResponse, dependencies: ResolvedAppDependencies): Promise<void> {
  try {
    sendJson(response, 200, await dependencies.imageRuntime.modelLifecycle.getStatus());
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error, 'MODEL_PRELOAD_STATUS_FAILED'));
  }
}

async function handleImageApiPreloadModel(request: IncomingMessage, response: ServerResponse, dependencies: ResolvedAppDependencies): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const model = isRecord(body)
      ? readBodyString(body, 'model') || readBodyString(body, 'file_name') || readBodyString(body, 'fileName')
      : '';
    const setDefault = isRecord(body) && (readBodyBoolean(body, 'set_default') || readBodyBoolean(body, 'setDefault') || readBodyBoolean(body, 'make_default') || readBodyBoolean(body, 'makeDefault'));
    const preload = await dependencies.imageRuntime.modelLifecycle.preloadCheckpoint({
      model: model || null,
      source: 'api',
      setDefault
    });
    const inventory = await decorateModelInventory(await dependencies.imageRuntime.modelScanner.list(), dependencies);
    sendJson(response, 200, { ok: true, preload, inventory });
  } catch (error: unknown) {
    const preload = await dependencies.imageRuntime.modelLifecycle.getStatus().catch(() => null);
    sendJson(response, statusCodeForError(error, 502), {
      ...toErrorPayload(error, 'MODEL_PRELOAD_FAILED'),
      ...(preload ? { preload } : {})
    });
  }
}

async function handleImageApiPreloadStartup(request: IncomingMessage, response: ServerResponse, dependencies: ResolvedAppDependencies): Promise<void> {
  try {
    const body = await readJsonBody(request);
    if (!isRecord(body) || !hasBooleanish(body, 'enabled')) {
      sendJson(response, 422, validationDetail(['body', 'enabled'], 'enabled must be true or false', 'bool_type'));
      return;
    }
    const enabled = readBodyBoolean(body, 'enabled');
    const config = await dependencies.imageRuntime.modelLifecycle.setPreloadOnStartup(enabled);
    const preload = await dependencies.imageRuntime.modelLifecycle.getStatus(undefined, config);
    const inventory = await decorateModelInventory(await dependencies.imageRuntime.modelScanner.list(), dependencies);
    sendJson(response, 200, {
      ok: true,
      config,
      path: dependencies.configStore.path,
      preload,
      inventory
    });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error, 'MODEL_PRELOAD_STARTUP_UPDATE_FAILED'));
  }
}

async function handleImageApiDeleteModel(request: IncomingMessage, response: ServerResponse, dependencies: ResolvedAppDependencies, modelIdentifier: string): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const result = await dependencies.imageRuntime.modelLifecycle.deleteInstalledModel(modelIdentifier, body);
    const inventory = await decorateModelInventory(result.inventory, dependencies);
    sendJson(response, 200, { ...result, inventory });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error, 'MODEL_DELETE_FAILED'));
  }
}

async function handleImageApiClearDefaultModel(response: ServerResponse, dependencies: ResolvedAppDependencies): Promise<void> {
  try {
    const config = await dependencies.configStore.clearImageDefaultModel();
    const inventory = await decorateModelInventory(await dependencies.imageRuntime.modelScanner.list(), dependencies);
    sendJson(response, 200, {
      ok: true,
      config,
      path: dependencies.configStore.path,
      default_model: config.image_default_model ?? '',
      preload: await dependencies.imageRuntime.modelLifecycle.getStatus(undefined, config).catch(() => null),
      inventory
    });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error, 'MODEL_DEFAULT_CLEAR_FAILED'));
  }
}

async function handleImageApiModelCatalog(response: ServerResponse, dependencies: ResolvedAppDependencies): Promise<void> {
  try {
    const catalog = await dependencies.imageRuntime.modelCatalog.load();
    sendJson(response, 200, catalog);
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error, 'MODEL_CATALOG_LOAD_FAILED'));
  }
}

async function handleImageApiModelDownloads(response: ServerResponse, dependencies: ResolvedAppDependencies, url: URL): Promise<void> {
  try {
    const installer = ensureModelInstaller(dependencies);
    const limit = readQueryInteger(url, 'limit', 50, 1, 250);
    sendJson(response, 200, {
      ok: true,
      enabled: dependencies.runtimeConfig.modelInstallsEnabled,
      max_bytes: dependencies.runtimeConfig.modelInstallMaxBytes,
      allow_ckpt: dependencies.runtimeConfig.modelInstallAllowCkpt,
      destinations: dependencies.runtimeConfig.modelInstallDirectories,
      jobs: await installer.list(limit)
    });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error));
  }
}

function handleImageApiModelDownload(response: ServerResponse, dependencies: ResolvedAppDependencies, downloadId: string): void {
  try {
    const installer = ensureModelInstaller(dependencies);
    sendJson(response, 200, { ok: true, job: installer.get(downloadId) });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error));
  }
}

async function handleImageApiStartModelDownload(request: IncomingMessage, response: ServerResponse, dependencies: ResolvedAppDependencies): Promise<void> {
  try {
    const installer = ensureModelInstaller(dependencies);
    const body = await readJsonBody(request);
    const job = await installer.start(body);
    sendJson(response, 202, {
      ok: true,
      job,
      status_url: `/api/v1/model-downloads/${encodeURIComponent(job.id)}`,
      cancel_url: `/api/v1/model-downloads/${encodeURIComponent(job.id)}/cancel`
    });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error, 'MODEL_DOWNLOAD_START_FAILED'));
  }
}

async function handleImageApiCancelModelDownload(response: ServerResponse, dependencies: ResolvedAppDependencies, downloadId: string): Promise<void> {
  try {
    const installer = ensureModelInstaller(dependencies);
    const job = await installer.cancel(downloadId);
    sendJson(response, 200, { ok: true, job });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error));
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

async function handleImageApiFavoritePrompts(response: ServerResponse, dependencies: ResolvedAppDependencies, url: URL): Promise<void> {
  try {
    const limit = readQueryInteger(url, 'limit', 100, 1, 250);
    const favorites = await dependencies.imageRuntime.favoritePromptStore.list(limit);
    sendJson(response, 200, {
      ok: true,
      path: dependencies.imageRuntime.favoritePromptStore.path,
      favorites: favorites.map(publicFavoritePromptSummary)
    });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error, 'FAVORITE_PROMPTS_LIST_FAILED'));
  }
}

async function handleImageApiFavoritePrompt(response: ServerResponse, dependencies: ResolvedAppDependencies, favoriteId: string): Promise<void> {
  try {
    const favorite = await dependencies.imageRuntime.favoritePromptStore.get(favoriteId);
    sendJson(response, 200, { ok: true, favorite: publicFavoritePrompt(favorite) });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error));
  }
}

async function handleImageApiCreateFavoritePrompt(request: IncomingMessage, response: ServerResponse, dependencies: ResolvedAppDependencies): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const favorite = await dependencies.imageRuntime.favoritePromptStore.create(body);
    sendJson(response, 201, { ok: true, favorite: publicFavoritePrompt(favorite) });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error, 'FAVORITE_PROMPT_CREATE_FAILED'));
  }
}

async function handleImageApiUpdateFavoritePrompt(request: IncomingMessage, response: ServerResponse, dependencies: ResolvedAppDependencies, favoriteId: string): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const favorite = await dependencies.imageRuntime.favoritePromptStore.update(favoriteId, body);
    sendJson(response, 200, { ok: true, favorite: publicFavoritePrompt(favorite) });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error));
  }
}

async function handleImageApiDeleteFavoritePrompt(response: ServerResponse, dependencies: ResolvedAppDependencies, favoriteId: string): Promise<void> {
  try {
    const favorite = await dependencies.imageRuntime.favoritePromptStore.delete(favoriteId);
    sendJson(response, 200, {
      ok: true,
      deleted_id: favoriteId,
      favorite: publicFavoritePromptSummary(favorite)
    });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error));
  }
}

async function handleImageApiImageFavorites(response: ServerResponse, dependencies: ResolvedAppDependencies, url: URL): Promise<void> {
  try {
    const limit = readQueryInteger(url, 'limit', 100, 1, 250);
    const favorites = await dependencies.imageRuntime.imageFavoriteStore.list(limit);
    sendJson(response, 200, {
      ok: true,
      path: dependencies.imageRuntime.imageFavoriteStore.path,
      favorites: favorites.map(publicImageFavoriteSummary)
    });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error, 'IMAGE_FAVORITES_LIST_FAILED'));
  }
}

async function handleImageApiImageFavorite(response: ServerResponse, dependencies: ResolvedAppDependencies, favoriteId: string): Promise<void> {
  try {
    const favorite = await dependencies.imageRuntime.imageFavoriteStore.get(favoriteId);
    sendJson(response, 200, { ok: true, favorite: publicImageFavorite(favorite) });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error));
  }
}

async function handleImageApiCreateImageFavorite(request: IncomingMessage, response: ServerResponse, dependencies: ResolvedAppDependencies): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const favorite = await dependencies.imageRuntime.imageFavoriteStore.create(body);
    sendJson(response, 201, { ok: true, favorite: publicImageFavorite(favorite) });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error, 'IMAGE_FAVORITE_CREATE_FAILED'));
  }
}

async function handleImageApiUpdateImageFavorite(request: IncomingMessage, response: ServerResponse, dependencies: ResolvedAppDependencies, favoriteId: string): Promise<void> {
  try {
    const body = await readJsonBody(request);
    const favorite = await dependencies.imageRuntime.imageFavoriteStore.update(favoriteId, body);
    sendJson(response, 200, { ok: true, favorite: publicImageFavorite(favorite) });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error));
  }
}

async function handleImageApiDeleteImageFavorite(response: ServerResponse, dependencies: ResolvedAppDependencies, favoriteId: string): Promise<void> {
  try {
    const favorite = await dependencies.imageRuntime.imageFavoriteStore.delete(favoriteId);
    sendJson(response, 200, {
      ok: true,
      deleted_id: favoriteId,
      favorite: publicImageFavoriteSummary(favorite)
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
  const config = await dependencies.configStore.readConfig();
  const parsed = validateAndNormalizeGenerationRequest(body, runtimeConfig, workflows, {
    defaultImageModel: config.image_default_model || null
  });
  if (!parsed.ok) {
    sendJson(response, 422, parsed.response);
    return;
  }

  try {
    const requestPayload = generationRequestToApiPayload(parsed.value, isRecord(body) ? body : {});
    const clientId = readClientJobIdHeader(request);
    const job = imageRuntime.jobQueue.submit(parsed.value, parsed.workflow, requestPayload, { clientId });
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

async function handleImageApiJobs(response: ServerResponse, dependencies: ResolvedAppDependencies, url: URL): Promise<void> {
  const pageSize = readImageHistoryPageSize(url);
  const offset = readOptionalQueryInteger(url, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const requestedPage = offset === null
    ? readQueryInteger(url, 'page', 1, 1, Number.MAX_SAFE_INTEGER)
    : Math.floor(offset / pageSize) + 1;
  const historyJobs = await listImageHistoryJobs(dependencies);
  const totalItems = historyJobs.length;
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize);
  const page = totalPages > 0 ? Math.min(requestedPage, totalPages) : 1;
  const pageOffset = (page - 1) * pageSize;
  const jobs = historyJobs.slice(pageOffset, pageOffset + pageSize);

  sendJson(response, 200, {
    ok: true,
    queue: dependencies.imageRuntime.jobQueue.stats(),
    jobs,
    items: jobs,
    page,
    pageSize,
    offset: pageOffset,
    totalItems,
    totalPages,
    hasNextPage: totalPages > page,
    hasPreviousPage: page > 1
  });
}

async function listImageHistoryJobs(dependencies: ResolvedAppDependencies): Promise<unknown[]> {
  const memoryJobs = dependencies.imageRuntime.jobQueue.listAllJobs();
  const durableJobs = await dependencies.imageRuntime.artifactStore.listCompletedJobs().catch(() => []);
  const seen = new Set(memoryJobs.map((job) => job.id));
  return [
    ...memoryJobs,
    ...durableJobs.filter((job) => {
      const id = imageHistoryJobId(job);
      return id !== null && !seen.has(id);
    })
  ].sort(compareImageHistoryJobsNewestFirst);
}

function compareImageHistoryJobsNewestFirst(left: unknown, right: unknown): number {
  const leftTimestamp = imageHistoryTimestamp(left);
  const rightTimestamp = imageHistoryTimestamp(right);
  if (leftTimestamp !== rightTimestamp) return rightTimestamp - leftTimestamp;
  return (imageHistoryJobId(left) ?? '').localeCompare(imageHistoryJobId(right) ?? '');
}

function imageHistoryTimestamp(job: unknown): number {
  if (!isRecord(job)) return 0;
  for (const field of ['completedAt', 'canceledAt', 'submittedAt', 'createdAt', 'startedAt', 'updatedAt', 'queuedAt', 'cancelRequestedAt']) {
    const value = job[field];
    const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function imageHistoryJobId(job: unknown): string | null {
  return isRecord(job) && typeof job.id === 'string' ? job.id : null;
}

function readImageHistoryPageSize(url: URL): number {
  const explicitPageSize = readOptionalQueryInteger(url, 'pageSize', 1, IMAGE_HISTORY_MAX_PAGE_SIZE)
    ?? readOptionalQueryInteger(url, 'page_size', 1, IMAGE_HISTORY_MAX_PAGE_SIZE)
    ?? readOptionalQueryInteger(url, 'limit', 1, IMAGE_HISTORY_MAX_PAGE_SIZE);
  return explicitPageSize ?? IMAGE_HISTORY_DEFAULT_PAGE_SIZE;
}


function readClientJobIdHeader(request: IncomingMessage): string | null {
  const value = request.headers['x-client-job-id'];
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 200) return null;
  return /^[a-zA-Z0-9._:-]+$/u.test(trimmed) ? trimmed : null;
}

async function handleImageApiJob(response: ServerResponse, dependencies: ResolvedAppDependencies, jobId: string): Promise<void> {
  try {
    const job = dependencies.imageRuntime.jobQueue.getJob(jobId);
    sendJson(response, 200, { ok: true, job: publicJob(job) });
  } catch (error: unknown) {
    const durableJob = await dependencies.imageRuntime.artifactStore.getRecentCompletedJob(jobId).catch(() => null);
    if (durableJob) {
      sendJson(response, 200, { ok: true, job: durableJob });
      return;
    }
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
    if (error instanceof AppError && error.code === 'JOB_NOT_FOUND') {
      const durableJob = await dependencies.imageRuntime.artifactStore.getRecentCompletedJob(jobId).catch(() => null);
      if (durableJob) {
        sendJson(response, 409, {
          ok: false,
          job: durableJob,
          error: {
            code: 'IMAGE_JOB_ALREADY_COMPLETED',
            message: `Job ${jobId} has already completed and cannot be canceled.`
          }
        });
        return;
      }
    }
    if (error instanceof AppError && (error.code === 'IMAGE_JOB_CANCEL_FAILED' || error.code === 'IMAGE_JOB_CANCEL_UNSUPPORTED')) {
      const currentJob = (() => {
        try {
          return dependencies.imageRuntime.jobQueue.getJob(jobId);
        } catch {
          return null;
        }
      })();
      sendJson(response, statusCodeForError(error), {
        ...toErrorPayload(error),
        ...(currentJob ? { job: publicJob(currentJob) } : {})
      });
      return;
    }
    sendJson(response, statusCodeForError(error), toErrorPayload(error));
  }
}
async function handleImageApiJobReplay(response: ServerResponse, dependencies: ResolvedAppDependencies, jobId: string): Promise<void> {
  try {
    const originalJob = dependencies.imageRuntime.jobQueue.getJob(jobId);
    const workflow = await dependencies.imageRuntime.workflowStore.get(originalJob.workflowId);
    const replayJob = dependencies.imageRuntime.jobQueue.submit(originalJob.request, workflow, originalJob.requestPayload);
    sendJson(response, 202, {
      ok: true,
      replayed_from: jobId,
      job: publicJob(replayJob),
      result_url: `/api/v1/jobs/${encodeURIComponent(replayJob.id)}/result`,
      status_url: `/api/v1/jobs/${encodeURIComponent(replayJob.id)}`
    });
  } catch (error: unknown) {
    sendJson(response, statusCodeForError(error), toErrorPayload(error, 'IMAGE_JOB_REPLAY_FAILED'));
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

function publicFavoritePromptSummary(favorite: FavoriteImagePrompt) {
  return {
    id: favorite.id,
    title: favorite.title,
    ...(favorite.description !== undefined ? { description: favorite.description } : {}),
    prompt: favorite.prompt,
    negativePrompt: favorite.negativePrompt ?? null,
    promptPreview: favorite.promptPreview,
    negativePromptPreview: favorite.negativePromptPreview ?? null,
    model: favorite.model ?? null,
    workflow: favorite.workflow ?? null,
    workflowId: favorite.workflowId ?? favorite.workflow ?? null,
    sampler: favorite.sampler ?? null,
    scheduler: favorite.scheduler ?? null,
    width: favorite.width ?? null,
    height: favorite.height ?? null,
    steps: favorite.steps ?? null,
    cfgScale: favorite.cfgScale ?? null,
    seed: favorite.seed ?? null,
    createdAt: favorite.createdAt,
    updatedAt: favorite.updatedAt
  };
}

function publicFavoritePrompt(favorite: FavoriteImagePrompt) {
  return {
    ...publicFavoritePromptSummary(favorite),
    requestPayload: favorite.requestPayload
  };
}

function publicImageFavoriteStringField(value: unknown, keys: string[]): string | null {
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const field = value[key];
    if (typeof field === 'string' && field.trim() !== '') return field;
  }
  return null;
}

function publicImageFavoriteArtifactUrlFromId(id: string | null | undefined): string | null {
  return id && id.trim() !== '' ? `/api/v1/artifacts/${encodeURIComponent(id)}` : null;
}

function publicImageFavoriteThumbnailUrl(favorite: ImageFavorite): string | null {
  const directUrl = typeof favorite.imageUrl === 'string' && favorite.imageUrl.trim() !== '' ? favorite.imageUrl : null;
  if (directUrl) return directUrl;

  const artifactUrl = publicImageFavoriteStringField(favorite.artifact, ['url', 'imageUrl', 'image_url', 'href']);
  if (artifactUrl) return artifactUrl;

  const artifactId = favorite.artifactId ?? publicImageFavoriteStringField(favorite.artifact, ['id']);
  const artifactIdUrl = publicImageFavoriteArtifactUrlFromId(artifactId);
  if (artifactIdUrl) return artifactIdUrl;

  const jobUrl = publicImageFavoriteStringField(favorite.job, ['thumbnailUrl', 'thumbnail_url', 'imageUrl', 'image_url']);
  if (jobUrl) return jobUrl;

  const jobArtifacts = isRecord(favorite.job) && Array.isArray(favorite.job.artifacts) ? favorite.job.artifacts : [];
  for (const artifact of jobArtifacts) {
    const url = publicImageFavoriteStringField(artifact, ['url', 'imageUrl', 'image_url', 'href']);
    if (url) return url;
    const id = publicImageFavoriteStringField(artifact, ['id']);
    const urlFromId = publicImageFavoriteArtifactUrlFromId(id);
    if (urlFromId) return urlFromId;
  }

  return null;
}

function publicImageFavoriteSummary(favorite: ImageFavorite) {
  return {
    id: favorite.id,
    title: favorite.title,
    ...(favorite.description !== undefined ? { description: favorite.description } : {}),
    prompt: favorite.prompt,
    negativePrompt: favorite.negativePrompt ?? null,
    promptPreview: favorite.promptPreview,
    negativePromptPreview: favorite.negativePromptPreview ?? null,
    model: favorite.model ?? null,
    workflow: favorite.workflow ?? null,
    workflowId: favorite.workflowId ?? favorite.workflow ?? null,
    sampler: favorite.sampler ?? null,
    scheduler: favorite.scheduler ?? null,
    width: favorite.width ?? null,
    height: favorite.height ?? null,
    steps: favorite.steps ?? null,
    cfgScale: favorite.cfgScale ?? null,
    seed: favorite.seed ?? null,
    imageUrl: favorite.imageUrl ?? null,
    thumbnailUrl: publicImageFavoriteThumbnailUrl(favorite),
    artifactId: favorite.artifactId ?? null,
    jobId: favorite.jobId ?? null,
    artifact: favorite.artifact ?? null,
    createdAt: favorite.createdAt,
    updatedAt: favorite.updatedAt
  };
}

function publicImageFavorite(favorite: ImageFavorite) {
  return {
    ...publicImageFavoriteSummary(favorite),
    requestPayload: favorite.requestPayload,
    job: favorite.job ?? null
  };
}

function publicJob(job: ImageJob) {
  const summary = summarizeImageJob(job);
  return {
    ...summary,
    artifacts: job.artifacts.map(publicArtifact),
    queueWaitMs: summary.timings.queueWaitMs,
    executionMs: summary.timings.executionMs,
    totalMs: summary.timings.totalMs,
    secondsPerStep: summary.timings.secondsPerStep,
    stepsPerSecond: summary.timings.stepsPerSecond
  };
}

function publicArtifact(artifact: ArtifactMetadata) {
  const { filePath: _filePath, ...publicMetadata } = artifact;
  return publicMetadata;
}

async function decorateModelInventory(inventory: ModelInventory, dependencies: ResolvedAppDependencies): Promise<ModelInventory> {
  const [config, workflow] = await Promise.all([
    dependencies.configStore.readConfig().catch(() => ({ default_model: '' })),
    defaultWorkflowFor(dependencies)
  ]);
  const defaultModel = config.image_default_model || '';
  const preload = await dependencies.imageRuntime.modelLifecycle.getStatus(inventory, config).catch(() => null);
  return {
    ...inventory,
    defaultModel: defaultModel || null,
    default_model: defaultModel || null,
    defaultWorkflowId: workflow?.id ?? dependencies.runtimeConfig.imageDefaultWorkflowId,
    defaultStatus: preload,
    preload,
    models: inventory.models.map((model) => decorateSingleModel(model, defaultModel, workflow, preload, dependencies))
  };
}

function decorateSingleModel(
  model: ModelInventoryItem,
  defaultModel: string,
  workflow: WorkflowPreset | null,
  preload: Record<string, any> | null,
  dependencies: ResolvedAppDependencies
): ModelInventoryItem & Record<string, unknown> {
  const isDefault = modelMatchesDefault(model, defaultModel);
  const usableByDefaultWorkflow = workflow ? modelUsableByWorkflow(model, workflow) : model.type === 'checkpoint';
  const isLastConfirmedLoaded = preload?.lastConfirmedLoadedModel
    ? modelMatchesDefault(model, preload.lastConfirmedLoadedModel)
    : false;
  const canSetDefault = model.type === 'checkpoint';
  const canPreload = canSetDefault;
  const canDelete = dependencies.imageRuntime.modelLifecycle.canDeleteModel(model);
  const loadedStatus = model.type !== 'checkpoint'
    ? 'not_applicable'
    : isLastConfirmedLoaded
      ? 'last_confirmed_loaded'
      : isDefault
        ? 'default_not_confirmed_loaded'
        : 'not_confirmed_loaded';
  return {
    ...model,
    isDefault,
    isLastConfirmedLoaded,
    canSetDefault,
    canPreload,
    canDelete,
    deleteRequiresDefaultClear: isDefault,
    defaultWarning: isDefault ? preload?.defaultWarning ?? null : null,
    preloadWarning: canPreload && !usableByDefaultWorkflow
      ? 'The configured preload workflow does not advertise a checkpoint-loader mapping. The Load / Prewarm action is still available, but the backend may report a workflow configuration error until IMAGE_PRELOAD_WORKFLOW_ID or the workflow mapping is fixed.'
      : null,
    loadedStatus,
    usableByDefaultWorkflow,
    deletePreview: dependencies.imageRuntime.modelLifecycle.deletePreview(model, isDefault)
  };
}

async function defaultWorkflowFor(dependencies: ResolvedAppDependencies): Promise<WorkflowPreset | null> {
  try {
    return await dependencies.imageRuntime.workflowStore.get(dependencies.runtimeConfig.imageDefaultWorkflowId);
  } catch {
    const workflows = await dependencies.imageRuntime.workflowStore.list().catch(() => []);
    return workflows[0] ?? null;
  }
}

function modelUsableByWorkflow(model: ModelInventoryItem, workflow: WorkflowPreset): boolean {
  if (model.type !== 'checkpoint') return false;
  return Boolean(workflow.comfyui.mappings.checkpointNode);
}

function ensureModelInstaller(dependencies: ResolvedAppDependencies) {
  if (!dependencies.imageRuntime.modelInstaller) {
    throw new AppError('MODEL_INSTALLER_UNAVAILABLE', 'Model installer is unavailable for this runtime.', 500);
  }
  return dependencies.imageRuntime.modelInstaller;
}

function readQueryInteger(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function readOptionalQueryInteger(url: URL, name: string, min: number, max: number): number | null {
  const raw = url.searchParams.get(name);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
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

function readBodyBoolean(body: unknown, key: string): boolean {
  if (!isRecord(body)) return false;
  const value = body[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  return false;
}

function hasBooleanish(body: unknown, key: string): boolean {
  if (!isRecord(body)) return false;
  const value = body[key];
  if (typeof value === 'boolean') return true;
  return typeof value === 'string' && ['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off'].includes(value.trim().toLowerCase());
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

function renderImageGeneratorHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Image Generator - ${SERVICE_NAME}</title>
  <link rel="stylesheet" href="/assets/app.css">
</head>
<body class="image-generator-body">
  <main class="image-lab-shell">
    <section class="card image-lab-controls" aria-label="Image-generation controls">
      <form id="image-lab-form" class="image-lab-form">
        <div class="image-lab-top-row">
          <!--
          <label class="image-lab-model-field">
            <span class="field-label">Workflow <span class="field-help" tabindex="0" title="Choose the ComfyUI workflow preset for the next request. Some workflows use checkpoint models; others load their own diffusion model, text encoder, and VAE.">?</span></span>
            <select id="image-lab-workflow" required></select>
          </label>
          -->

          <label class="image-lab-model-field">
            <span class="field-label">Checkpoint <span class="field-help" tabindex="0" title="Choose an installed checkpoint for workflows that use checkpoint models. Workflows like Juggernaut Z load their own diffusion model and ignore this field.">?</span></span>
            <select id="image-lab-model"></select>
          </label>
          
          <div class="image-lab-top-actions">
            <div id="image-lab-status" class="feedback" aria-live="polite"></div>
            <a class="button-link secondary" href="/">Status portal</a>
            <button id="image-lab-refresh" class="secondary" type="button">Refresh</button>
          </div>
        </div>

        <div class="image-lab-main-grid">
          <section class="image-lab-prompt-stack" aria-label="Prompt controls">
            <label class="image-lab-prompt-column image-lab-positive-prompt">
              <span class="field-label">Positive prompt <span class="field-help" tabindex="0" title="Describe what the model should create. Add subject, style, composition, lighting, and details when the image does not follow the prompt or lacks detail.">?</span></span>
              <textarea id="image-lab-prompt" rows="4" required placeholder="What should the model create?"></textarea>
            </label>

            <details id="image-lab-negative-drawer" class="image-lab-negative-drawer compact-details">
              <summary><span class="field-label">Negative prompt <span class="field-help" tabindex="0" title="Describe what to avoid or de-emphasize, such as artifacts, unwanted text, watermarks, bad anatomy, or styles you do not want.">?</span></span></summary>
              <label class="image-lab-negative-field">
                <span class="visually-hidden">Negative prompt</span>
                <textarea id="image-lab-negative" rows="4" placeholder="What should the model avoid?"></textarea>
              </label>
            </details>
          </section>

          <div class="image-lab-parameter-column" aria-label="Generation parameters">
            <div class="image-lab-parameter-grid">
              <label>
                <span class="field-label">Width <span class="field-help" tabindex="0" title="Larger width increases image size and VRAM/memory use. Reduce it if generation is too slow or memory runs out.">?</span></span>
                <input id="image-lab-width" type="number" min="64" max="4096" step="64" required>
              </label>
              <label>
                <span class="field-label">Height <span class="field-help" tabindex="0" title="Larger height increases image size and VRAM/memory use. Reduce it if the image is too large, slow, or causing memory failures.">?</span></span>
                <input id="image-lab-height" type="number" min="64" max="4096" step="64" required>
              </label>
              <label class="image-lab-resolution-preset-label">
                <span class="field-label">Portrait preset <span class="field-help" tabindex="0" title="Height-greater-than-width 64-aligned size suggestions, grouped by the same tier ladder. Width and height stay editable for custom sizes.">?</span></span>
                <select id="image-lab-portrait-size-preset" aria-label="Portrait image size preset"></select>
              </label>
              <label class="image-lab-resolution-preset-label">
                <span class="field-label">Landscape preset <span class="field-help" tabindex="0" title="Width-greater-than-height 64-aligned size suggestions, grouped by the same tier ladder. Width and height stay editable for custom sizes.">?</span></span>
                <select id="image-lab-landscape-size-preset" aria-label="Landscape image size preset"></select>
              </label>
              <label>
                <span class="field-label">Steps <span class="field-help" tabindex="0" title="More steps can refine detail but increase generation time. Lower steps are useful for fast exploration.">?</span></span>
                <input id="image-lab-steps" type="number" min="1" max="150" step="1" required>
              </label>
              <label>
                <span class="field-label">CFG <span class="field-help" tabindex="0" title="Higher CFG usually follows the prompt more strongly; lower CFG gives the model more freedom. Very high CFG can look harsh, overcooked, or less natural.">?</span></span>
                <input id="image-lab-cfg" type="number" min="0" max="30" step="0.5" required>
              </label>
              <label>
                <span class="field-label">Seed <span class="field-help" tabindex="0" title="Use the same seed with the same model and settings to reproduce a result more closely. Leave blank for the backend's random-seed behavior; the actual seed is shown on the completed job.">?</span></span>
                <input id="image-lab-seed" type="number" min="-1" step="1" placeholder="random">
                <span class="hint image-lab-seed-note">blank = random</span>
              </label>
            </div>

            <div class="image-lab-action-panel">
              <button id="image-lab-generate" type="submit" title="Submit the current generation request. Repeated clicks queue separate jobs with their own pending gallery cards.">Generate!</button>
              <label class="image-lab-auto-generate-switch" data-state="off" title="When enabled, starts the next image automatically after the current active generation finishes.">
                <input id="image-lab-auto-generate" class="image-lab-auto-generate-input" type="checkbox" role="switch" aria-checked="false" aria-describedby="image-lab-auto-generate-state">
                <span class="image-lab-auto-generate-shell">
                  <span class="image-lab-auto-generate-label">Auto-Gen</span>
                  <span class="image-lab-auto-generate-track" aria-hidden="true"><span class="image-lab-auto-generate-thumb"></span></span>
                  <span id="image-lab-auto-generate-state" class="image-lab-auto-generate-state">Off</span>
                </span>
              </label>
            </div>
          </div>

          <section class="image-lab-favorites-panel" aria-label="Saved image favorites">
            <div id="image-lab-favorites" class="image-lab-favorites-strip placeholder">Loading favorites...</div>
          </section>
        </div>

        <details class="image-lab-advanced compact-details">
          <summary>Advanced options</summary>
          <div class="image-lab-advanced-grid">
            <label>
              Sampler
              <input id="image-lab-sampler" type="text">
            </label>
            <label>
              Scheduler
              <input id="image-lab-scheduler" type="text">
            </label>
            <label>
              Sync timeout ms
              <input id="image-lab-sync-timeout" type="number" min="0" step="100" value="1000">
            </label>
          </div>
          <div class="image-lab-preview-columns">
            <div>
              <h3>Request payload</h3>
              <pre><code id="image-lab-request-preview">{}</code></pre>
            </div>
            <div>
              <h3>Last result</h3>
              <div id="image-lab-last-result" class="placeholder">No image generated yet.</div>
            </div>
          </div>
        </details>
      </form>
      <div id="image-lab-controls-resize" class="image-lab-resize-handle" role="separator" aria-label="Resize controls area" aria-orientation="horizontal" tabindex="0"></div>
    </section>

    <section class="image-lab-gallery-section" aria-label="Generated image gallery">
      <div class="section-heading image-lab-gallery-heading">
        <div>
          <h2>Gallery</h2>
          <p class="hint">Newest generated images appear first. Details are collapsed until you open a card caption.</p>
        </div>
        <div class="image-lab-gallery-header-actions">
          <label class="image-lab-gallery-size-control">
            <span class="field-label">Gallery size <span class="field-help" tabindex="0" title="Controls the displayed size of gallery cards. Smaller values show more images; larger values make previews easier to inspect.">?</span></span>
            <input id="image-lab-gallery-size" type="range" min="160" max="620" step="20">
            <span id="image-lab-gallery-size-value" class="hint"></span>
          </label>
          <div id="image-lab-gallery-count" class="hint"></div>
        </div>
      </div>
      <div id="image-lab-gallery" class="image-lab-gallery placeholder">Loading recent generated images...</div>
      <div class="button-row image-lab-load-more-row">
        <button id="image-lab-load-more" class="secondary" type="button">Load more history</button>
      </div>
    </section>
  </main>

  <footer>
    <span>${SERVICE_NAME} ${APPLICATION_VERSION}</span>
    <a href="/openapi.json">OpenAPI</a>
  </footer>
  <script src="/assets/image-generator.js" type="module"></script>
</body>
</html>`;
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
      <p class="muted">ComfyUI image API, hosted control panel, model installs/defaults, generation testing, async job metrics, artifact storage, and NVIDIA GPU telemetry.</p>
    </div>
    <div class="header-actions">
      <a class="button-link" href="/image-generator">Image Generator</a>
      <button id="refresh-button" type="button">Refresh</button>
    </div>
  </header>

  <main>
    <section class="card">
      <div class="section-heading">
        <div>
          <h2>Dashboard API key</h2>
          <p class="hint">Leave this blank unless this server was started with <code>IMAGE_API_KEYS</code> or <code>REQUIRE_IMAGE_API_AUTH=true</code>. This is not a ComfyUI key and does not load models; it only lets this browser call protected <code>/api/v1</code> dashboard endpoints.</p>
        </div>
        <div id="image-auth-status"></div>
      </div>
      <form id="api-key-form" class="auth-row">
        <label>
          Optional API key for this browser
          <input id="api-key-input" type="password" autocomplete="off" placeholder="Only needed if API auth is enabled">
        </label>
        <button type="submit">Save key</button>
        <button id="clear-key-button" class="secondary" type="button">Clear key</button>
      </form>
      <p id="image-auth-help" class="hint"></p>
      <div id="image-feedback" class="feedback" aria-live="polite"></div>
    </section>

    <section class="grid three">
      <article class="card">
        <h2>Service status</h2>
        <div id="image-health-content" class="placeholder">Loading image API health...</div>
      </article>
      <article class="card">
        <h2>Queue status</h2>
        <div id="image-queue-content" class="placeholder">Loading queue stats...</div>
      </article>
      <article class="card">
        <div class="section-heading">
          <h2>GPU telemetry</h2>
          <p class="hint">From <code>/api/v1/stats</code>.</p>
        </div>
        <div id="gpu-list" class="gpu-grid placeholder">Loading GPU telemetry...</div>
      </article>
    </section>

    <section class="card model-management-card">
      <div class="section-heading">
        <div>
          <h2>Model management</h2>
          <p class="hint">Scan installed ComfyUI models, set the default image checkpoint, and install operator-approved model files into configured model directories.</p>
        </div>
        <button id="refresh-models-button" class="secondary" type="button">Refresh scan</button>
      </div>
      <div id="default-model-status" class="default-model-panel placeholder">Loading default model lifecycle status...</div>
      <h3>Installed model list</h3>
      <div id="image-models" class="placeholder">Loading model inventory...</div>
    </section>

    <section class="grid two">
      <article class="card">
        <div class="section-heading">
          <div>
            <h2>Install/download model</h2>
            <p class="hint">Downloads use Node streaming APIs, write a temporary <code>.part</code> file first, then rename on success.</p>
          </div>
          <div id="model-install-status"></div>
        </div>
        <form id="model-download-form" class="stack">
          <label>
            Direct download URL
            <input id="download-url" type="url" placeholder="https://.../model.safetensors" autocomplete="off">
          </label>
          <div class="form-grid">
            <label>
              Model type/category
              <select id="download-type"></select>
            </label>
            <label>
              Confirm filename
              <input id="download-file-name" type="text" placeholder="Leave blank to infer from URL">
            </label>
          </div>
          <label>
            Destination folder for selected type
            <input id="download-destination" type="text" readonly>
          </label>
          <div class="button-row">
            <label class="checkbox-label"><input id="download-set-default" type="checkbox"> Set checkpoint as default after download</label>
            <label class="checkbox-label"><input id="download-overwrite" type="checkbox"> Overwrite existing file</label>
          </div>
          <button id="start-download-button" type="submit">Start download</button>
        </form>
        <h3>Download jobs</h3>
        <div id="model-downloads" class="placeholder">Loading model download jobs...</div>
      </article>

      <article class="card">
        <h2>Find models / local catalog</h2>
        <p class="hint">The catalog is a local JSON reference list. It does not scrape model sites; edit <code>config/model-catalog.json</code> to add approved entries.</p>
        <div id="model-catalog" class="placeholder">Loading model catalog...</div>
      </article>
    </section>

    <section class="card">
      <div class="section-heading">
        <div>
          <h2>Generate image</h2>
          <p class="hint">This form sends a real <code>/api/v1/generate</code> request. It shows the exact checkpoint, JSON, and curl command before you submit.</p>
        </div>
        <div id="playground-status"></div>
      </div>
      <div id="playground-default-model" class="notice">Loading default model...</div>
      <section class="saved-favorites-panel">
        <div class="section-heading compact-section-heading">
          <div>
            <h3>Saved favorites</h3>
            <p class="hint">Save complete generation requests, then load them back into this form without starting a job automatically.</p>
          </div>
          <button id="refresh-favorites-button" class="secondary" type="button">Refresh favorites</button>
        </div>
        <div id="favorite-prompts" class="placeholder">Loading saved favorites...</div>
      </section>
      <div class="playground-layout">
        <form id="playground-form" class="stack">
          <div class="form-grid">
            <label>
              Checkpoint to send
              <select id="playground-model"></select>
            </label>
            <label>
              Workflow
              <select id="playground-workflow"></select>
            </label>
          </div>
          <label>
            Prompt
            <textarea id="playground-prompt" placeholder="Describe the image to generate"></textarea>
          </label>
          <label>
            Negative prompt
            <textarea id="playground-negative" placeholder="Optional negative prompt"></textarea>
          </label>
          <div class="form-grid three">
            <label>Width <input id="playground-width" type="number" min="64" max="4096" step="64"></label>
            <label>Height <input id="playground-height" type="number" min="64" max="4096" step="64"></label>
            <label>Portrait preset <select id="playground-portrait-size-preset" aria-label="Portrait image size preset"></select></label>
            <label>Landscape preset <select id="playground-landscape-size-preset" aria-label="Landscape image size preset"></select></label>
            <label>Steps <input id="playground-steps" type="number" min="1" max="150" step="1"></label>
            <label>CFG scale <input id="playground-cfg-scale" type="number" min="0" max="30" step="0.5"></label>
            <label>Seed <input id="playground-seed" type="number" step="1" value="-1"></label>
            <label>Output <select id="playground-output"><option value="url">url</option><option value="metadata">metadata</option><option value="base64">base64</option><option value="binary">binary</option></select></label>
          </div>
          <div class="form-grid">
            <label>Sampler <input id="playground-sampler" type="text"></label>
            <label>Scheduler <input id="playground-scheduler" type="text"></label>
            <label>Sync timeout ms <input id="playground-sync-timeout" type="number" min="0" step="100" value="0"></label>
            <label class="checkbox-label"><input id="playground-random-seed" type="checkbox" checked> Random seed</label>
          </div>
          <div class="button-row">
            <button type="submit">Submit generation</button>
            <button id="playground-save-favorite" class="secondary" type="button">Save Favorite</button>
            <button id="playground-load-selected" class="secondary" type="button">Load selected checkpoint now</button>
            <button id="playground-set-selected-default" class="secondary" type="button">Set selected checkpoint as default</button>
            <button id="playground-preload-selected-startup" class="secondary" type="button">Set selected default + preload after restart</button>
            <button id="playground-cancel" class="secondary" type="button" disabled>Cancel job</button>
            <button id="apply-workflow-defaults" class="secondary" type="button">Apply workflow defaults</button>
          </div>
        </form>
        <aside class="preview-panel">
          <div>
            <h3>Raw API request preview</h3>
            <pre><code id="playground-request-preview">{}</code></pre>
          </div>
          <div>
            <h3>Equivalent curl</h3>
            <pre><code id="playground-curl-preview"></code></pre>
          </div>
          <div>
            <h3>Result</h3>
            <div id="playground-result" class="placeholder">No request submitted yet.</div>
          </div>
        </aside>
      </div>
    </section>

    <section class="card workflow-presets-card">
      <h2>Workflow presets</h2>
      <div id="image-workflows" class="placeholder">Loading workflow presets...</div>
    </section>

    <section class="card recent-jobs-card">
      <div class="section-heading">
        <div>
          <h2>Recent image jobs</h2>
          <p class="hint">Paginated gallery of recent results with compact model/workflow settings, timing, step speed, artifacts, and provider metadata. Shows 9 history items per page by default so older records can be browsed without rendering the full history at once. Token counts are shown as N/A unless a provider reports them.</p>
        </div>
      </div>
      <div id="image-jobs" class="placeholder">Loading recent image jobs...</div>
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
