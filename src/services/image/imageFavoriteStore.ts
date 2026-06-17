import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../errors.ts';
import type { ImageFavorite } from '../../types.ts';

const MAX_TITLE_CHARS = 140;
const MAX_DESCRIPTION_CHARS = 2000;
const PROMPT_PREVIEW_CHARS = 240;
const MAX_FAVORITES = 1000;

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
    const derived = deriveFavoriteFields(requestPayload, this.maxPromptChars);
    const imageFields = deriveImageFields(body);
    const title = normalizeTitle(readNullableString(body.title ?? body.name, 'title'), derived.prompt);
    const description = normalizeDescription(body.description ?? body.notes);
    const now = new Date().toISOString();
    const favorite: ImageFavorite = {
      id: crypto.randomUUID(),
      title,
      ...(description !== undefined ? { description } : {}),
      requestPayload,
      ...derived,
      ...imageFields,
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
      const derived = deriveFavoriteFields(requestPayload, this.maxPromptChars);
      next = {
        ...next,
        requestPayload,
        ...derived
      };
    }

    if (hasImageFields(body)) {
      next = {
        ...next,
        ...deriveImageFields(body)
      };
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

    const [removed] = favorites.splice(index, 1);
    await this.writeAll(favorites);
    return cloneFavorite(removed!);
  }

  private async readAll(): Promise<ImageFavorite[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        throw new AppError('IMAGE_FAVORITES_READ_FAILED', `Image favorites file must contain an array: ${this.filePath}`, 500, { path: this.filePath });
      }
      return parsed.filter(isImageFavorite).map(cloneFavorite);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      if (error instanceof AppError) throw error;
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
    const normalized = favorites
      .filter(isImageFavorite)
      .sort(compareFavoritesNewestFirst)
      .slice(0, MAX_FAVORITES);

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

interface DerivedFavoriteFields {
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

interface DerivedImageFields {
  artifactId: string | null;
  artifactUrl: string | null;
  imageUrl: string | null;
  jobId: string | null;
  artifact: Record<string, unknown> | null;
  artifacts: Record<string, unknown>[];
  job: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

function readRequestPayload(body: Record<string, unknown>): Record<string, unknown> {
  const candidate = body.request_payload ?? body.requestPayload ?? body.payload ?? body.request;
  if (!isRecord(candidate)) {
    throw new AppError('IMAGE_FAVORITE_PAYLOAD_REQUIRED', 'request_payload/requestPayload must be a JSON object.', 422);
  }
  return cloneRecord(candidate);
}

function hasRequestPayload(body: Record<string, unknown>): boolean {
  return hasOwn(body, 'request_payload') || hasOwn(body, 'requestPayload') || hasOwn(body, 'payload') || hasOwn(body, 'request');
}

function hasImageFields(body: Record<string, unknown>): boolean {
  return hasOwn(body, 'artifact')
    || hasOwn(body, 'imageArtifact')
    || hasOwn(body, 'artifacts')
    || hasOwn(body, 'artifact_id')
    || hasOwn(body, 'artifactId')
    || hasOwn(body, 'artifact_url')
    || hasOwn(body, 'artifactUrl')
    || hasOwn(body, 'image_url')
    || hasOwn(body, 'imageUrl')
    || hasOwn(body, 'job')
    || hasOwn(body, 'metadata');
}

function deriveFavoriteFields(payload: Record<string, unknown>, maxPromptChars: number): DerivedFavoriteFields {
  const prompt = firstString(payload, ['prompt', 'positive_prompt', 'positivePrompt']);
  if (!prompt) {
    throw new AppError('IMAGE_FAVORITE_PROMPT_REQUIRED', 'Saved generation request payload must include a non-empty prompt.', 422);
  }
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

function deriveImageFields(body: Record<string, unknown>): DerivedImageFields {
  const artifact = isRecord(body.artifact)
    ? cloneRecord(body.artifact)
    : isRecord(body.imageArtifact)
      ? cloneRecord(body.imageArtifact)
      : null;
  const artifacts = Array.isArray(body.artifacts)
    ? body.artifacts.filter(isRecord).map((item) => cloneRecord(item))
    : artifact
      ? [cloneRecord(artifact)]
      : [];
  const firstArtifact = artifact ?? artifacts[0] ?? null;
  const job = isRecord(body.job) ? cloneRecord(body.job) : null;
  const metadata = isRecord(body.metadata) ? cloneRecord(body.metadata) : null;
  const artifactId = readFirstStringFromValues([
    body.artifact_id,
    body.artifactId,
    firstArtifact?.id,
    firstArtifact?.artifactId
  ]);
  const imageUrl = readFirstStringFromValues([
    body.image_url,
    body.imageUrl,
    body.artifact_url,
    body.artifactUrl,
    firstArtifact?.url,
    firstArtifact?.imageUrl,
    firstArtifact?.artifactUrl
  ]);
  const jobId = readFirstStringFromValues([
    body.job_id,
    body.jobId,
    firstArtifact?.jobId,
    firstArtifact?.job_id,
    job?.id
  ]);

  return {
    artifactId,
    artifactUrl: imageUrl,
    imageUrl,
    jobId,
    artifact,
    artifacts,
    job,
    metadata
  };
}

function normalizeTitle(value: string | null, prompt: string): string {
  const title = value?.trim() || defaultTitleFromPrompt(prompt);
  return limitText(title, MAX_TITLE_CHARS);
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

function defaultTitleFromPrompt(prompt: string): string {
  const title = previewText(prompt).replace(/\s+/gu, ' ').trim();
  return title || 'Untitled image favorite';
}

function previewText(value: string): string {
  return limitText(value.replace(/\s+/gu, ' ').trim(), PROMPT_PREVIEW_CHARS);
}

function limitText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
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

function readFirstStringFromValues(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  } catch (error: unknown) {
    throw new AppError('IMAGE_FAVORITE_PAYLOAD_NOT_JSON', 'Saved image favorite payload must be JSON-serializable.', 422, {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

function cloneFavorite(favorite: ImageFavorite): ImageFavorite {
  return JSON.parse(JSON.stringify(favorite)) as ImageFavorite;
}

function compareFavoritesNewestFirst(left: ImageFavorite, right: ImageFavorite): number {
  return String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt));
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
