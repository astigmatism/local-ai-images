export type ImageBackendName = 'comfyui' | 'mock';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type OutputDelivery = 'metadata' | 'url' | 'base64' | 'binary';

export interface RuntimeConfig {
  host: string;
  port: number;
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
  imageDefaultWorkflowId: string;
  imageQueueConcurrency: number;
  imageMaxQueuedJobs: number;
  imageDefaultSyncTimeoutMs: number;
  imageMaxSyncTimeoutMs: number;
  imageMockDelayMs: number;
}

export interface AppConfig {
  default_model: string;
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

export interface GpuServiceLike {
  queryGpus(): Promise<GpuTelemetry[]>;
}

export interface ModelInventoryItem {
  id: string;
  name: string;
  type: string;
  path: string;
  relativePath: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
  extension: string;
}

export interface ModelInventory {
  ok: true;
  refreshedAt: string;
  paths: string[];
  models: ModelInventoryItem[];
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

export interface ComfyUiWorkflowMapping {
  positivePromptNode?: string;
  negativePromptNode?: string;
  checkpointNode?: string;
  latentImageNode?: string;
  samplerNode?: string;
  saveImageNode?: string;
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
  prompt: string;
  negativePrompt?: string;
  seed: number;
  request: Record<string, unknown>;
  providerMetadata?: Record<string, unknown>;
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
  cancel?(providerJobId?: string): Promise<void>;
}

export interface ImageJob {
  id: string;
  status: JobStatus;
  request: NormalizedGenerationRequest;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  provider: string;
  providerJobId: string | null;
  workflowId: string;
  model: string | null;
  artifacts: ArtifactMetadata[];
  error: { code: string; message: string; details?: unknown } | null;
  metadata: Record<string, unknown>;
}

export interface ImageJobSummary {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  provider: string;
  workflowId: string;
  model: string | null;
  artifactCount: number;
  error: ImageJob['error'];
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
