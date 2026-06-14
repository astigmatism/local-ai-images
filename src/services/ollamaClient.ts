import { AppError } from '../errors.ts';
import type {
  GeneratedImageData,
  OllamaClientLike,
  OllamaImageGenerateRequest,
  OllamaImageGenerateResult,
  OllamaInstalledModel,
  OllamaModelInformation,
  OllamaRunningModel,
  PrewarmResult
} from '../types.ts';

interface OllamaTagsResponse {
  models?: OllamaInstalledModel[];
}

interface OllamaPsResponse {
  models?: OllamaRunningModel[];
}

interface OllamaVersionResponse {
  version?: string;
}

interface OllamaShowResponse extends OllamaModelInformation {}

const allowedImageMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

export class OllamaClient implements OllamaClientLike {
  private readonly baseUrl: string;
  private readonly defaultTimeoutMs: number;

  constructor(baseUrl: string, defaultTimeoutMs: number) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async getVersion(): Promise<string | null> {
    try {
      const response = await this.request<OllamaVersionResponse>('/api/version', { method: 'GET' });
      return typeof response.version === 'string' ? response.version : null;
    } catch (error: unknown) {
      if (error instanceof AppError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async listRunningModels(): Promise<OllamaRunningModel[]> {
    const response = await this.request<OllamaPsResponse>('/api/ps', { method: 'GET' });
    return Array.isArray(response.models) ? response.models : [];
  }

  async listInstalledModels(): Promise<OllamaInstalledModel[]> {
    const response = await this.request<OllamaTagsResponse>('/api/tags', { method: 'GET' });
    return Array.isArray(response.models) ? response.models : [];
  }

  async showModel(model: string): Promise<OllamaModelInformation> {
    return this.request<OllamaShowResponse>('/api/show', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model })
    });
  }

  async prewarmModel(model: string, keepAlive: string | number, timeoutMs = this.defaultTimeoutMs): Promise<PrewarmResult> {
    const response = await this.request<unknown>('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: keepAlive
      })
    }, timeoutMs);

    return { model, response };
  }

  async generateImage(request: OllamaImageGenerateRequest): Promise<OllamaImageGenerateResult> {
    const payload: Record<string, unknown> = {
      model: request.model,
      prompt: request.prompt,
      stream: false
    };

    if (request.width !== undefined) payload.width = request.width;
    if (request.height !== undefined) payload.height = request.height;
    if (request.steps !== undefined) payload.steps = request.steps;

    const response = await this.request<unknown>('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }, request.timeoutMs ?? this.defaultTimeoutMs, request.signal);

    return parseOllamaImageGenerationResponse(response, request.model);
  }

  private async request<T>(path: string, init: RequestInit, timeoutMs = this.defaultTimeoutMs, externalSignal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    let timeoutElapsed = false;
    const timeout = setTimeout(() => {
      timeoutElapsed = true;
      controller.abort();
    }, timeoutMs);
    const abortFromExternalSignal = () => controller.abort(externalSignal?.reason);

    if (externalSignal?.aborted) {
      abortFromExternalSignal();
    } else {
      externalSignal?.addEventListener('abort', abortFromExternalSignal, { once: true });
    }

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal
      });

      const text = await response.text();
      const body = parseMaybeJson(text);

      if (!response.ok) {
        throw errorFromOllamaStatus(response.status, body, path);
      }

      return body as T;
    } catch (error: unknown) {
      if (isAbortError(error)) {
        if (!timeoutElapsed && externalSignal?.aborted) {
          throw new AppError('OLLAMA_REQUEST_ABORTED', 'Ollama request was canceled by the caller.', 499, {
            base_url: this.baseUrl,
            path
          });
        }

        throw new AppError('OLLAMA_TIMEOUT', `Timed out talking to Ollama after ${timeoutMs}ms`, 504, {
          base_url: this.baseUrl,
          path
        });
      }

      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError('OLLAMA_UNAVAILABLE', 'Unable to connect to Ollama', 503, {
        base_url: this.baseUrl,
        path,
        cause: error instanceof Error ? error.message : String(error)
      });
    } finally {
      externalSignal?.removeEventListener('abort', abortFromExternalSignal);
      clearTimeout(timeout);
    }
  }
}

export function parseOllamaImageGenerationResponse(body: unknown, requestedModel: string): OllamaImageGenerateResult {
  const records = extractResponseRecords(body);
  const finalRecord = [...records].reverse().find((record) => hasImagePayload(record)) ?? records.at(-1);

  if (!finalRecord) {
    throw new AppError('OLLAMA_IMAGE_RESPONSE_EMPTY', 'Ollama returned an empty image-generation response.', 502, {
      model: requestedModel
    });
  }

  const images = extractImages(finalRecord);
  if (images.length === 0) {
    throw new AppError('OLLAMA_IMAGE_NOT_RETURNED', 'Ollama completed the image-generation request without image data. Verify the selected Ollama model reports capability "image" and that this Ollama version supports image generation.', 502, {
      model: requestedModel,
      done: finalRecord.done,
      done_reason: finalRecord.done_reason
    });
  }

  const metadata: Record<string, unknown> = { ...finalRecord };
  delete metadata.image;
  delete metadata.images;
  delete metadata.response;

  return {
    model: typeof finalRecord.model === 'string' && finalRecord.model.trim() ? finalRecord.model.trim() : requestedModel,
    images,
    metadata
  };
}

function extractResponseRecords(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) {
    return body.filter(isRecord);
  }

  if (isRecord(body)) {
    if (typeof body.raw === 'string') {
      return parseNdjsonRecords(body.raw);
    }
    return [body];
  }

  if (typeof body === 'string') {
    return parseNdjsonRecords(body);
  }

  return [];
}

function parseNdjsonRecords(raw: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // Ignore malformed progress lines; the caller will raise if no image is found.
    }
  }
  return records;
}

function hasImagePayload(record: Record<string, unknown>): boolean {
  return typeof record.image === 'string' || Array.isArray(record.images);
}

function extractImages(record: Record<string, unknown>): GeneratedImageData[] {
  const candidates: unknown[] = [];
  if (record.image !== undefined) candidates.push(record.image);
  if (Array.isArray(record.images)) candidates.push(...record.images);

  return candidates.map((candidate) => normalizeImage(candidate, record)).filter((image): image is GeneratedImageData => image !== null);
}

function normalizeImage(candidate: unknown, parentRecord: Record<string, unknown>): GeneratedImageData | null {
  if (typeof candidate === 'string') {
    return normalizeBase64Image(candidate, {
      mimeType: readString(parentRecord.mimeType ?? parentRecord.mime_type ?? parentRecord.content_type),
      width: readNumber(parentRecord.width),
      height: readNumber(parentRecord.height)
    });
  }

  const record = isRecord(candidate) ? candidate : null;
  if (!record) return null;

  const base64 = readString(record.base64 ?? record.image ?? record.data ?? record.b64_json);
  if (!base64) return null;

  return normalizeBase64Image(base64, {
    mimeType: readString(record.mimeType ?? record.mime_type ?? record.content_type ?? parentRecord.mimeType ?? parentRecord.mime_type),
    width: readNumber(record.width ?? parentRecord.width),
    height: readNumber(record.height ?? parentRecord.height)
  });
}

function normalizeBase64Image(value: string, hints: { mimeType?: string; width?: number; height?: number }): GeneratedImageData {
  const { mimeType: mimeFromDataUrl, base64 } = stripDataUrl(value);
  const cleanedBase64 = base64.replace(/\s+/gu, '');
  const buffer = Buffer.from(cleanedBase64, 'base64');

  if (buffer.length === 0 || buffer.toString('base64').replace(/=+$/u, '') !== cleanedBase64.replace(/=+$/u, '')) {
    throw new AppError('OLLAMA_IMAGE_INVALID_BASE64', 'Ollama returned invalid base64 image data.', 502);
  }

  const inferredMimeType = inferMimeType(buffer);
  const mimeType = mimeFromDataUrl ?? normalizeMimeType(hints.mimeType) ?? inferredMimeType;

  if (!mimeType || !allowedImageMimeTypes.has(mimeType)) {
    throw new AppError('OLLAMA_IMAGE_UNSUPPORTED_MIME', 'Ollama returned an unsupported image MIME type.', 502, {
      mimeType: mimeType ?? null
    });
  }

  return {
    mimeType,
    base64: buffer.toString('base64'),
    ...(hints.width !== undefined ? { width: hints.width } : {}),
    ...(hints.height !== undefined ? { height: hints.height } : {})
  };
}

function stripDataUrl(value: string): { mimeType?: string; base64: string } {
  const match = /^data:([^;,]+);base64,(.*)$/isu.exec(value.trim());
  if (!match) return { base64: value.trim() };
  return { mimeType: normalizeMimeType(match[1]), base64: match[2] ?? '' };
}

function inferMimeType(buffer: Buffer): string | undefined {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}

function normalizeMimeType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'image/jpg') return 'image/jpeg';
  return normalized || undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseMaybeJson(text: string): unknown {
  if (text.trim() === '') {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function errorFromOllamaStatus(status: number, body: unknown, path: string): AppError {
  const message = extractOllamaMessage(body) ?? `Ollama returned HTTP ${status}`;

  if (status === 404) {
    return new AppError('OLLAMA_MODEL_NOT_FOUND', message, 404, { path, response: body });
  }

  if (status === 408 || status === 504) {
    return new AppError('OLLAMA_TIMEOUT', message, 504, { path, response: body });
  }

  return new AppError('OLLAMA_REQUEST_FAILED', message, status >= 400 && status < 600 ? status : 502, {
    path,
    response: body
  });
}

function extractOllamaMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.error === 'string') {
      return record.error;
    }
    if (typeof record.message === 'string') {
      return record.message;
    }
    if (typeof record.status === 'string') {
      return record.status;
    }
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
