import crypto from 'node:crypto';
import { AppError } from '../../errors.ts';
import type { Logger } from '../../logger.ts';
import type {
  CheckpointProbeStatus,
  GenerationSourceList,
  GenerationSourceListStatus,
  GenerationSourceSummary,
  GenerationSourceCategoryMetadata,
  GenerationSourceConstraintMetadata,
  GenerationSourcePromptStyleMetadata,
  ImageGenerationProvider,
  ModelInventory,
  ModelInventoryItem,
  NormalizedGenerationRequest,
  RuntimeConfig,
  WorkflowPreset
} from '../../types.ts';
import { displayModelName } from './modelIdentity.ts';
import { ModelScanner } from './modelScanner.ts';
import { WorkflowStore } from './workflowStore.ts';

interface GenerationSourceRegistryOptions {
  runtimeConfig: RuntimeConfig;
  provider: ImageGenerationProvider;
  modelScanner: ModelScanner;
  workflowStore: WorkflowStore;
  logger: Logger;
}

interface CheckpointProbeCacheEntry {
  checkpointId: string;
  checkpointName: string;
  filePath: string;
  modifiedAt: string | null;
  sizeBytes: number | null;
  signature: string;
  model: ModelInventoryItem;
  status: CheckpointProbeStatus;
  probeTimestamp: string | null;
  failureReason: string | null;
}

interface WorkflowCompatibility {
  ok: boolean;
  reason: string | null;
  checkpointName: string | null;
  supportsCheckpoint: boolean;
  supportsSeed: boolean;
}

const CHECKPOINT_EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt', '.pth']);
const NON_CHECKPOINT_PATH_SEGMENTS = new Set([
  'lora',
  'loras',
  'lycoris',
  'locon',
  'vae',
  'controlnet',
  'controlnets',
  'embeddings',
  'embedding',
  'textual_inversion',
  'upscale_models',
  'upscalers',
  'upscaler',
  'clip',
  'text_encoder',
  'text_encoders',
  'encoder',
  'encoders',
  'diffusion_model',
  'diffusion_models',
  'unet',
  'unets',
  'ipadapter',
  'ip-adapter',
  'pulid',
  'instantid',
  'configs',
  'metadata',
  'logs'
]);
const NON_CHECKPOINT_NAME_PATTERN = /(^|[_.\-\s])(lora|lycoris|locon|controlnet|embedding|textual[_.\-\s]?inversion|clip|text[_.\-\s]?encoder|upscaler|esrgan|realesrgan|vae|ip[_.\-\s]?adapter|pulid|instantid)([_.\-\s]|$)/iu;
const OPERATIONAL_STATUS_PATTERN = /(prewarm\s+failed|prompt\s+returned|http\s+\d{3}|traceback|error[:\s]|failed[,\s])/iu;
const PROBE_PROMPT = 'local ai images checkpoint compatibility probe';
const PROBE_RETRY_DELAY_MS = 5000;

export class GenerationSourceRegistry {
  private readonly runtimeConfig: RuntimeConfig;
  private readonly provider: ImageGenerationProvider;
  private readonly modelScanner: ModelScanner;
  private readonly workflowStore: WorkflowStore;
  private readonly logger: Logger;
  private readonly checkpointProbeCache = new Map<string, CheckpointProbeCacheEntry>();
  private activeProbeRun: Promise<void> | null = null;
  private lastStartedAt: string | null = null;
  private lastCompletedAt: string | null = null;
  private lastError: { code: string; message: string } | null = null;
  private providerCheckpointNames: Set<string> | null = null;
  private providerCheckpointNamesLoadedAt: string | null = null;
  private probeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private nextProbeNotBeforeMs = 0;

  constructor(options: GenerationSourceRegistryOptions) {
    this.runtimeConfig = options.runtimeConfig;
    this.provider = options.provider;
    this.modelScanner = options.modelScanner;
    this.workflowStore = options.workflowStore;
    this.logger = options.logger;
  }

  startStartupProbe(): void {
    void this.refresh({ forceProbe: false })
      .catch((error: unknown) => {
        this.lastError = errorSummary(error);
        this.logger.warn({ err: error }, 'Generation source startup probe scheduling failed');
      });
  }

  async list(): Promise<GenerationSourceList> {
    const [inventory] = await Promise.all([
      this.modelScanner.list(),
      this.workflowStore.list().catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Workflow registry list reported errors');
        return [];
      })
    ]);
    await this.syncCheckpointProbeCache(inventory, false);
    this.ensureProbeRun();
    return this.buildSourceList();
  }

  async refresh(options: { forceProbe?: boolean } = {}): Promise<GenerationSourceList> {
    const [inventory] = await Promise.all([
      this.modelScanner.refresh(),
      this.workflowStore.refresh().catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Workflow registry refresh reported errors');
        return [];
      })
    ]);
    if (options.forceProbe) {
      this.providerCheckpointNames = null;
      this.providerCheckpointNamesLoadedAt = null;
    }
    await this.syncCheckpointProbeCache(inventory, options.forceProbe === true);
    this.ensureProbeRun();
    return this.buildSourceList();
  }

  findSource(sourceType: unknown, sourceId: unknown): GenerationSourceSummary | null {
    const normalizedType = typeof sourceType === 'string' ? sourceType.trim().toLowerCase() : '';
    const normalizedId = typeof sourceId === 'string' ? sourceId.trim() : '';
    if (!normalizedId) return null;
    const list = this.cachedSourceList();
    return list.sources.find((source) => {
      if (normalizedType && source.type !== normalizedType) return false;
      return source.id === normalizedId;
    }) ?? null;
  }

  cachedSourceList(): GenerationSourceList {
    return this.buildSourceList();
  }

  private async syncCheckpointProbeCache(inventory: ModelInventory, forceProbe: boolean): Promise<void> {
    const eligibleModels = inventory.models.filter(isEligibleCheckpointCandidate);
    const liveKeys = new Set<string>();

    for (const model of eligibleModels) {
      const checkpointName = displayModelName(model);
      const checkpointId = checkpointSourceId(model);
      const signature = checkpointSignature(model);
      liveKeys.add(checkpointId);
      const existing = this.checkpointProbeCache.get(checkpointId);
      if (existing && existing.signature === signature && !forceProbe) {
        existing.model = model;
        existing.checkpointName = checkpointName;
        continue;
      }
      this.checkpointProbeCache.set(checkpointId, {
        checkpointId,
        checkpointName,
        filePath: model.path,
        modifiedAt: model.modifiedAt,
        sizeBytes: model.sizeBytes,
        signature,
        model,
        status: 'pending',
        probeTimestamp: null,
        failureReason: null
      });
    }

    for (const checkpointId of this.checkpointProbeCache.keys()) {
      if (!liveKeys.has(checkpointId)) this.checkpointProbeCache.delete(checkpointId);
    }
  }

  private ensureProbeRun(): void {
    if (this.activeProbeRun) return;
    if (![...this.checkpointProbeCache.values()].some((entry) => entry.status === 'pending')) return;

    const delayMs = Math.max(0, this.nextProbeNotBeforeMs - Date.now());
    if (delayMs > 0) {
      this.scheduleProbeRetry(delayMs);
      return;
    }

    if (this.probeRetryTimer) {
      clearTimeout(this.probeRetryTimer);
      this.probeRetryTimer = null;
    }

    this.activeProbeRun = this.runProbeQueue()
      .catch((error: unknown) => {
        this.lastError = errorSummary(error);
        this.nextProbeNotBeforeMs = Date.now() + PROBE_RETRY_DELAY_MS;
        this.logger.warn({ err: error }, 'Generation source checkpoint probe queue failed');
      })
      .finally(() => {
        this.lastCompletedAt = new Date().toISOString();
        this.activeProbeRun = null;
        if ([...this.checkpointProbeCache.values()].some((entry) => entry.status === 'pending')) {
          this.ensureProbeRun();
        }
      });
  }

  private scheduleProbeRetry(delayMs: number): void {
    if (this.probeRetryTimer) return;
    this.probeRetryTimer = setTimeout(() => {
      this.probeRetryTimer = null;
      this.ensureProbeRun();
    }, delayMs);
    this.probeRetryTimer.unref?.();
  }

  private async runProbeQueue(): Promise<void> {
    this.lastStartedAt = new Date().toISOString();
    this.lastCompletedAt = null;
    this.lastError = null;

    if (!await this.providerIsReadyForProbe()) return;
    await this.refreshProviderCheckpointNames();

    while (true) {
      const next = [...this.checkpointProbeCache.values()].find((entry) => entry.status === 'pending');
      if (!next) return;
      const shouldContinue = await this.probeCheckpoint(next);
      if (!shouldContinue) return;
    }
  }

  private async providerIsReadyForProbe(): Promise<boolean> {
    try {
      const health = await this.provider.health();
      if (health.ok) return true;
      this.lastError = {
        code: health.error?.code || 'IMAGE_PROVIDER_UNAVAILABLE',
        message: health.error?.message || 'Image generation provider is not ready for checkpoint probing.'
      };
      this.nextProbeNotBeforeMs = Date.now() + PROBE_RETRY_DELAY_MS;
      this.logger.warn({ provider: health.provider, error: health.error }, 'Image provider is not ready for generation source probing; checkpoint candidates remain selectable and will be retried');
      return false;
    } catch (error: unknown) {
      this.lastError = errorSummary(error);
      this.nextProbeNotBeforeMs = Date.now() + PROBE_RETRY_DELAY_MS;
      this.logger.warn({ err: error }, 'Image provider readiness check failed during generation source probing; checkpoint candidates remain selectable and will be retried');
      return false;
    }
  }

  private async refreshProviderCheckpointNames(): Promise<void> {
    if (!this.provider.listCheckpoints || this.providerCheckpointNamesLoadedAt) return;
    try {
      const names = await this.provider.listCheckpoints();
      this.providerCheckpointNames = new Set(names.map(normalizeProviderCheckpointName).filter(Boolean));
      this.providerCheckpointNamesLoadedAt = new Date().toISOString();
    } catch (error: unknown) {
      this.providerCheckpointNames = null;
      if (isProviderUnavailableError(error)) {
        this.lastError = errorSummary(error);
        this.nextProbeNotBeforeMs = Date.now() + PROBE_RETRY_DELAY_MS;
        this.logger.warn({ err: error }, 'ComfyUI checkpoint listing is unavailable; checkpoint candidates remain selectable and probing will retry');
        return;
      }
      this.providerCheckpointNamesLoadedAt = new Date().toISOString();
      this.logger.warn({ err: error }, 'ComfyUI checkpoint listing unavailable during generation source probing; falling back to workflow probe');
    }
  }

  private async probeCheckpoint(entry: CheckpointProbeCacheEntry): Promise<boolean> {
    const current = this.checkpointProbeCache.get(entry.checkpointId);
    if (!current || current.signature !== entry.signature) return true;

    const listedByProvider = this.providerCheckpointNames;
    if (listedByProvider && listedByProvider.size > 0 && !checkpointListedByProvider(entry, listedByProvider)) {
      this.markProbe(entry, 'invalid', 'Checkpoint is not present in ComfyUI CheckpointLoaderSimple object_info ckpt_name list.');
      return true;
    }

    let workflow: WorkflowPreset;
    try {
      workflow = await this.resolveProbeWorkflow();
    } catch (error: unknown) {
      this.markProbe(entry, 'error', error instanceof Error ? error.message : String(error));
      return true;
    }

    if (!workflow.comfyui.mappings.checkpointNode && !findNodeId(workflow.comfyui.prompt, 'CheckpointLoaderSimple', 0)) {
      this.markProbe(entry, 'error', `Probe workflow ${workflow.id} does not expose a checkpoint loader.`);
      return true;
    }

    const controller = new AbortController();
    const timeoutMs = Math.max(1000, this.runtimeConfig.imagePreloadTimeoutMs || this.runtimeConfig.comfyUiRequestTimeoutMs || 30000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const request: NormalizedGenerationRequest = {
      prompt: PROBE_PROMPT,
      negativePrompt: '',
      model: entry.checkpointName,
      workflowId: workflow.id,
      generationSourceType: 'checkpoint',
      generationSourceId: entry.checkpointId,
      generationSourceLabel: entry.checkpointName,
      checkpointName: entry.checkpointName,
      workflowSourceId: null,
      width: probeDimension(this.runtimeConfig.imagePreloadWidth || workflow.defaults.width || 64),
      height: probeDimension(this.runtimeConfig.imagePreloadHeight || workflow.defaults.height || 64),
      steps: Math.max(1, Math.min(2, this.runtimeConfig.imagePreloadSteps || workflow.defaults.steps || 1)),
      cfgScale: 1,
      seed: 1,
      samplerName: workflow.defaults.samplerName ?? 'euler',
      scheduler: workflow.defaults.scheduler ?? 'normal',
      output: 'metadata',
      syncTimeoutMs: timeoutMs,
      metadata: { purpose: 'checkpoint_probe' }
    };

    try {
      await this.provider.generate({
        ...request,
        jobId: `checkpoint-probe-${crypto.randomUUID()}`,
        workflow,
        filenamePrefix: `local-ai-images-probe-${Date.now()}`,
        signal: controller.signal
      });
      this.markProbe(entry, 'valid', null);
      this.logger.info({ checkpoint: entry.checkpointName }, 'Checkpoint generation source probe succeeded');
      return true;
    } catch (error: unknown) {
      if (isProviderUnavailableError(error)) {
        this.lastError = errorSummary(error);
        this.nextProbeNotBeforeMs = Date.now() + PROBE_RETRY_DELAY_MS;
        this.logger.warn({ err: error, checkpoint: entry.checkpointName }, 'Checkpoint generation source probe postponed because the provider is unavailable');
        return false;
      }
      const summary = errorSummary(error);
      const status: CheckpointProbeStatus = isInvalidPromptError(error) ? 'invalid' : 'error';
      this.markProbe(entry, status, summary.message);
      this.logger.warn({ err: error, checkpoint: entry.checkpointName, probeStatus: status }, 'Checkpoint generation source probe failed');
      return true;
    } finally {
      clearTimeout(timeout);
    }
  }

  private markProbe(entry: CheckpointProbeCacheEntry, status: CheckpointProbeStatus, failureReason: string | null): void {
    const current = this.checkpointProbeCache.get(entry.checkpointId);
    if (!current || current.signature !== entry.signature) return;
    current.status = status;
    current.probeTimestamp = new Date().toISOString();
    current.failureReason = failureReason;
  }

  private async resolveProbeWorkflow(): Promise<WorkflowPreset> {
    const workflowId = this.runtimeConfig.imagePreloadWorkflowId || this.runtimeConfig.imageDefaultWorkflowId;
    try {
      return await this.workflowStore.get(workflowId);
    } catch {
      return this.workflowStore.get(this.runtimeConfig.imageDefaultWorkflowId);
    }
  }

  private buildSourceList(): GenerationSourceList {
    const workflows = this.workflowStore.getCachedWorkflows();
    const defaultWorkflow = workflows.find((workflow) => workflow.id === this.runtimeConfig.imageDefaultWorkflowId);
    const checkpointSources = [...this.checkpointProbeCache.values()]
      .filter((entry) => entry.status !== 'invalid')
      .sort((left, right) => left.checkpointName.localeCompare(right.checkpointName))
      .map((entry): GenerationSourceSummary => {
        const category = checkpointCategory(entry.model);
        return {
          id: entry.checkpointId,
          type: 'checkpoint',
          label: entry.checkpointName,
          displayLabel: entry.checkpointName,
          selectable: true,
          capabilityStatus: checkpointCapabilityStatus(entry.status),
          checkpointName: entry.checkpointName,
          checkpointId: entry.model.id,
          workflowId: this.runtimeConfig.imageDefaultWorkflowId,
          source: 'checkpoint-probe',
          probeStatus: entry.status,
          category,
          promptStyle: inferCheckpointPromptStyle(entry.model, category.name),
          ...(defaultWorkflow ? { constraints: constraintsFromWorkflow(defaultWorkflow, 'workflow-defaults') } : {}),
          capabilities: {
            textToImage: true,
            supportsSeed: true,
            supportsCheckpoint: true,
            sourceWorkflowId: this.runtimeConfig.imageDefaultWorkflowId
          }
        };
      });

    const workflowResults = workflows.filter(isStandaloneWorkflowSource).map((workflow) => ({ workflow, compatibility: workflowCompatibility(workflow) }));
    const workflowSources = workflowResults
      .filter((item) => item.compatibility.ok)
      .sort((left, right) => left.workflow.name.localeCompare(right.workflow.name))
      .map(({ workflow, compatibility }): GenerationSourceSummary => ({
        id: workflowSourceId(workflow),
        type: 'workflow',
        label: workflow.name || workflow.id,
        displayLabel: workflow.name || workflow.id,
        selectable: true,
        capabilityStatus: 'valid',
        workflowId: workflow.id,
        workflowName: workflow.name,
        ...(compatibility.checkpointName ? { checkpointName: compatibility.checkpointName } : {}),
        source: 'workflow-registry',
        category: workflowCategory(workflow),
        promptStyle: workflowPromptStyle(workflow, compatibility.checkpointName),
        constraints: constraintsFromWorkflow(workflow, workflow.metadata?.constraints ? 'manifest' : 'workflow-defaults'),
        capabilities: {
          textToImage: true,
          supportsSeed: compatibility.supportsSeed,
          supportsCheckpoint: compatibility.supportsCheckpoint,
          sourceWorkflowId: workflow.id
        }
      }));

    const sources = [...checkpointSources, ...workflowSources];
    return {
      ok: true,
      refreshedAt: new Date().toISOString(),
      sources,
      sourceGroups: {
        checkpoints: checkpointSources,
        workflows: workflowSources
      },
      status: this.buildStatus(workflowResults)
    };
  }

  private buildStatus(workflowResults: Array<{ workflow: WorkflowPreset; compatibility: WorkflowCompatibility }>): GenerationSourceListStatus {
    const counts = { pending: 0, valid: 0, invalid: 0, error: 0 };
    for (const entry of this.checkpointProbeCache.values()) {
      counts[entry.status] += 1;
    }
    const validWorkflows = workflowResults.filter((item) => item.compatibility.ok).length;
    return {
      checkpointProbe: {
        active: Boolean(this.activeProbeRun),
        total: this.checkpointProbeCache.size,
        pending: counts.pending,
        valid: counts.valid,
        invalid: counts.invalid,
        error: counts.error,
        lastStartedAt: this.lastStartedAt,
        lastCompletedAt: this.lastCompletedAt,
        lastError: this.lastError
      },
      workflows: {
        total: workflowResults.length,
        valid: validWorkflows,
        invalid: workflowResults.length - validWorkflows
      }
    };
  }
}

export function checkpointSourceId(model: ModelInventoryItem): string {
  return `checkpoint:${model.id}`;
}

export function workflowSourceId(workflow: WorkflowPreset): string {
  return `workflow:${workflow.id}`;
}

export function sourceMatchesCheckpoint(source: GenerationSourceSummary, model: string): boolean {
  if (source.type !== 'checkpoint') return false;
  const normalized = normalizeProviderCheckpointName(model);
  return Boolean(normalized) && [source.checkpointName, source.label, source.displayLabel, source.id]
    .filter((value): value is string => typeof value === 'string')
    .some((value) => normalizeProviderCheckpointName(value) === normalized);
}


const UNCATEGORIZED_SOURCE_CATEGORY = 'Uncategorized';

function checkpointCategory(model: ModelInventoryItem): GenerationSourceCategoryMetadata {
  const pathSegments = model.comfyName.split('/').filter(Boolean);
  const relativeSegments = model.relativePath.split('/').filter(Boolean);
  const displaySegments = pathSegments.length > 1 ? pathSegments : relativeSegments;
  const categoryName = categoryNameFromPathSegments(displaySegments);
  const name = categoryName || UNCATEGORIZED_SOURCE_CATEGORY;
  return {
    name,
    origin: categoryName ? 'folder' : 'fallback',
    ...(categoryName ? { path: displaySegments.slice(0, -1).join('/') } : {})
  };
}

function workflowCategory(workflow: WorkflowPreset): GenerationSourceCategoryMetadata {
  const configured = workflow.metadata?.category?.trim();
  const name = configured || 'Workflow';
  return {
    name,
    origin: configured ? 'manifest' : 'fallback'
  };
}

function categoryNameFromPathSegments(segments: string[]): string | null {
  const cleaned = segments.map((segment) => segment.trim()).filter(Boolean);
  if (cleaned.length <= 1) return null;
  const folders = cleaned.slice(0, -1).filter((segment) => !isCheckpointRootSegment(segment));
  if (folders.length === 0) return null;
  if (folders.length === 1) return folders[0]!;
  return folders.slice(0, 2).join(' / ');
}

function isCheckpointRootSegment(value: string): boolean {
  return ['checkpoints', 'checkpoint', 'models', 'model'].includes(value.trim().toLowerCase());
}

function inferCheckpointPromptStyle(model: ModelInventoryItem, categoryName: string): GenerationSourcePromptStyleMetadata {
  const text = [model.relativePath, model.comfyName, model.fileName, model.displayName, categoryName].join(' ');
  return inferPromptStyle(text, 'filename');
}

function workflowPromptStyle(workflow: WorkflowPreset, checkpointName: string | null): GenerationSourcePromptStyleMetadata {
  const explicit = workflow.metadata?.promptStyle?.trim();
  if (explicit) {
    return { value: explicit, origin: 'manifest', confidence: 'explicit' };
  }
  if (workflowContainsClass(workflow, 'FluxGuidance')) {
    return { value: 'Flux', origin: 'workflow', confidence: 'inferred' };
  }
  const fromText = inferPromptStyle([workflow.id, workflow.name, workflow.description, checkpointName ?? ''].join(' '), 'workflow');
  return fromText;
}

function inferPromptStyle(text: string, origin: GenerationSourcePromptStyleMetadata['origin']): GenerationSourcePromptStyleMetadata {
  const normalized = text.toLowerCase();
  const matches: Array<[RegExp, string]> = [
    [/(^|[^a-z0-9])flux([^a-z0-9]|$)|schnell|flux1|flux-dev|flux_dev/iu, 'Flux'],
    [/(^|[^a-z0-9])pony([^a-z0-9]|$)|ponyxl|pony-xl/iu, 'Pony'],
    [/illustrious/iu, 'Illustrious'],
    [/sdxl|sd_xl|stable[_.\-\s]?diffusion[_.\-\s]?xl|xl[_.\-\s]?base|juggernaut[_.\-\s]?xl|realvis[_.\-\s]?xl/iu, 'SDXL'],
    [/sd[_.\-\s]?1[_.\-\s]?5|stable[_.\-\s]?diffusion[_.\-\s]?1[_.\-\s]?5|v1[_.\-\s]?5/iu, 'SD 1.5'],
    [/anime|animagine|waifu|anything[_.\-\s]?v\d|cetus|counterfeit/iu, 'Anime']
  ];
  for (const [pattern, value] of matches) {
    if (pattern.test(normalized)) return { value, origin, confidence: 'inferred' };
  }
  return { value: 'Unknown', origin: 'unknown', confidence: 'unknown' };
}

function workflowContainsClass(workflow: WorkflowPreset, classType: string): boolean {
  return Object.values(workflow.comfyui.prompt).some((node) => isRecord(node) && node.class_type === classType);
}

function constraintsFromWorkflow(workflow: WorkflowPreset, origin: GenerationSourceConstraintMetadata['origin']): GenerationSourceConstraintMetadata {
  const explicit = workflow.metadata?.constraints;
  const steps = explicit?.steps ?? (workflow.defaults.steps !== undefined ? `default ${workflow.defaults.steps}` : undefined);
  const cfgScale = explicit?.cfgScale ?? (workflow.defaults.cfgScale !== undefined ? `default ${workflow.defaults.cfgScale}` : undefined);
  const resolution = explicit?.resolution ?? ((workflow.defaults.width !== undefined && workflow.defaults.height !== undefined) ? `default ${workflow.defaults.width}x${workflow.defaults.height}` : undefined);
  const notes = explicit?.notes;
  return {
    ...(steps ? { steps } : {}),
    ...(cfgScale ? { cfgScale } : {}),
    ...(resolution ? { resolution } : {}),
    ...(notes && notes.length > 0 ? { notes } : {}),
    origin
  };
}

function isEligibleCheckpointCandidate(model: ModelInventoryItem): boolean {
  if (model.type !== 'checkpoint') return false;
  if (!CHECKPOINT_EXTENSIONS.has(model.extension.toLowerCase())) return false;
  if (!model.fileName || OPERATIONAL_STATUS_PATTERN.test(model.fileName) || OPERATIONAL_STATUS_PATTERN.test(model.displayName)) return false;
  if (NON_CHECKPOINT_NAME_PATTERN.test(model.fileName)) return false;
  const segments = model.relativePath.toLowerCase().split(/[\\/]+/u).filter(Boolean);
  if (segments.some((segment) => NON_CHECKPOINT_PATH_SEGMENTS.has(segment))) return false;
  return true;
}

function checkpointCapabilityStatus(status: CheckpointProbeStatus): GenerationSourceSummary['capabilityStatus'] {
  if (status === 'valid') return 'valid';
  if (status === 'error') return 'probe_error';
  return 'candidate';
}

function isStandaloneWorkflowSource(workflow: WorkflowPreset): boolean {
  return workflow.source === 'file';
}

function checkpointSignature(model: ModelInventoryItem): string {
  return [model.path, model.modifiedAt ?? '', model.sizeBytes ?? ''].join('|');
}

function checkpointListedByProvider(entry: CheckpointProbeCacheEntry, providerNames: Set<string>): boolean {
  return [entry.checkpointName, entry.model.comfyName, entry.model.fileName, entry.model.relativePath]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .some((name) => providerNames.has(normalizeProviderCheckpointName(name)));
}

function normalizeProviderCheckpointName(value: string): string {
  return value.trim().replace(/\\/gu, '/').toLowerCase();
}

function workflowCompatibility(workflow: WorkflowPreset): WorkflowCompatibility {
  const prompt = workflow.comfyui.prompt;
  const mappings = workflow.comfyui.mappings;
  const positiveNode = mappings.positivePromptNode ?? findNodeId(prompt, 'CLIPTextEncode', 0);
  const negativeNode = mappings.negativePromptNode ?? findNodeId(prompt, 'CLIPTextEncode', 1);
  const latentNode = mappings.latentImageNode ?? findNodeId(prompt, 'EmptyLatentImage', 0);
  const samplerNode = mappings.samplerNode ?? findNodeId(prompt, 'KSampler', 0);
  const saveNode = mappings.saveImageNode ?? findNodeId(prompt, 'SaveImage', 0);
  const checkpointNode = mappings.checkpointNode ?? findNodeId(prompt, 'CheckpointLoaderSimple', 0);
  const checkpointName = workflow.defaults.checkpoint ?? readNodeInputString(prompt, checkpointNode, 'ckpt_name');
  const splitControlNode = mappings.seedNode
    ?? mappings.stepsNode
    ?? mappings.cfgNode
    ?? mappings.samplerNameNode
    ?? mappings.schedulerNode
    ?? findNodeId(prompt, 'RandomNoise', 0)
    ?? findNodeId(prompt, 'BasicScheduler', 0)
    ?? findNodeId(prompt, 'FluxGuidance', 0)
    ?? findNodeId(prompt, 'KSamplerSelect', 0);

  if (!positiveNode || !nodeExists(prompt, positiveNode)) return incompatible('Workflow is missing a positive prompt text node mapping.');
  if (!negativeNode || !nodeExists(prompt, negativeNode)) return incompatible('Workflow is missing a negative prompt text node mapping.');
  if (!latentNode || !nodeExists(prompt, latentNode)) return incompatible('Workflow is missing an EmptyLatentImage-compatible width/height mapping.');
  if ((!samplerNode || !nodeExists(prompt, samplerNode)) && (!splitControlNode || !nodeExists(prompt, splitControlNode))) {
    return incompatible('Workflow is missing sampler/control mappings for seed, steps, and CFG.');
  }
  if (!saveNode || !nodeExists(prompt, saveNode)) return incompatible('Workflow is missing a SaveImage-compatible output mapping.');
  if (checkpointNode && !nodeExists(prompt, checkpointNode)) return incompatible('Workflow checkpoint mapping points to a missing node.');
  if ((workflow.parameters.includes('model') || checkpointNode) && !checkpointName) {
    return incompatible('Workflow uses a checkpoint but does not provide a default checkpoint for one-selector generation.');
  }

  return {
    ok: true,
    reason: null,
    checkpointName,
    supportsCheckpoint: Boolean(checkpointNode),
    supportsSeed: true
  };
}

function incompatible(reason: string): WorkflowCompatibility {
  return {
    ok: false,
    reason,
    checkpointName: null,
    supportsCheckpoint: false,
    supportsSeed: false
  };
}

function nodeExists(prompt: Record<string, unknown>, nodeId: string): boolean {
  return isRecord(prompt[nodeId]);
}

function readNodeInputString(prompt: Record<string, unknown>, nodeId: string | undefined, key: string): string | null {
  if (!nodeId) return null;
  const node = prompt[nodeId];
  if (!isRecord(node) || !isRecord(node.inputs)) return null;
  const value = node.inputs[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function findNodeId(prompt: Record<string, unknown>, classType: string, occurrence: number): string | undefined {
  let seen = 0;
  for (const [nodeId, node] of Object.entries(prompt)) {
    if (!isRecord(node) || node.class_type !== classType) continue;
    if (seen === occurrence) return nodeId;
    seen += 1;
  }
  return undefined;
}

function probeDimension(value: number): number {
  const bounded = Math.max(64, Math.min(128, Math.floor(value || 64)));
  return bounded - (bounded % 8);
}

function errorSummary(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: 'GENERATION_SOURCE_PROBE_FAILED', message: error.message };
  }
  return { code: 'GENERATION_SOURCE_PROBE_FAILED', message: 'Unknown generation source probe failure.' };
}

function isProviderUnavailableError(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  return error.code === 'COMFYUI_UNAVAILABLE' || error.code === 'COMFYUI_TIMEOUT';
}

function isInvalidPromptError(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (error.code !== 'COMFYUI_REQUEST_FAILED') return false;
  return error.statusCode === 400 || (isRecord(error.details) && error.details.status === 400);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
