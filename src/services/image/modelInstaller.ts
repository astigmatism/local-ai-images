import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from '../../errors.ts';
import type { ConfigStore } from '../../config/store.ts';
import type { Logger } from '../../logger.ts';
import type { ModelDownloadJob, ModelInstallType, RuntimeConfig } from '../../types.ts';
import { normalizeInstallType } from './modelCatalog.ts';
import { ModelScanner } from './modelScanner.ts';

const SAFE_FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,254}$/u;
const EXTENSIONS_BY_TYPE: Record<ModelInstallType, Set<string>> = {
  checkpoint: new Set(['.safetensors', '.ckpt']),
  lora: new Set(['.safetensors', '.pt', '.pth']),
  vae: new Set(['.safetensors', '.pt', '.pth', '.bin']),
  controlnet: new Set(['.safetensors', '.pt', '.pth']),
  upscaler: new Set(['.safetensors', '.pt', '.pth', '.onnx']),
  other: new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx'])
};

interface ModelInstallerOptions {
  runtimeConfig: RuntimeConfig;
  modelScanner: ModelScanner;
  configStore: ConfigStore;
  logger: Logger;
}

export class ModelInstaller {
  private readonly runtimeConfig: RuntimeConfig;
  private readonly modelScanner: ModelScanner;
  private readonly configStore: ConfigStore;
  private readonly logger: Logger;
  private readonly jobs = new Map<string, ModelDownloadJob>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(options: ModelInstallerOptions) {
    this.runtimeConfig = options.runtimeConfig;
    this.modelScanner = options.modelScanner;
    this.configStore = options.configStore;
    this.logger = options.logger;
  }

  async list(limit = 50): Promise<ModelDownloadJob[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 250);
    const inMemory = [...this.jobs.values()].map(cloneJob);
    const logged = await readDownloadLog(this.runtimeConfig.modelDownloadMetadataPath);
    const byId = new Map<string, ModelDownloadJob>();
    for (const job of logged) byId.set(job.id, job);
    for (const job of inMemory) byId.set(job.id, job);
    return [...byId.values()]
      .sort((left, right) => String(right.completedAt ?? right.createdAt).localeCompare(String(left.completedAt ?? left.createdAt)))
      .slice(0, boundedLimit);
  }

  get(jobId: string): ModelDownloadJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new AppError('MODEL_DOWNLOAD_NOT_FOUND', `Model download job ${jobId} was not found.`, 404);
    return cloneJob(job);
  }

  async start(body: unknown): Promise<ModelDownloadJob> {
    if (!this.runtimeConfig.modelInstallsEnabled) {
      throw new AppError('MODEL_INSTALLS_DISABLED', 'Model installs are disabled. Set MODEL_INSTALLS_ENABLED=true to enable model downloads from the portal.', 403);
    }

    const request = validateModelDownloadRequest(body, this.runtimeConfig);
    await fs.mkdir(request.destinationDirectory, { recursive: true });

    if (!request.overwrite && await exists(request.destinationPath)) {
      throw new AppError('MODEL_FILE_EXISTS', `Model file already exists: ${request.fileName}`, 409, {
        destination_path: request.destinationPath
      });
    }

    const now = new Date().toISOString();
    const job: ModelDownloadJob = {
      id: crypto.randomUUID(),
      status: 'queued',
      type: request.type,
      sourceUrl: request.url.toString(),
      finalUrl: null,
      fileName: request.fileName,
      destinationDirectory: request.destinationDirectory,
      destinationPath: request.destinationPath,
      tempPath: `${request.destinationPath}.${process.pid}.${Date.now()}.part`,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      totalBytes: null,
      downloadedBytes: 0,
      progress: null,
      overwrite: request.overwrite,
      setDefault: request.setDefault,
      defaultModelName: request.type === 'checkpoint' ? request.fileName : null,
      warnings: request.warnings,
      error: null
    };

    this.jobs.set(job.id, job);
    queueMicrotask(() => void this.runDownload(job.id, request.url));
    return cloneJob(job);
  }

  async cancel(jobId: string): Promise<ModelDownloadJob> {
    const job = this.jobs.get(jobId);
    if (!job) throw new AppError('MODEL_DOWNLOAD_NOT_FOUND', `Model download job ${jobId} was not found.`, 404);
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled') {
      return cloneJob(job);
    }

    this.controllers.get(jobId)?.abort();
    job.status = 'canceled';
    job.completedAt = new Date().toISOString();
    job.error = { code: 'MODEL_DOWNLOAD_CANCELED', message: 'Model download was canceled.' };
    await fs.rm(job.tempPath, { force: true }).catch(() => undefined);
    await this.recordCompleted(job);
    return cloneJob(job);
  }

  private async runDownload(jobId: string, url: URL): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    job.status = 'downloading';
    job.startedAt = new Date().toISOString();

    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok) {
        throw new AppError('MODEL_DOWNLOAD_HTTP_ERROR', `Model download returned HTTP ${response.status}.`, response.status >= 500 ? 502 : response.status, {
          status: response.status
        });
      }
      if (!response.body) {
        throw new AppError('MODEL_DOWNLOAD_EMPTY_RESPONSE', 'Model download response did not include a body.', 502);
      }

      job.finalUrl = response.url || job.sourceUrl;
      const totalBytes = readContentLength(response.headers.get('content-length'));
      if (totalBytes !== null) {
        job.totalBytes = totalBytes;
        if (totalBytes > this.runtimeConfig.modelInstallMaxBytes) {
          throw new AppError('MODEL_DOWNLOAD_TOO_LARGE', `Model download is larger than MODEL_INSTALL_MAX_BYTES (${this.runtimeConfig.modelInstallMaxBytes} bytes).`, 413, {
            total_bytes: totalBytes,
            max_bytes: this.runtimeConfig.modelInstallMaxBytes
          });
        }
        await ensureDiskSpace(job.destinationDirectory, totalBytes);
      }

      await fs.rm(job.tempPath, { force: true }).catch(() => undefined);
      const writeStream = createWriteStream(job.tempPath, { flags: 'wx' });
      let downloaded = 0;
      const meteredStream = Readable.fromWeb(response.body as any).map((chunk: Buffer | Uint8Array) => {
        downloaded += chunk.byteLength;
        job.downloadedBytes = downloaded;
        job.progress = job.totalBytes && job.totalBytes > 0 ? Math.min(1, downloaded / job.totalBytes) : null;
        if (downloaded > this.runtimeConfig.modelInstallMaxBytes) {
          throw new AppError('MODEL_DOWNLOAD_TOO_LARGE', `Model download exceeded MODEL_INSTALL_MAX_BYTES (${this.runtimeConfig.modelInstallMaxBytes} bytes).`, 413, {
            downloaded_bytes: downloaded,
            max_bytes: this.runtimeConfig.modelInstallMaxBytes
          });
        }
        return chunk;
      });
      await pipeline(meteredStream, writeStream);

      if (controller.signal.aborted || job.status === 'canceled') {
        throw new AppError('MODEL_DOWNLOAD_CANCELED', 'Model download was canceled.', 499);
      }

      await fs.rename(job.tempPath, job.destinationPath);
      job.progress = 1;
      await this.modelScanner.refresh();
      if (job.setDefault && job.type === 'checkpoint' && job.defaultModelName) {
        await this.configStore.updateImageDefaultModel(job.defaultModelName);
      }
      job.status = 'succeeded';
      job.completedAt = new Date().toISOString();
      await this.recordCompleted(job);
    } catch (error: unknown) {
      await fs.rm(job.tempPath, { force: true }).catch(() => undefined);
      if (job.status !== 'canceled') {
        job.status = error instanceof AppError && error.code === 'MODEL_DOWNLOAD_CANCELED' ? 'canceled' : 'failed';
        job.completedAt = new Date().toISOString();
        job.error = errorToJobError(error);
      }
      await this.recordCompleted(job).catch((recordError: unknown) => {
        this.logger.warn({ err: recordError, jobId }, 'Unable to persist model download metadata');
      });
      if (job.status === 'failed') {
        this.logger.warn({ err: error, jobId, fileName: job.fileName }, 'Model download failed');
      }
    } finally {
      this.controllers.delete(jobId);
    }
  }

  private async recordCompleted(job: ModelDownloadJob): Promise<void> {
    if (job.completedAt === null) return;
    const filePath = this.runtimeConfig.modelDownloadMetadataPath;
    const existing = await readDownloadLog(filePath);
    const withoutCurrent = existing.filter((item) => item.id !== job.id);
    withoutCurrent.push(cloneJob(job));
    withoutCurrent.sort((left, right) => String(right.completedAt ?? right.createdAt).localeCompare(String(left.completedAt ?? left.createdAt)));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(withoutCurrent.slice(0, 250), null, 2)}\n`, 'utf8');
  }
}

interface ValidatedDownloadRequest {
  url: URL;
  type: ModelInstallType;
  fileName: string;
  destinationDirectory: string;
  destinationPath: string;
  overwrite: boolean;
  setDefault: boolean;
  warnings: string[];
}

export function validateModelDownloadRequest(body: unknown, runtimeConfig: RuntimeConfig): ValidatedDownloadRequest {
  if (!isRecord(body)) {
    throw new AppError('MODEL_DOWNLOAD_INVALID_REQUEST', 'Model download request must be a JSON object.', 422);
  }

  const rawUrl = readString(body.url ?? body.download_url ?? body.downloadUrl);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError('MODEL_DOWNLOAD_INVALID_URL', 'Model download URL must be an absolute http(s) URL.', 422);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('MODEL_DOWNLOAD_INVALID_URL', 'Model download URL must use http or https.', 422, { protocol: url.protocol });
  }

  const type = normalizeInstallType(body.type ?? body.category ?? body.model_type ?? body.modelType);
  if (!type) {
    throw new AppError('MODEL_DOWNLOAD_UNSUPPORTED_TYPE', 'Model type must be checkpoint, LoRA, VAE, ControlNet, upscaler, or other.', 422);
  }

  const destinationDirectory = resolveDestinationDirectory(type, body.destination ?? body.destination_directory ?? body.destinationDirectory, runtimeConfig);
  const fileName = validateModelFileName(readString(body.file_name ?? body.fileName) || inferFileNameFromUrl(url));
  const extension = path.extname(fileName).toLowerCase();
  const warnings: string[] = [];
  validateExtension(type, extension, runtimeConfig, warnings);

  const destinationPath = path.resolve(destinationDirectory, fileName);
  ensureInsideDirectory(destinationDirectory, destinationPath);

  return {
    url,
    type,
    fileName,
    destinationDirectory,
    destinationPath,
    overwrite: readBoolean(body.overwrite, false),
    setDefault: readBoolean(body.set_default ?? body.setDefault, false),
    warnings
  };
}

function resolveDestinationDirectory(type: ModelInstallType, requested: unknown, runtimeConfig: RuntimeConfig): string {
  const approved = path.resolve(runtimeConfig.modelInstallDirectories[type]);
  if (typeof requested === 'string' && requested.trim()) {
    const resolved = path.resolve(requested.trim());
    if (resolved !== approved) {
      throw new AppError('MODEL_DOWNLOAD_UNSUPPORTED_DESTINATION', 'Requested destination is not an approved ComfyUI model directory for this model type.', 422, {
        requested: resolved,
        approved
      });
    }
  }
  return approved;
}

function validateModelFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed || trimmed.includes('\u0000') || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..' || trimmed.includes('..')) {
    throw new AppError('MODEL_DOWNLOAD_INVALID_FILENAME', 'Filename must be a plain file name with no path traversal.', 422, { file_name: fileName });
  }
  if (!SAFE_FILENAME.test(trimmed)) {
    throw new AppError('MODEL_DOWNLOAD_INVALID_FILENAME', 'Filename contains unsupported characters.', 422, { file_name: fileName });
  }
  return trimmed;
}

function validateExtension(type: ModelInstallType, extension: string, runtimeConfig: RuntimeConfig, warnings: string[]): void {
  if (!extension || !EXTENSIONS_BY_TYPE[type].has(extension)) {
    throw new AppError('MODEL_DOWNLOAD_UNSUPPORTED_EXTENSION', `Unsupported file extension for ${type} model downloads.`, 422, {
      extension,
      supported: [...EXTENSIONS_BY_TYPE[type]]
    });
  }
  if (extension === '.ckpt') {
    if (!runtimeConfig.modelInstallAllowCkpt) {
      throw new AppError('MODEL_DOWNLOAD_CKPT_DISABLED', '.ckpt downloads are disabled by default. Prefer .safetensors or set MODEL_INSTALL_ALLOW_CKPT=true after reviewing the source.', 422);
    }
    warnings.push('.ckpt is less preferred than .safetensors; only install files from trusted sources.');
  }
  if (type === 'checkpoint' && extension !== '.safetensors') {
    warnings.push('Checkpoints are safest and most portable as .safetensors when available.');
  }
}

function ensureInsideDirectory(directory: string, filePath: string): void {
  const relative = path.relative(path.resolve(directory), path.resolve(filePath));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppError('MODEL_DOWNLOAD_INVALID_DESTINATION', 'Resolved model destination is outside the approved model directory.', 422);
  }
}

function inferFileNameFromUrl(url: URL): string {
  const lastSegment = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
  if (!lastSegment) {
    throw new AppError('MODEL_DOWNLOAD_FILENAME_REQUIRED', 'Provide file_name when the URL path does not include a model filename.', 422);
  }
  return lastSegment;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  return fallback;
}

function readContentLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function ensureDiskSpace(directory: string, requiredBytes: number): Promise<void> {
  if (typeof fs.statfs !== 'function') return;
  try {
    const stats = await fs.statfs(directory);
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    if (Number.isFinite(availableBytes) && availableBytes < requiredBytes) {
      throw new AppError('MODEL_DOWNLOAD_LOW_DISK_SPACE', 'Destination filesystem does not have enough available space for this model download.', 507, {
        available_bytes: availableBytes,
        required_bytes: requiredBytes
      });
    }
  } catch (error: unknown) {
    if (error instanceof AppError) throw error;
  }
}

async function readDownloadLog(filePath: string): Promise<ModelDownloadJob[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isModelDownloadJob).map(cloneJob) : [];
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    return [];
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function errorToJobError(error: unknown): ModelDownloadJob['error'] {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details })
    };
  }
  if (isAbortError(error)) {
    return { code: 'MODEL_DOWNLOAD_CANCELED', message: 'Model download was canceled.' };
  }
  if (error instanceof Error) {
    return { code: 'MODEL_DOWNLOAD_FAILED', message: error.message };
  }
  return { code: 'MODEL_DOWNLOAD_FAILED', message: 'Unknown model download failure.' };
}

function isModelDownloadJob(value: unknown): value is ModelDownloadJob {
  return isRecord(value) && typeof value.id === 'string' && typeof value.status === 'string' && typeof value.fileName === 'string';
}

function cloneJob(job: ModelDownloadJob): ModelDownloadJob {
  return JSON.parse(JSON.stringify(job)) as ModelDownloadJob;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError';
}
