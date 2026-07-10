export type ImageBackendName = 'comfyui' | 'mock';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type OutputDelivery = 'metadata' | 'url' | 'base64' | 'binary';
export type ModelInstallType = 'checkpoint' | 'lora' | 'vae' | 'controlnet' | 'upscaler' | 'other';
export type ModelDownloadStatus = 'queued' | 'downloading' | 'succeeded' | 'failed' | 'canceled';
export type GenerationSourceType = 'checkpoint' | 'workflow';
export type CheckpointProbeStatus = 'pending' | 'valid' | 'invalid' | 'error';
export type GenerationSourceMetadataOrigin = 'manifest' | 'folder' | 'filename' | 'workflow' | 'workflow-defaults' | 'inferred' | 'user' | 'fallback' | 'unknown';
export type ImagePromptLlmRequestFormat = 'openai_chat' | 'ollama_chat' | 'ollama_generate' | 'simple_json';

export interface ImagePromptLlmSettings {
  enabled: boolean;
  endpoint_url: string;
  health_url: string;
  request_timeout_ms: number;
  request_format: ImagePromptLlmRequestFormat;
  instruction: string;
  temperature: number | null;
  max_tokens: number | null;
}


export interface RuntimeConfig {
  host: string;
  port: number;
  legacyOllamaEnabled: boolean;
  ollamaBaseUrl: string;
  ollamaRequestTimeoutMs: number;
  configPath: string;
  defaultModel: string;
  prewarmDefaultModelOnStart: boolean;
  prewarmTimeoutMs: number;
  prewarmKeepAlive: string | number;
  imageGenerationEnabled: boolean;
  imageGenerationTimeoutMs: number;
  imageGenerationMaxPromptChars: number;
  gpuQueryTimeoutMs: number;
  logLevel: string;

  imageBackend: ImageBackendName;
  imageApiKeys: string[];
  requireImageApiAuth: boolean;
  comfyUiBaseUrl: string;
  comfyUiRequestTimeoutMs: number;
  comfyUiPollIntervalMs: number;
  imageModelPaths: string[];
  imageWorkflowPath: string;
  imageArtifactPath: string;
  imageArtifactPublicBaseUrl: string;
  favoriteImagePromptsPath: string;
  imageFavoritesPath: string;
  generationSourceMetadataPath: string;
  imageDefaultModel: string;
  imageDefaultWorkflowId: string;
  imagePreloadDefaultOnStartup: boolean;
  imagePreloadTimeoutMs: number;
  imagePreloadWorkflowId: string;
  imagePreloadWidth: number;
  imagePreloadHeight: number;
  imagePreloadSteps: number;
  imagePreloadKeepArtifact: boolean;
  imageQueueConcurrency: number;
  imageMaxQueuedJobs: number;
  imageDefaultSyncTimeoutMs: number;
  imageMaxSyncTimeoutMs: number;
  imageMockDelayMs: number;

  modelInstallsEnabled: boolean;
  modelInstallMaxBytes: number;
  modelInstallAllowCkpt: boolean;
  modelCatalogPath: string;
  modelDownloadMetadataPath: string;
  modelInstallDirectories: Record<ModelInstallType, string>;

  llmImagePromptEnabled: boolean;
  llmImagePromptEndpointUrl: string;
  llmImagePromptHealthUrl: string;
  llmImagePromptRequestTimeoutMs: number;
  llmImagePromptRequestFormat: ImagePromptLlmRequestFormat;
  llmImagePromptInstruction: string;
  llmImagePromptTemperature: number | null;
  llmImagePromptMaxTokens: number | null;
}


export interface AppConfig {
  default_model: string;
  image_default_model?: string;
  image_preload_default_on_startup?: boolean;
  llm_image_prompt?: ImagePromptLlmSettings;
}


export interface OllamaModelDetails {
  parent_model?: string;
  format?: string;
  family?: string;
  families?: string[];
  parameter_size?: string;
  quantization_level?: string;
  [key: string]: unknown;
}

export interface OllamaRunningModel {
  name?: string;
  model?: string;
  size?: number;
  digest?: string;
  details?: OllamaModelDetails;
  expires_at?: string;
  size_vram?: number;
  context_length?: number;
  [key: string]: unknown;
}

export interface OllamaInstalledModel {
  name?: string;
  model?: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  details?: OllamaModelDetails;
  capabilities?: string[];
  [key: string]: unknown;
}

export interface OllamaModelInformation {
  details?: OllamaModelDetails;
  capabilities?: string[];
  model_info?: Record<string, unknown>;
  modelInfo?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GeneratedImageData {
  mimeType: string;
  base64: string;
  width?: number;
  height?: number;
}

export interface OllamaImageGenerateOptions {
  width?: number;
  height?: number;
  steps?: number;
}

export type ImageGenerationOptions = OllamaImageGenerateOptions;

export interface OllamaImageGenerateRequest extends OllamaImageGenerateOptions {
  model: string;
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProviderJobId?: (providerJobId: string) => void;
}

export interface OllamaImageGenerateResult {
  model: string;
  images: GeneratedImageData[];
  metadata: Record<string, unknown>;
}

export interface GpuTelemetry {
  index: number;
  uuid: string | null;
  name: string;
  driver_version: string | null;
  memory_total_mib: number | null;
  memory_used_mib: number | null;
  memory_free_mib: number | null;
  utilization_gpu_percent: number | null;
  temperature_c: number | null;
  power_draw_w: number | null;
  power_limit_w: number | null;
  warnings?: string[];
}

export interface LegacyGpuTelemetry {
  name: string;
  driver_version: string | null;
  memory_total_mib: number | null;
  memory_used_mib: number | null;
  memory_free_mib: number | null;
  utilization_gpu_percent: number | null;
  temperature_c: number | null;
  power_draw_w: number | null;
  power_limit_w: number | null;
}

export interface PrewarmResult {
  model: string;
  response?: unknown;
}

export interface OllamaClientLike {
  getVersion(): Promise<string | null>;
  listRunningModels(): Promise<OllamaRunningModel[]>;
  listInstalledModels(): Promise<OllamaInstalledModel[]>;
  showModel(model: string): Promise<OllamaModelInformation>;
  prewarmModel(model: string, keepAlive: string | number, timeoutMs?: number): Promise<PrewarmResult>;
  generateImage(request: OllamaImageGenerateRequest): Promise<OllamaImageGenerateResult>;
}

export interface BuildImagePromptRequest {
  guidance: string;
}

export interface BuildImagePromptResponse {
  prompt: string;
  modelInfo?: string | null;
  elapsedMs?: number;
}

export interface GpuServiceLike {
  queryGpus(): Promise<GpuTelemetry[]>;
}

export interface ModelInventoryItem {
  id: string;
  name: string;
  displayName: string;
  fileName: string;
  type: string;
  category: string;
  path: string;
  rootPath: string;
  relativePath: string;
  comfyName: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
  extension: string;
}

export interface ModelInventory {
  ok: true;
  refreshedAt: string;
  paths: string[];
  models: ModelInventoryItem[];
  defaultModel?: string | null;
  defaultWorkflowId?: string;
}

export interface GenerationSourceCapabilities {
  textToImage: true;
  supportsSeed: boolean;
  supportsCheckpoint: boolean;
  sourceWorkflowId?: string;
}

export interface GenerationSourceCategoryMetadata {
  name: string;
  color?: string;
  origin: GenerationSourceMetadataOrigin;
  path?: string;
}

export interface GenerationSourcePromptStyleMetadata {
  value: string;
  origin: GenerationSourceMetadataOrigin;
  confidence: 'explicit' | 'inferred' | 'unknown';
}

export interface GenerationSourceConstraintMetadata {
  steps?: string;
  cfgScale?: string;
  resolution?: string;
  notes?: string[];
  origin: GenerationSourceMetadataOrigin;
}

export interface GenerationSourceUserMetadata {
  sourceId: string;
  favorite: boolean;
  notes: string;
  rating: number;
  userCategory: string;
  promptStyleOverride?: string | null;
  categoryOverride?: string | null;
  colorOverride?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationSourceSummary {
  id: string;
  type: GenerationSourceType;
  label: string;
  displayLabel: string;
  selectable: boolean;
  capabilityStatus: 'candidate' | 'valid' | 'probe_error';
  capabilities: GenerationSourceCapabilities;
  workflowId: string;
  workflowName?: string;
  checkpointName?: string;
  checkpointId?: string;
  probeStatus?: CheckpointProbeStatus;
  source: 'checkpoint-probe' | 'workflow-registry';
  category?: GenerationSourceCategoryMetadata;
  promptStyle?: GenerationSourcePromptStyleMetadata;
  constraints?: GenerationSourceConstraintMetadata;
  userMetadata?: GenerationSourceUserMetadata;
}

export interface GenerationSourceListStatus {
  checkpointProbe: {
    active: boolean;
    total: number;
    pending: number;
    valid: number;
    invalid: number;
    error: number;
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    lastError: { code: string; message: string } | null;
  };
  workflows: {
    total: number;
    valid: number;
    invalid: number;
  };
}

export interface GenerationSourceList {
  ok: true;
  refreshedAt: string;
  sources: GenerationSourceSummary[];
  sourceGroups: {
    checkpoints: GenerationSourceSummary[];
    workflows: GenerationSourceSummary[];
  };
  status: GenerationSourceListStatus;
  sourceMetadata?: GenerationSourceUserMetadata[];
  sourceMetadataStatus?: {
    ok: boolean;
    error?: { code: string; message: string };
  };
}

export interface WorkflowPresetDefaults {
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  seed?: number;
  samplerName?: string;
  scheduler?: string;
  checkpoint?: string;
}

export interface WorkflowPresetMetadata {
  category?: string;
  promptStyle?: string;
  constraints?: {
    steps?: string;
    cfgScale?: string;
    resolution?: string;
    notes?: string[];
  };
}

export interface ComfyUiWorkflowMapping {
  positivePromptNode?: string;
  negativePromptNode?: string;
  checkpointNode?: string;
  latentImageNode?: string;
  samplerNode?: string;
  saveImageNode?: string;
  seedNode?: string;
  seedInput?: string;
  stepsNode?: string;
  stepsInput?: string;
  cfgNode?: string;
  cfgInput?: string;
  samplerNameNode?: string;
  samplerNameInput?: string;
  schedulerNode?: string;
  schedulerInput?: string;
}

export interface WorkflowPreset {
  id: string;
  name: string;
  description: string;
  engine: 'comfyui';
  defaults: WorkflowPresetDefaults;
  parameters: string[];
  source: 'builtin' | 'file';
  filePath?: string;
  metadata?: WorkflowPresetMetadata;
  comfyui: {
    prompt: Record<string, unknown>;
    mappings: ComfyUiWorkflowMapping;
  };
}

export interface NormalizedGenerationRequest {
  prompt: string;
  negativePrompt: string;
  model: string | null;
  workflowId: string;
  generationSourceType: GenerationSourceType;
  generationSourceId: string;
  generationSourceLabel: string;
  checkpointName: string | null;
  workflowSourceId: string | null;
  width: number;
  height: number;
  steps: number;
  cfgScale: number;
  seed: number;
  samplerName: string;
  scheduler: string;
  output: OutputDelivery;
  syncTimeoutMs: number;
  metadata: Record<string, unknown>;
}

export interface ImageArtifactData {
  mimeType: string;
  buffer: Buffer;
  width?: number;
  height?: number;
  providerMetadata?: Record<string, unknown>;
}

export interface FavoriteImagePrompt {
  id: string;
  title: string;
  description?: string | null;
  requestPayload: Record<string, unknown>;
  prompt: string;
  negativePrompt?: string | null;
  llmImagePromptGuidance?: string | null;
  promptPreview: string;
  negativePromptPreview?: string | null;
  llmImagePromptGuidancePreview?: string | null;
  model?: string | null;
  workflow?: string | null;
  workflowId?: string | null;
  generationSourceType?: GenerationSourceType | null;
  generationSourceId?: string | null;
  generationSourceLabel?: string | null;
  sampler?: string | null;
  scheduler?: string | null;
  width?: number | null;
  height?: number | null;
  steps?: number | null;
  cfgScale?: number | null;
  seed?: string | number | null;
  createdAt: string;
  updatedAt: string;
}


export interface ImageFavorite {
  id: string;
  title: string;
  description?: string | null;
  requestPayload: Record<string, unknown>;
  prompt: string;
  negativePrompt?: string | null;
  llmImagePromptGuidance?: string | null;
  promptPreview: string;
  negativePromptPreview?: string | null;
  llmImagePromptGuidancePreview?: string | null;
  model?: string | null;
  workflow?: string | null;
  workflowId?: string | null;
  generationSourceType?: GenerationSourceType | null;
  generationSourceId?: string | null;
  generationSourceLabel?: string | null;
  sampler?: string | null;
  scheduler?: string | null;
  width?: number | null;
  height?: number | null;
  steps?: number | null;
  cfgScale?: number | null;
  seed?: string | number | null;
  imageUrl?: string | null;
  artifactId?: string | null;
  jobId?: string | null;
  artifact?: Record<string, unknown> | null;
  job?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactMetadata {
  id: string;
  jobId: string;
  fileName: string;
  filePath: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  createdAt: string;
  provider: string;
  workflowId: string;
  model: string | null;
  generationSourceType: GenerationSourceType;
  generationSourceId: string;
  generationSourceLabel: string;
  prompt: string;
  negativePrompt?: string;
  seed: number;
  request: Record<string, unknown>;
  requestPayload?: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
  job?: {
    id: string;
    status: JobStatus;
    createdAt: string;
    queuedAt: string;
    startedAt: string | null;
    completedAt: string | null;
    timings: JobTimingMetrics;
  };
}

export interface ImageProviderHealth {
  ok: boolean;
  provider: string;
  baseUrl?: string;
  version?: string | null;
  queue?: Record<string, unknown>;
  details?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export interface ProviderGenerationRequest extends NormalizedGenerationRequest {
  jobId: string;
  workflow: WorkflowPreset;
  filenamePrefix: string;
  signal?: AbortSignal;
  onProviderJobId?: (providerJobId: string) => void;
}

export interface ProviderGenerationResult {
  provider: string;
  providerJobId?: string;
  images: ImageArtifactData[];
  metadata: Record<string, unknown>;
}

export interface ImageGenerationProvider {
  readonly name: string;
  health(): Promise<ImageProviderHealth>;
  generate(request: ProviderGenerationRequest): Promise<ProviderGenerationResult>;
  listCheckpoints?(): Promise<string[]>;
  cancel?(providerJobId?: string | null): Promise<void>;
}

export interface ImageJob {
  id: string;
  status: JobStatus;
  request: NormalizedGenerationRequest;
  requestPayload?: Record<string, unknown>;
  clientId: string | null;
  createdAt: string;
  submittedAt: string;
  updatedAt: string;
  startedAt: string | null;
  queuedAt: string;
  completedAt: string | null;
  cancelRequestedAt: string | null;
  canceledAt: string | null;
  cancellationReason: string | null;
  provider: string;
  providerJobId: string | null;
  workflowId: string;
  model: string | null;
  generationSourceType: GenerationSourceType;
  generationSourceId: string;
  generationSourceLabel: string;
  artifacts: ArtifactMetadata[];
  error: { code: string; message: string; details?: unknown } | null;
  metadata: Record<string, unknown>;
}

export interface PublicArtifactMetadata extends Omit<ArtifactMetadata, 'filePath'> {}

export interface ImageJobSummary {
  id: string;
  status: JobStatus;
  clientId: string | null;
  createdAt: string;
  submittedAt: string;
  updatedAt: string;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelRequestedAt: string | null;
  canceledAt: string | null;
  cancellationReason: string | null;
  provider: string;
  providerJobId: string | null;
  workflowId: string;
  model: string | null;
  generationSourceType: GenerationSourceType;
  generationSourceId: string;
  generationSourceLabel: string;
  prompt: string;
  negativePrompt: string;
  seed: number;
  width: number;
  height: number;
  steps: number;
  cfgScale: number;
  samplerName: string;
  scheduler: string;
  output: OutputDelivery;
  artifactCount: number;
  artifactSizes: number[];
  artifacts: PublicArtifactMetadata[];
  thumbnailUrl: string | null;
  request: NormalizedGenerationRequest;
  requestPayload?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  timings: JobTimingMetrics;
  queueWaitMs: number | null;
  executionMs: number | null;
  totalMs: number | null;
  secondsPerStep: number | null;
  stepsPerSecond: number | null;
  error: ImageJob['error'];
}

export interface JobTimingMetrics {
  queueWaitMs: number | null;
  executionMs: number | null;
  totalMs: number | null;
  secondsPerStep: number | null;
  stepsPerSecond: number | null;
}

export interface ModelCatalogEntry {
  id: string;
  name: string;
  description?: string;
  type: ModelInstallType | string;
  base?: string;
  recommendedFor?: string[];
  minimumVramGb?: number;
  license?: string;
  sourceName?: string;
  sourceUrl?: string;
  downloadUrl?: string;
  fileName?: string;
  notes?: string;
  tags?: string[];
}

export interface ModelDownloadJob {
  id: string;
  status: ModelDownloadStatus;
  type: ModelInstallType;
  sourceUrl: string;
  finalUrl: string | null;
  fileName: string;
  destinationDirectory: string;
  destinationPath: string;
  tempPath: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  totalBytes: number | null;
  downloadedBytes: number;
  progress: number | null;
  overwrite: boolean;
  setDefault: boolean;
  defaultModelName: string | null;
  warnings: string[];
  error: { code: string; message: string; details?: unknown } | null;
}

export interface QueueStats {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  canceled: number;
  total: number;
  concurrency: number;
  maxQueuedJobs: number;
}
