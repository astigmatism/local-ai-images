import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../errors.ts';
import type { ConfigStore } from '../../config/store.ts';
import type { Logger } from '../../logger.ts';
import type {
  AppConfig,
  ArtifactMetadata,
  ImageGenerationProvider,
  ModelInventory,
  ModelInventoryItem,
  NormalizedGenerationRequest,
  RuntimeConfig,
  WorkflowPreset
} from '../../types.ts';
import { ArtifactStore } from './artifactStore.ts';
import { ModelScanner } from './modelScanner.ts';
import { WorkflowStore } from './workflowStore.ts';
import { displayModelName, findInventoryModel, modelMatchesDefault } from './modelIdentity.ts';

export type ModelPreloadResult = 'not_attempted' | 'running' | 'succeeded' | 'failed' | 'skipped';
export type ModelLoadedStatus = 'last_confirmed_loaded' | 'default_not_confirmed_loaded' | 'not_confirmed_loaded' | 'not_applicable';

export interface ModelPreloadStatus {
  ok: true;
  currentDefaultCheckpoint: string | null;
  defaultModel: string | null;
  defaultFileExists: boolean | null;
  preloadOnStartup: boolean;
  lastPreloadAttemptTime: string | null;
  lastPreloadCompletedTime: string | null;
  lastPreloadResult: ModelPreloadResult;
  lastPreloadError: { code: string; message: string; details?: unknown } | null;
  lastPreloadModel: string | null;
  lastConfirmedLoadedModel: string | null;
  lastConfirmedLoadedAt: string | null;
  lastConfirmedLoadedSource: string | null;
  active: boolean;
  defaultWarning: string | null;
  // snake_case aliases for simple clients and logs.
  current_default_checkpoint: string | null;
  default_file_exists: boolean | null;
  preload_on_startup: boolean;
  last_preload_attempt_time: string | null;
  last_preload_completed_time: string | null;
  last_preload_result: ModelPreloadResult;
  last_preload_error: { code: string; message: string; details?: unknown } | null;
  last_preload_model: string | null;
  last_confirmed_loaded_model: string | null;
  last_confirmed_loaded_at: string | null;
  last_confirmed_loaded_source: string | null;
  default_warning: string | null;
}

interface LifecycleState {
  lastPreloadAttemptTime: string | null;
  lastPreloadCompletedTime: string | null;
  lastPreloadResult: ModelPreloadResult;
  lastPreloadError: { code: string; message: string; details?: unknown } | null;
  lastPreloadModel: string | null;
  lastConfirmedLoadedModel: string | null;
  lastConfirmedLoadedAt: string | null;
  lastConfirmedLoadedSource: string | null;
}

interface ModelLifecycleOptions {
  runtimeConfig: RuntimeConfig;
  configStore: ConfigStore;
  provider: ImageGenerationProvider;
  modelScanner: ModelScanner;
  workflowStore: WorkflowStore;
  artifactStore: ArtifactStore;
  logger: Logger;
}

export interface DeleteInstalledModelResult {
  ok: true;
  deleted: {
    id: string;
    fileName: string;
    type: string;
    sizeBytes: number | null;
    path: string;
  };
  clearedDefault: boolean;
  cleared_default: boolean;
  inventory: ModelInventory;
}

export class ModelLifecycleManager {
  private readonly runtimeConfig: RuntimeConfig;
  private readonly configStore: ConfigStore;
  private readonly provider: ImageGenerationProvider;
  private readonly modelScanner: ModelScanner;
  private readonly workflowStore: WorkflowStore;
  private readonly artifactStore: ArtifactStore;
  private readonly logger: Logger;
  private readonly state: LifecycleState = {
    lastPreloadAttemptTime: null,
    lastPreloadCompletedTime: null,
    lastPreloadResult: 'not_attempted',
    lastPreloadError: null,
    lastPreloadModel: null,
    lastConfirmedLoadedModel: null,
    lastConfirmedLoadedAt: null,
    lastConfirmedLoadedSource: null
  };
  private activePreload: Promise<ModelPreloadStatus> | null = null;

  constructor(options: ModelLifecycleOptions) {
    this.runtimeConfig = options.runtimeConfig;
    this.configStore = options.configStore;
    this.provider = options.provider;
    this.modelScanner = options.modelScanner;
    this.workflowStore = options.workflowStore;
    this.artifactStore = options.artifactStore;
    this.logger = options.logger;
  }

  recordConfirmedLoaded(model: string | null | undefined, source = 'generation'): void {
    const normalized = typeof model === 'string' ? model.trim() : '';
    if (!normalized) return;
    this.state.lastConfirmedLoadedModel = normalized;
    this.state.lastConfirmedLoadedAt = new Date().toISOString();
    this.state.lastConfirmedLoadedSource = source;
  }

  async getStatus(inventory?: ModelInventory, config?: AppConfig): Promise<ModelPreloadStatus> {
    const resolvedConfig = config ?? await this.configStore.readConfig();
    const resolvedInventory = inventory ?? await this.modelScanner.list();
    return this.buildStatus(resolvedInventory, resolvedConfig);
  }

  async setPreloadOnStartup(enabled: boolean): Promise<AppConfig> {
    return this.configStore.updateImagePreloadDefaultOnStartup(enabled);
  }

  async preloadCheckpoint(options: { model?: string | null; source?: string; setDefault?: boolean } = {}): Promise<ModelPreloadStatus> {
    if (this.activePreload) {
      throw new AppError('MODEL_PRELOAD_ALREADY_RUNNING', 'A model preload job is already running.', 409, await this.getStatus().catch(() => undefined));
    }

    const source = options.source ?? 'api';
    // Validate that the caller actually selected a checkpoint or configured a
    // default before marking the lifecycle as a failed preload attempt. This
    // keeps a fresh portal from showing a scary persistent "last preload error"
    // when no model has ever been chosen.
    const requestedModel = await this.resolveRequestedPreloadModel(options.model);
    const attemptTime = new Date().toISOString();
    this.state.lastPreloadAttemptTime = attemptTime;
    this.state.lastPreloadCompletedTime = null;
    this.state.lastPreloadResult = 'running';
    this.state.lastPreloadError = null;
    this.state.lastPreloadModel = requestedModel;

    this.activePreload = this.runPreload({ ...options, model: requestedModel }, source)
      .finally(() => {
        this.activePreload = null;
      });

    return this.activePreload;
  }

  async startStartupPreload(): Promise<boolean> {
    const status = await this.getStatus().catch((error: unknown) => {
      this.logger.warn({ err: error }, 'Image default model startup preload status check failed');
      return null;
    });
    if (!status?.preloadOnStartup) {
      return false;
    }
    if (!status.currentDefaultCheckpoint) {
      this.markSkipped('IMAGE_PRELOAD_DEFAULT_MISSING', 'Image default model startup preload skipped because no default checkpoint is configured.');
      this.logger.warn('Image default model startup preload skipped because no default checkpoint is configured');
      return false;
    }
    if (status.defaultFileExists === false) {
      this.markSkipped('IMAGE_PRELOAD_DEFAULT_FILE_MISSING', 'Image default model startup preload skipped because the configured default checkpoint was not found on disk.');
      this.logger.warn({ model: status.currentDefaultCheckpoint }, 'Image default model startup preload skipped because the configured default checkpoint was not found on disk');
      return false;
    }

    this.logger.info({ model: status.currentDefaultCheckpoint }, 'Image default model startup preload started');
    void this.preloadCheckpoint({ model: status.currentDefaultCheckpoint, source: 'startup' })
      .then((preloadStatus) => {
        this.logger.info({ model: preloadStatus.lastPreloadModel }, 'Image default model startup preload succeeded');
      })
      .catch((error: unknown) => {
        this.logger.warn({ err: error, model: status.currentDefaultCheckpoint }, 'Image default model startup preload failed');
      });
    return true;
  }

  canDeleteModel(model: ModelInventoryItem): boolean {
    return this.isInsideApprovedModelDirectory(model.path);
  }

  deletePreview(model: ModelInventoryItem, isDefault = false): Record<string, unknown> {
    return {
      fileName: model.fileName,
      type: model.type,
      sizeBytes: model.sizeBytes,
      path: model.path,
      requiresConfirmation: true,
      confirmationField: 'confirm_file_name',
      confirmationValue: model.fileName,
      isDefault,
      deleteRequiresDefaultClear: isDefault
    };
  }

  async deleteInstalledModel(identifier: string, body: unknown): Promise<DeleteInstalledModelResult> {
    if (!identifier.trim()) {
      throw new AppError('MODEL_DELETE_MODEL_REQUIRED', 'Model identifier is required.', 422);
    }
    if (!isRecord(body)) {
      throw new AppError('MODEL_DELETE_CONFIRMATION_REQUIRED', 'Delete requests must include a JSON confirmation body.', 422);
    }

    const inventory = await this.modelScanner.list();
    const model = findInventoryModel(inventory.models, identifier);
    if (!model) {
      throw new AppError('MODEL_NOT_FOUND', `Installed model ${identifier} was not found in the scanned model inventory.`, 404);
    }

    const confirmation = readBodyString(body, 'confirm_file_name') || readBodyString(body, 'confirmFileName') || readBodyString(body, 'confirm');
    if (confirmation !== model.fileName) {
      throw new AppError('MODEL_DELETE_CONFIRMATION_MISMATCH', `Type the exact file name (${model.fileName}) to confirm deletion.`, 422, {
        delete_preview: this.deletePreview(model)
      });
    }

    const resolvedPath = path.resolve(model.path);
    if (!this.isInsideApprovedModelDirectory(resolvedPath)) {
      throw new AppError('MODEL_DELETE_UNAPPROVED_PATH', 'Model deletion is allowed only inside approved ComfyUI model directories.', 403, {
        file_name: model.fileName,
        path: resolvedPath,
        approved_directories: this.approvedDeleteDirectories()
      });
    }

    let stat;
    try {
      stat = await fs.stat(resolvedPath);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        await this.modelScanner.refresh();
        throw new AppError('MODEL_FILE_MISSING', `Model file ${model.fileName} is no longer present on disk.`, 404);
      }
      throw error;
    }
    if (!stat.isFile()) {
      throw new AppError('MODEL_DELETE_NOT_A_FILE', 'Only installed model files can be deleted from the portal.', 422, {
        path: resolvedPath
      });
    }

    const config = await this.configStore.readConfig();
    const isDefault = modelMatchesDefault(model, config.image_default_model ?? '');
    const deleteAndClearDefault = readBodyBoolean(body, 'delete_and_clear_default') || readBodyBoolean(body, 'deleteAndClearDefault');
    if (isDefault && !deleteAndClearDefault) {
      throw new AppError('MODEL_DELETE_DEFAULT_BLOCKED', 'This checkpoint is the current default. Clear the default first or send delete_and_clear_default=true with the exact file-name confirmation.', 409, {
        delete_preview: this.deletePreview(model, true)
      });
    }

    await fs.unlink(resolvedPath);
    if (isDefault && deleteAndClearDefault) {
      await this.configStore.clearImageDefaultModel();
    }
    const refreshed = await this.modelScanner.refresh();
    return {
      ok: true,
      deleted: {
        id: model.id,
        fileName: model.fileName,
        type: model.type,
        sizeBytes: model.sizeBytes ?? stat.size,
        path: resolvedPath
      },
      clearedDefault: isDefault && deleteAndClearDefault,
      cleared_default: isDefault && deleteAndClearDefault,
      inventory: refreshed
    };
  }

  private async runPreload(options: { model?: string | null; setDefault?: boolean }, source: string): Promise<ModelPreloadStatus> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.runtimeConfig.imagePreloadTimeoutMs);
    try {
      const requestedModel = await this.resolveRequestedPreloadModel(options.model);
      const inventory = await this.modelScanner.list();
      const model = findInventoryModel(inventory.models, requestedModel);
      if (!model) {
        throw new AppError('MODEL_NOT_FOUND', `Installed model ${requestedModel} was not found in the scanned model inventory.`, 404);
      }
      if (model.type !== 'checkpoint') {
        throw new AppError('MODEL_PRELOAD_REQUIRES_CHECKPOINT', 'Only installed checkpoint models can be loaded/prewarmed into ComfyUI.', 422, {
          type: model.type,
          file_name: model.fileName
        });
      }
      if (options.setDefault) {
        await this.configStore.updateImageDefaultModel(displayModelName(model));
      }

      this.state.lastPreloadModel = displayModelName(model);
      const workflow = await this.resolvePreloadWorkflow();
      if (!workflow.comfyui.mappings.checkpointNode) {
        throw new AppError('MODEL_PRELOAD_WORKFLOW_NO_CHECKPOINT', 'The configured preload workflow does not expose a checkpoint loader mapping.', 422, {
          workflow_id: workflow.id
        });
      }

      await this.waitForProviderReady(controller.signal);
      const request = this.buildPreloadRequest(model, workflow);
      const providerResult = await this.provider.generate({
        ...request,
        jobId: `preload-${crypto.randomUUID()}`,
        workflow,
        filenamePrefix: `local-ai-images-preload-${Date.now()}`,
        signal: controller.signal
      });

      let artifacts: ArtifactMetadata[] = [];
      if (this.runtimeConfig.imagePreloadKeepArtifact) {
        artifacts = await this.artifactStore.saveArtifacts({
          jobId: `preload-${crypto.randomUUID()}`,
          provider: providerResult.provider,
          workflowId: workflow.id,
          request,
          images: providerResult.images
        });
      }

      this.recordConfirmedLoaded(request.model, source === 'startup' ? 'startup_preload' : 'manual_preload');
      this.state.lastPreloadResult = 'succeeded';
      this.state.lastPreloadCompletedTime = new Date().toISOString();
      this.state.lastPreloadError = null;
      const status = await this.getStatus();
      return {
        ...status,
        lastPreloadResult: 'succeeded',
        last_preload_result: 'succeeded',
        lastPreloadError: null,
        last_preload_error: null,
        ...(artifacts.length > 0 ? { artifacts: artifacts.map(({ filePath: _filePath, ...artifact }) => artifact) } : {})
      } as ModelPreloadStatus;
    } catch (error: unknown) {
      this.state.lastPreloadResult = 'failed';
      this.state.lastPreloadCompletedTime = new Date().toISOString();
      this.state.lastPreloadError = errorToStatusError(error);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async resolveRequestedPreloadModel(model: string | null | undefined): Promise<string> {
    const requestedModel = typeof model === 'string' && model.trim()
      ? model.trim()
      : ((await this.configStore.readConfig()).image_default_model || '').trim();
    if (!requestedModel) {
      throw new AppError(
        'MODEL_PRELOAD_MODEL_REQUIRED',
        'Choose an installed checkpoint first, or set one as the default checkpoint, then load/prewarm it.',
        422
      );
    }
    return requestedModel;
  }

  private async resolvePreloadWorkflow(): Promise<WorkflowPreset> {
    const workflowId = this.runtimeConfig.imagePreloadWorkflowId || this.runtimeConfig.imageDefaultWorkflowId;
    try {
      return await this.workflowStore.get(workflowId);
    } catch {
      return this.workflowStore.get(this.runtimeConfig.imageDefaultWorkflowId);
    }
  }

  private buildPreloadRequest(model: ModelInventoryItem, workflow: WorkflowPreset): NormalizedGenerationRequest {
    return {
      prompt: 'Local AI Images checkpoint preload validation image',
      negativePrompt: '',
      model: displayModelName(model),
      workflowId: workflow.id,
      width: this.runtimeConfig.imagePreloadWidth || workflow.defaults.width || 512,
      height: this.runtimeConfig.imagePreloadHeight || workflow.defaults.height || 512,
      steps: this.runtimeConfig.imagePreloadSteps || workflow.defaults.steps || 1,
      cfgScale: workflow.defaults.cfgScale ?? 1,
      seed: 1,
      samplerName: workflow.defaults.samplerName ?? 'euler',
      scheduler: workflow.defaults.scheduler ?? 'normal',
      output: 'metadata',
      syncTimeoutMs: this.runtimeConfig.imagePreloadTimeoutMs,
      metadata: {
        purpose: 'model_preload',
        keep_artifact: this.runtimeConfig.imagePreloadKeepArtifact
      }
    };
  }

  private async waitForProviderReady(signal: AbortSignal): Promise<void> {
    const started = Date.now();
    let lastError: unknown = null;
    while (Date.now() - started <= this.runtimeConfig.imagePreloadTimeoutMs) {
      if (signal.aborted) {
        throw new AppError('MODEL_PRELOAD_TIMEOUT', `Timed out preloading model after ${this.runtimeConfig.imagePreloadTimeoutMs}ms.`, 504);
      }

      const remainingMs = Math.max(1, this.runtimeConfig.imagePreloadTimeoutMs - (Date.now() - started));
      const health = await withTimeout(this.provider.health(), remainingMs, signal).catch((error: unknown) => {
        lastError = error;
        return null;
      });
      if (health?.ok) return;
      if (health?.error) lastError = health.error;

      const remainingAfterHealthMs = this.runtimeConfig.imagePreloadTimeoutMs - (Date.now() - started);
      if (remainingAfterHealthMs <= 0) break;
      await sleep(Math.min(1000, Math.max(50, remainingAfterHealthMs)), signal);
    }

    throw new AppError('COMFYUI_UNAVAILABLE', 'ComfyUI did not become reachable before the model preload timeout.', 503, {
      timeout_ms: this.runtimeConfig.imagePreloadTimeoutMs,
      last_error: lastError
    });
  }

  private buildStatus(inventory: ModelInventory, config: AppConfig): ModelPreloadStatus {
    const defaultModel = (config.image_default_model || '').trim() || null;
    const defaultFile = defaultModel ? findInventoryModel(inventory.models, defaultModel) : null;
    const defaultFileExists = defaultModel ? Boolean(defaultFile) : null;
    const defaultWarning = defaultModel && !defaultFile
      ? `Configured default checkpoint ${defaultModel} was not found in the scanned model inventory.`
      : null;
    const preloadOnStartup = config.image_preload_default_on_startup === true;
    return {
      ok: true,
      currentDefaultCheckpoint: defaultModel,
      defaultModel,
      defaultFileExists,
      preloadOnStartup,
      lastPreloadAttemptTime: this.state.lastPreloadAttemptTime,
      lastPreloadCompletedTime: this.state.lastPreloadCompletedTime,
      lastPreloadResult: this.state.lastPreloadResult,
      lastPreloadError: this.state.lastPreloadError,
      lastPreloadModel: this.state.lastPreloadModel,
      lastConfirmedLoadedModel: this.state.lastConfirmedLoadedModel,
      lastConfirmedLoadedAt: this.state.lastConfirmedLoadedAt,
      lastConfirmedLoadedSource: this.state.lastConfirmedLoadedSource,
      active: Boolean(this.activePreload),
      defaultWarning,
      current_default_checkpoint: defaultModel,
      default_file_exists: defaultFileExists,
      preload_on_startup: preloadOnStartup,
      last_preload_attempt_time: this.state.lastPreloadAttemptTime,
      last_preload_completed_time: this.state.lastPreloadCompletedTime,
      last_preload_result: this.state.lastPreloadResult,
      last_preload_error: this.state.lastPreloadError,
      last_preload_model: this.state.lastPreloadModel,
      last_confirmed_loaded_model: this.state.lastConfirmedLoadedModel,
      last_confirmed_loaded_at: this.state.lastConfirmedLoadedAt,
      last_confirmed_loaded_source: this.state.lastConfirmedLoadedSource,
      default_warning: defaultWarning
    };
  }

  private markSkipped(code: string, message: string): void {
    const now = new Date().toISOString();
    this.state.lastPreloadAttemptTime = now;
    this.state.lastPreloadCompletedTime = now;
    this.state.lastPreloadResult = 'skipped';
    this.state.lastPreloadError = { code, message };
  }

  private approvedDeleteDirectories(): string[] {
    const approved = new Set<string>();
    for (const directory of Object.values(this.runtimeConfig.modelInstallDirectories)) {
      if (directory) approved.add(path.resolve(directory));
    }
    return [...approved];
  }

  private isInsideApprovedModelDirectory(filePath: string): boolean {
    const resolvedFilePath = path.resolve(filePath);
    return this.approvedDeleteDirectories().some((directory) => isInsideDirectory(directory, resolvedFilePath));
  }
}

function isInsideDirectory(directory: string, filePath: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function errorToStatusError(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details })
    };
  }
  if (error instanceof Error) {
    return { code: 'MODEL_PRELOAD_FAILED', message: error.message };
  }
  return { code: 'MODEL_PRELOAD_FAILED', message: 'Unknown model preload failure.' };
}

function readBodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readBodyBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AppError('MODEL_PRELOAD_TIMEOUT', 'Timed out preloading model.', 504));
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      reject(new AppError('MODEL_PRELOAD_TIMEOUT', 'Timed out preloading model.', 504));
    }, milliseconds);
    const abort = () => {
      cleanup();
      reject(new AppError('MODEL_PRELOAD_TIMEOUT', 'Timed out preloading model.', 504));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => {
      cleanup();
      resolve(value);
    }, (error: unknown) => {
      cleanup();
      reject(error);
    });
  });
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AppError('MODEL_PRELOAD_TIMEOUT', 'Timed out preloading model.', 504));
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = () => {
      cleanup();
      reject(new AppError('MODEL_PRELOAD_TIMEOUT', 'Timed out preloading model.', 504));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}
