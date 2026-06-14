import fs from 'node:fs';
import path from 'node:path';
import type { ImageBackendName, RuntimeConfig } from '../types.ts';

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
  const artifactPublicBaseUrl = readOptionalString('IMAGE_ARTIFACT_PUBLIC_BASE_URL') || '/api/v1/artifacts';

  return {
    host: readString('HOST', '0.0.0.0'),
    port: readNumber('PORT', 8000),
    ollamaBaseUrl: normalizeBaseUrl(readString('OLLAMA_BASE_URL', 'http://127.0.0.1:11434')),
    ollamaRequestTimeoutMs: readNumber('OLLAMA_REQUEST_TIMEOUT_MS', 30000),
    configPath,
    defaultModel: readString('DEFAULT_MODEL', 'llama3.2:latest'),
    prewarmDefaultModelOnStart: readBoolean('PREWARM_DEFAULT_MODEL_ON_START', true),
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
    imageModelPaths: readPathList('IMAGE_MODEL_PATHS', ['./models']),
    imageWorkflowPath: readPath('IMAGE_WORKFLOW_PATH', './config/workflows'),
    imageArtifactPath: artifactPath,
    imageArtifactPublicBaseUrl: normalizeBaseUrl(artifactPublicBaseUrl),
    imageDefaultWorkflowId: readString('IMAGE_DEFAULT_WORKFLOW_ID', 'sdxl-text-to-image'),
    imageQueueConcurrency: readPositiveInteger('IMAGE_QUEUE_CONCURRENCY', 1),
    imageMaxQueuedJobs: readPositiveInteger('IMAGE_MAX_QUEUED_JOBS', 32),
    imageDefaultSyncTimeoutMs: readNumber('IMAGE_DEFAULT_SYNC_TIMEOUT_MS', 0),
    imageMaxSyncTimeoutMs: readNumber('IMAGE_MAX_SYNC_TIMEOUT_MS', 120000),
    imageMockDelayMs: readNumber('IMAGE_MOCK_DELAY_MS', 25)
  };
}
