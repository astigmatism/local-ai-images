import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../errors.ts';
import type { ImageFavorite } from '../../types.ts';

const MAX_TITLE_CHARS = 140;
const MAX_DESCRIPTION_CHARS = 2000;
const PREVIEW_CHARS = 240;

export class ImageFavoriteStore {
  private readonly filePath: string;
  private readonly maxPromptChars: number;

  constructor(filePath: string, maxPromptChars: number) {
    this.filePath = filePath;
    this.maxPromptChars = maxPromptChars;
  }

  get path(): string {
    return this.filePath;
  }

  async list(limit = 250): Promise<ImageFavorite[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 250);
    const favorites = await this.readAll();
    return favorites
      .sort(compareFavoritesNewestFirst)
      .slice(0, boundedLimit)
      .map(cloneFavorite);
  }

  async get(id: string): Promise<ImageFavorite> {
    const favorite = (await this.readAll()).find((item) => item.id === id);
    if (!favorite) {
      throw new AppError('IMAGE_FAVORITE_NOT_FOUND', `Image favorite ${id} was not found.`, 404);
    }
    return cloneFavorite(favorite);
  }

  async create(body: unknown): Promise<ImageFavorite> {
    if (!isRecord(body)) {
      throw new AppError('IMAGE_FAVORITE_INVALID_REQUEST', 'Image favorite request must be a JSON object.', 422);
    }

    const requestPayload = readRequestPayload(body);
    const derived = deriveFields(requestPayload, this.maxPromptChars);
    const artifact = readArtifact(body);
    const job = readJob(body);
    const imageUrl = readStringFrom(body, ['image_url', 'imageUrl', 'url']) ?? stringField(artifact, 'url');
    const artifactId = readStringFrom(body, ['artifact_id', 'artifactId']) ?? stringField(artifact, 'id');
    const jobId = readStringFrom(body, ['job_id', 'jobId']) ?? stringField(job, 'id') ?? stringField(artifact, 'jobId') ?? stringField(artifact, 'job_id');
    const title = normalizeTitle(readNullableString(body.title ?? body.name, 'title'), derived.prompt, jobId);
    const description = normalizeDescription(body.description ?? body.notes);
    const now = new Date().toISOString();

    const favorite: ImageFavorite = {
      id: crypto.randomUUID(),
      title,
      ...(description !== undefined ? { description } : {}),
      requestPayload,
      ...derived,
      ...(imageUrl !== null ? { imageUrl } : {}),
      ...(artifactId !== null ? { artifactId } : {}),
      ...(jobId !== null ? { jobId } : {}),
      ...(artifact !== null ? { artifact } : {}),
      ...(job !== null ? { job } : {}),
      createdAt: now,
      updatedAt: now
    };

    const existing = await this.readAll();
    existing.push(favorite);
    await this.writeAll(existing);
    return cloneFavorite(favorite);
  }

  async update(id: string, body: unknown): Promise<ImageFavorite> {
    if (!isRecord(body)) {
      throw new AppError('IMAGE_FAVORITE_INVALID_REQUEST', 'Image favorite update must be a JSON object.', 422);
    }

    const favorites = await this.readAll();
    const index = favorites.findIndex((item) => item.id === id);
    if (index < 0) {
      throw new AppError('IMAGE_FAVORITE_NOT_FOUND', `Image favorite ${id} was not found.`, 404);
    }

    const existing = favorites[index]!;
    let next: ImageFavorite = cloneFavorite(existing);

    if (hasOwn(body, 'title') || hasOwn(body, 'name')) {
      const titleValue = body.title ?? body.name;
      if (typeof titleValue !== 'string' || titleValue.trim() === '') {
        throw new AppError('IMAGE_FAVORITE_INVALID_TITLE', 'Image favorite title must be a non-empty string.', 422);
      }
      next.title = limitText(titleValue.trim(), MAX_TITLE_CHARS);
    }

    if (hasOwn(body, 'description') || hasOwn(body, 'notes')) {
      next.description = normalizeDescription(body.description ?? body.notes);
    }

    if (hasRequestPayload(body)) {
      const requestPayload = readRequestPayload(body);
      next = {
        ...next,
        requestPayload,
        ...deriveFields(requestPayload, this.maxPromptChars)
      };
    }

    if (hasOwn(body, 'artifact') || hasOwn(body, 'artifact_metadata') || hasOwn(body, 'artifactMetadata') || hasOwn(body, 'job')) {
      const artifact = readArtifact(body);
      const job = readJob(body);
      next.artifact = artifact;
      next.job = job;
      next.imageUrl = readStringFrom(body, ['image_url', 'imageUrl', 'url']) ?? stringField(artifact, 'url') ?? next.imageUrl ?? null;
      next.artifactId = readStringFrom(body, ['artifact_id', 'artifactId']) ?? stringField(artifact, 'id') ?? next.artifactId ?? null;
      next.jobId = readStringFrom(body, ['job_id', 'jobId']) ?? stringField(job, 'id') ?? stringField(artifact, 'jobId') ?? stringField(artifact, 'job_id') ?? next.jobId ?? null;
    }

    next.updatedAt = new Date().toISOString();
    favorites[index] = next;
    await this.writeAll(favorites);
    return cloneFavorite(next);
  }

  async delete(id: string): Promise<ImageFavorite> {
    const favorites = await this.readAll();
    const index = favorites.findIndex((item) => item.id === id);
    if (index < 0) {
      throw new AppError('IMAGE_FAVORITE_NOT_FOUND', `Image favorite ${id} was not found.`, 404);
    }
    const [deleted] = favorites.splice(index, 1);
    await this.writeAll(favorites);
    return cloneFavorite(deleted!);
  }

  private async readAll(): Promise<ImageFavorite[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const records = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.favorites)
          ? parsed.favorites
          : [];
      return records.map((record) => normalizeStoredFavorite(record, this.maxPromptChars)).filter(isImageFavorite).map(cloneFavorite);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      if (error instanceof SyntaxError) {
        throw new AppError('IMAGE_FAVORITES_READ_FAILED', `Image favorites file is not valid JSON: ${this.filePath}`, 500, { path: this.filePath });
      }
      throw new AppError('IMAGE_FAVORITES_READ_FAILED', `Unable to read image favorites file: ${this.filePath}`, 500, {
        path: this.filePath,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async writeAll(favorites: ImageFavorite[]): Promise<void> {
    const directory = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const normalized = favorites.filter(isImageFavorite).sort(compareFavoritesNewestFirst);

    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      await fs.rename(tempPath, this.filePath);
    } catch (error: unknown) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw new AppError('IMAGE_FAVORITES_WRITE_FAILED', `Unable to write image favorites file: ${this.filePath}`, 500, {
        path: this.filePath,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

interface DerivedFields {
  prompt: string;
  negativePrompt: string | null;
  promptPreview: string;
  negativePromptPreview: string | null;
  model: string | null;
  workflow: string | null;
  workflowId: string | null;
  sampler: string | null;
  scheduler: string | null;
  width: number | null;
  height: number | null;
  steps: number | null;
  cfgScale: number | null;
  seed: string | number | null;
}

function readRequestPayload(body: Record<string, unknown>): Record<string, unknown> {
  const candidate = body.request_payload ?? body.requestPayload ?? body.payload ?? body.request;
  if (isRecord(candidate)) return cloneRecord(candidate);

  const job = isRecord(body.job) ? body.job : null;
  const jobPayload = job?.requestPayload ?? job?.request_payload ?? job?.request;
  if (isRecord(jobPayload)) return cloneRecord(jobPayload);

  const artifact = readArtifact(body);
  const artifactPayload = artifact?.requestPayload ?? artifact?.request_payload ?? artifact?.request;
  if (isRecord(artifactPayload)) return cloneRecord(artifactPayload);

  throw new AppError('IMAGE_FAVORITE_PAYLOAD_REQUIRED', 'request_payload/requestPayload must be a JSON object, or a job/artifact with a request payload must be provided.', 422);
}

function hasRequestPayload(body: Record<string, unknown>): boolean {
  return hasOwn(body, 'request_payload') || hasOwn(body, 'requestPayload') || hasOwn(body, 'payload') || hasOwn(body, 'request');
}

function deriveFields(payload: Record<string, unknown>, maxPromptChars: number): DerivedFields {
  const prompt = firstString(payload, ['prompt', 'positive_prompt', 'positivePrompt']) ?? '';
  if (prompt.length > maxPromptChars) {
    throw new AppError('IMAGE_FAVORITE_PROMPT_TOO_LONG', `Prompt must be ${maxPromptChars} characters or fewer.`, 422, { max_prompt_chars: maxPromptChars });
  }
  const negativePrompt = firstString(payload, ['negative_prompt', 'negativePrompt']) ?? null;
  if (negativePrompt && negativePrompt.length > maxPromptChars) {
    throw new AppError('IMAGE_FAVORITE_NEGATIVE_TOO_LONG', `Negative prompt must be ${maxPromptChars} characters or fewer.`, 422, { max_prompt_chars: maxPromptChars });
  }

  const workflowId = firstString(payload, ['workflow_id', 'workflowId', 'workflow']) ?? null;
  return {
    prompt,
    negativePrompt,
    promptPreview: previewText(prompt),
    negativePromptPreview: negativePrompt ? previewText(negativePrompt) : null,
    model: firstString(payload, ['model', 'checkpoint', 'checkpoint_name', 'checkpointName']),
    workflow: workflowId,
    workflowId,
    sampler: firstString(payload, ['sampler_name', 'samplerName', 'sampler']),
    scheduler: firstString(payload, ['scheduler']),
    width: firstFiniteNumber(payload, ['width']),
    height: firstFiniteNumber(payload, ['height']),
    steps: firstFiniteNumber(payload, ['steps']),
    cfgScale: firstFiniteNumber(payload, ['cfg_scale', 'cfgScale', 'guidance_scale', 'guidanceScale']),
    seed: firstSeed(payload, ['seed'])
  };
}

function readArtifact(body: Record<string, unknown>): Record<string, unknown> | null {
  const direct = body.artifact ?? body.artifact_metadata ?? body.artifactMetadata;
  if (isRecord(direct)) return cloneRecord(direct);
  const job = isRecord(body.job) ? body.job : null;
  const artifacts = Array.isArray(job?.artifacts) ? job.artifacts : [];
  const first = artifacts.find(isRecord);
  return first ? cloneRecord(first) : null;
}

function readJob(body: Record<string, unknown>): Record<string, unknown> | null {
  return isRecord(body.job) ? cloneRecord(body.job) : null;
}

function normalizeStoredFavorite(value: unknown, maxPromptChars: number): ImageFavorite | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.requestPayload)) return null;
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString();
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : createdAt;
  let derived: DerivedFields;
  try {
    derived = deriveFields(value.requestPayload, maxPromptChars);
  } catch {
    derived = {
      prompt: typeof value.prompt === 'string' ? value.prompt : '',
      negativePrompt: typeof value.negativePrompt === 'string' ? value.negativePrompt : null,
      promptPreview: typeof value.promptPreview === 'string' ? value.promptPreview : '',
      negativePromptPreview: typeof value.negativePromptPreview === 'string' ? value.negativePromptPreview : null,
      model: null,
      workflow: null,
      workflowId: null,
      sampler: null,
      scheduler: null,
      width: null,
      height: null,
      steps: null,
      cfgScale: null,
      seed: null
    };
  }

  return {
    id: value.id,
    title: typeof value.title === 'string' && value.title.trim() ? value.title : normalizeTitle(null, derived.prompt, stringField(value, 'jobId')),
    ...(hasOwn(value, 'description') ? { description: typeof value.description === 'string' || value.description === null ? value.description : null } : {}),
    requestPayload: cloneRecord(value.requestPayload),
    ...derived,
    ...(readOptionalStoredString(value, 'imageUrl') !== undefined ? { imageUrl: readOptionalStoredString(value, 'imageUrl') } : {}),
    ...(readOptionalStoredString(value, 'artifactId') !== undefined ? { artifactId: readOptionalStoredString(value, 'artifactId') } : {}),
    ...(readOptionalStoredString(value, 'jobId') !== undefined ? { jobId: readOptionalStoredString(value, 'jobId') } : {}),
    ...(isRecord(value.artifact) || value.artifact === null ? { artifact: value.artifact === null ? null : cloneRecord(value.artifact) } : {}),
    ...(isRecord(value.job) || value.job === null ? { job: value.job === null ? null : cloneRecord(value.job) } : {}),
    createdAt,
    updatedAt
  };
}

function readOptionalStoredString(record: Record<string, unknown>, key: string): string | null | undefined {
  if (!hasOwn(record, key)) return undefined;
  const value = record[key];
  if (value === null) return null;
  return typeof value === 'string' ? value : null;
}

function normalizeTitle(value: string | null, prompt: string, jobId?: string | null): string {
  const compactPrompt = previewText(prompt).replace(/\s+/gu, ' ').trim();
  const fallback = compactPrompt || (jobId ? `Image job ${jobId}` : 'Untitled image favorite');
  return limitText(value?.trim() || fallback, MAX_TITLE_CHARS);
}

function normalizeDescription(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new AppError('IMAGE_FAVORITE_INVALID_DESCRIPTION', 'Image favorite description must be a string or null.', 422);
  }
  const trimmed = value.trim();
  return trimmed ? limitText(trimmed, MAX_DESCRIPTION_CHARS) : null;
}

function readNullableString(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new AppError('IMAGE_FAVORITE_INVALID_TITLE', `Image favorite ${fieldName} must be a string.`, 422);
  }
  return value;
}

function previewText(value: string): string {
  return limitText(value.replace(/\s+/gu, ' ').trim(), PREVIEW_CHARS);
}

function limitText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function firstFiniteNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function firstSeed(record: Record<string, unknown>, keys: string[]): string | number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function readStringFrom(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function compareFavoritesNewestFirst(left: ImageFavorite, right: ImageFavorite): number {
  const leftValue = Date.parse(left.updatedAt || left.createdAt);
  const rightValue = Date.parse(right.updatedAt || right.createdAt);
  if (Number.isFinite(leftValue) && Number.isFinite(rightValue) && leftValue !== rightValue) {
    return rightValue - leftValue;
  }
  return right.id.localeCompare(left.id);
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  } catch (error: unknown) {
    throw new AppError('IMAGE_FAVORITE_PAYLOAD_NOT_JSON', 'Saved generation request payload must be JSON-serializable.', 422, {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

function cloneFavorite(favorite: ImageFavorite): ImageFavorite {
  return JSON.parse(JSON.stringify(favorite)) as ImageFavorite;
}

function isImageFavorite(value: unknown): value is ImageFavorite {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.title === 'string'
    && isRecord(value.requestPayload)
    && typeof value.prompt === 'string'
    && typeof value.promptPreview === 'string'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
