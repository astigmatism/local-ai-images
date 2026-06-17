import fs from 'node:fs';
import path from 'node:path';
import type { ImageBackendName, ModelInstallType, RuntimeConfig } from '../types.ts';

loadDotEnvFile(path.resolve(process.cwd(), '.env'));

function loadDotEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const equalsIndex = line.indexOf('=');
    if (equalsIndex < 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function readString(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function readOptionalString(name: string): string {
  const value = process.env[name];
  return value === undefined ? '' : value.trim();
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = readNumber(name, fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function readKeepAlive(name: string, fallback: string | number): string | number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const trimmed = raw.trim();
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) && trimmed !== '' ? numeric : trimmed;
}

function readPath(name: string, fallback: string): string {
  const configured = readString(name, fallback);
  return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
}

function readPathList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  const values = raw === undefined || raw.trim() === ''
    ? fallback
    : raw.split(/[,:;]/).map((item) => item.trim()).filter(Boolean);

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const resolved = path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    normalized.push(resolved);
  }
  return normalized;
}

function readSecretList(name: string): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return [];

  const values = raw
    .split(/[\n,;]/)
    .map((item) => item.trim())
    .filter(Boolean);

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function readImageBackend(): ImageBackendName {
  const value = readString('IMAGE_BACKEND', 'comfyui').toLowerCase();
  if (value === 'comfyui' || value === 'mock') {
    return value;
  }
  throw new Error('IMAGE_BACKEND must be either comfyui or mock');
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export function loadRuntimeConfig(): RuntimeConfig {
  const configPath = readPath('CONFIG_PATH', './config/local-ai-images.json');
  const artifactPath = readPath('IMAGE_ARTIFACT_PATH', './data/artifacts');
  const favoriteImagePromptsPath = readPath('FAVORITE_IMAGE_PROMPTS_PATH', path.join(path.dirname(configPath), 'favorite-image-prompts.json'));
  const imageFavoritesPath = readPath('IMAGE_FAVORITES_PATH', path.join(path.dirname(configPath), 'image-favorites.json'));
  const artifactPublicBaseUrl = readOptionalString('IMAGE_ARTIFACT_PUBLIC_BASE_URL') || '/api/v1/artifacts';
  const legacyOllamaEnabled = readBoolean('LEGACY_OLLAMA_ENABLED', false);
  const imageModelPaths = readPathList('IMAGE_MODEL_PATHS', ['./models']);
  const imageDefaultWorkflowId = readString('IMAGE_DEFAULT_WORKFLOW_ID', 'sdxl-text-to-image');
  const modelRoot = imageModelPaths[0] ?? path.resolve(process.cwd(), './models');
  const modelInstallDirectories: Record<ModelInstallType, string> = {
    checkpoint: readPath('COMFYUI_CHECKPOINT_PATH', path.join(modelRoot, 'checkpoints')),
    lora: readPath('COMFYUI_LORA_PATH', path.join(modelRoot, 'loras')),
    vae: readPath('COMFYUI_VAE_PATH', path.join(modelRoot, 'vae')),
    controlnet: readPath('COMFYUI_CONTROLNET_PATH', path.join(modelRoot, 'controlnet')),
    upscaler: readPath('COMFYUI_UPSCALER_PATH', path.join(modelRoot, 'upscale_models')),
    other: readPath('COMFYUI_OTHER_MODEL_PATH', modelRoot)
  };

  return {
    host: readString('HOST', '0.0.0.0'),
    port: readNumber('PORT', 3000),
    legacyOllamaEnabled,
    ollamaBaseUrl: normalizeBaseUrl(legacyOllamaEnabled ? readString('OLLAMA_BASE_URL', 'http://127.0.0.1:11434') : readOptionalString('OLLAMA_BASE_URL')),
    ollamaRequestTimeoutMs: readNumber('OLLAMA_REQUEST_TIMEOUT_MS', 30000),
    configPath,
    defaultModel: readOptionalString('DEFAULT_MODEL'),
    prewarmDefaultModelOnStart: legacyOllamaEnabled && readBoolean('PREWARM_DEFAULT_MODEL_ON_START', false),
    prewarmTimeoutMs: readNumber('PREWARM_TIMEOUT_MS', 120000),
    prewarmKeepAlive: readKeepAlive('PREWARM_KEEP_ALIVE', -1),
    imageGenerationEnabled: readBoolean('IMAGE_GENERATION_ENABLED', true),
    imageGenerationTimeoutMs: readNumber('IMAGE_GENERATION_TIMEOUT_MS', 600000),
    imageGenerationMaxPromptChars: readNumber('IMAGE_GENERATION_MAX_PROMPT_CHARS', 4000),
    gpuQueryTimeoutMs: readNumber('GPU_QUERY_TIMEOUT_MS', 5000),
    logLevel: readString('LOG_LEVEL', 'info'),

    imageBackend: readImageBackend(),
    imageApiKeys: readSecretList('IMAGE_API_KEYS'),
    requireImageApiAuth: readBoolean('REQUIRE_IMAGE_API_AUTH', false),
    comfyUiBaseUrl: normalizeBaseUrl(readString('COMFYUI_BASE_URL', 'http://127.0.0.1:8188')),
    comfyUiRequestTimeoutMs: readNumber('COMFYUI_REQUEST_TIMEOUT_MS', 600000),
    comfyUiPollIntervalMs: readNumber('COMFYUI_POLL_INTERVAL_MS', 1000),
    imageModelPaths,
    imageWorkflowPath: readPath('IMAGE_WORKFLOW_PATH', './config/workflows'),
    imageArtifactPath: artifactPath,
    imageArtifactPublicBaseUrl: normalizeBaseUrl(artifactPublicBaseUrl),
    favoriteImagePromptsPath,
    imageFavoritesPath,
    imageDefaultModel: readOptionalString('IMAGE_DEFAULT_MODEL'),
    imageDefaultWorkflowId,
    imagePreloadDefaultOnStartup: readBoolean('IMAGE_PRELOAD_DEFAULT_ON_STARTUP', false),
    imagePreloadTimeoutMs: readNumber('IMAGE_PRELOAD_TIMEOUT_MS', 120000),
    imagePreloadWorkflowId: readString('IMAGE_PRELOAD_WORKFLOW_ID', imageDefaultWorkflowId),
    imagePreloadWidth: readPositiveInteger('IMAGE_PRELOAD_WIDTH', 512),
    imagePreloadHeight: readPositiveInteger('IMAGE_PRELOAD_HEIGHT', 512),
    imagePreloadSteps: readPositiveInteger('IMAGE_PRELOAD_STEPS', 1),
    imagePreloadKeepArtifact: readBoolean('IMAGE_PRELOAD_KEEP_ARTIFACT', false),
    imageQueueConcurrency: readPositiveInteger('IMAGE_QUEUE_CONCURRENCY', 1),
    imageMaxQueuedJobs: readPositiveInteger('IMAGE_MAX_QUEUED_JOBS', 32),
    imageDefaultSyncTimeoutMs: readNumber('IMAGE_DEFAULT_SYNC_TIMEOUT_MS', 0),
    imageMaxSyncTimeoutMs: readNumber('IMAGE_MAX_SYNC_TIMEOUT_MS', 120000),
    imageMockDelayMs: readNumber('IMAGE_MOCK_DELAY_MS', 25),

    modelInstallsEnabled: readBoolean('MODEL_INSTALLS_ENABLED', false),
    modelInstallMaxBytes: readNumber('MODEL_INSTALL_MAX_BYTES', 20 * 1024 * 1024 * 1024),
    modelInstallAllowCkpt: readBoolean('MODEL_INSTALL_ALLOW_CKPT', false),
    modelCatalogPath: readPath('MODEL_CATALOG_PATH', './config/model-catalog.json'),
    modelDownloadMetadataPath: readPath('MODEL_DOWNLOAD_METADATA_PATH', path.join(path.dirname(configPath), 'model-downloads.json')),
    modelInstallDirectories
  };
}
