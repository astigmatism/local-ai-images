import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../errors.ts';
import type { FavoriteImagePrompt } from '../../types.ts';

const MAX_TITLE_CHARS = 140;
const MAX_DESCRIPTION_CHARS = 2000;
const PROMPT_PREVIEW_CHARS = 240;

export class FavoritePromptStore {
  private readonly filePath: string;
  private readonly maxPromptChars: number;

  constructor(filePath: string, maxPromptChars: number) {
    this.filePath = filePath;
    this.maxPromptChars = maxPromptChars;
  }

  get path(): string {
    return this.filePath;
  }

  async list(limit = 250): Promise<FavoriteImagePrompt[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 250);
    const favorites = await this.readAll();
    return favorites
      .sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)))
      .slice(0, boundedLimit)
      .map(cloneFavorite);
  }

  async get(id: string): Promise<FavoriteImagePrompt> {
    const favorite = (await this.readAll()).find((item) => item.id === id);
    if (!favorite) {
      throw new AppError('FAVORITE_PROMPT_NOT_FOUND', `Favorite prompt ${id} was not found.`, 404);
    }
    return cloneFavorite(favorite);
  }

  async create(body: unknown): Promise<FavoriteImagePrompt> {
    if (!isRecord(body)) {
      throw new AppError('FAVORITE_PROMPT_INVALID_REQUEST', 'Favorite prompt request must be a JSON object.', 422);
    }

    const requestPayload = readRequestPayload(body);
    const derived = deriveFavoriteFields(requestPayload, this.maxPromptChars);
    const title = normalizeTitle(readNullableString(body.title ?? body.name, 'title'), derived.prompt);
    const description = normalizeDescription(body.description ?? body.notes);
    const now = new Date().toISOString();
    const favorite: FavoriteImagePrompt = {
      id: crypto.randomUUID(),
      title,
      ...(description !== undefined ? { description } : {}),
      requestPayload,
      ...derived,
      createdAt: now,
      updatedAt: now
    };

    const existing = await this.readAll();
    existing.push(favorite);
    await this.writeAll(existing);
    return cloneFavorite(favorite);
  }

  async update(id: string, body: unknown): Promise<FavoriteImagePrompt> {
    if (!isRecord(body)) {
      throw new AppError('FAVORITE_PROMPT_INVALID_REQUEST', 'Favorite prompt update must be a JSON object.', 422);
    }

    const favorites = await this.readAll();
    const index = favorites.findIndex((item) => item.id === id);
    if (index < 0) {
      throw new AppError('FAVORITE_PROMPT_NOT_FOUND', `Favorite prompt ${id} was not found.`, 404);
    }

    const existing = favorites[index]!;
    let next: FavoriteImagePrompt = { ...existing, requestPayload: cloneRecord(existing.requestPayload) };

    if (hasOwn(body, 'title') || hasOwn(body, 'name')) {
      const titleValue = body.title ?? body.name;
      if (typeof titleValue !== 'string' || titleValue.trim() === '') {
        throw new AppError('FAVORITE_PROMPT_INVALID_TITLE', 'Favorite prompt title must be a non-empty string.', 422);
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

    next.updatedAt = new Date().toISOString();
    favorites[index] = next;
    await this.writeAll(favorites);
    return cloneFavorite(next);
  }

  async delete(id: string): Promise<FavoriteImagePrompt> {
    const favorites = await this.readAll();
    const index = favorites.findIndex((item) => item.id === id);
    if (index < 0) {
      throw new AppError('FAVORITE_PROMPT_NOT_FOUND', `Favorite prompt ${id} was not found.`, 404);
    }
    const [deleted] = favorites.splice(index, 1);
    await this.writeAll(favorites);
    return cloneFavorite(deleted!);
  }

  private async readAll(): Promise<FavoriteImagePrompt[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const records = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.favorites)
          ? parsed.favorites
          : [];
      return records.filter(isFavoriteImagePrompt).map(cloneFavorite);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      if (error instanceof SyntaxError) {
        throw new AppError('FAVORITE_PROMPTS_READ_FAILED', `Favorite prompts file is not valid JSON: ${this.filePath}`, 500, { path: this.filePath });
      }
      throw new AppError('FAVORITE_PROMPTS_READ_FAILED', `Unable to read favorite prompts file: ${this.filePath}`, 500, {
        path: this.filePath,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async writeAll(favorites: FavoriteImagePrompt[]): Promise<void> {
    const directory = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const normalized = favorites
      .filter(isFavoriteImagePrompt)
      .sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)));

    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      await fs.rename(tempPath, this.filePath);
    } catch (error: unknown) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw new AppError('FAVORITE_PROMPTS_WRITE_FAILED', `Unable to write favorite prompts file: ${this.filePath}`, 500, {
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

function readRequestPayload(body: Record<string, unknown>): Record<string, unknown> {
  const candidate = body.request_payload ?? body.requestPayload ?? body.payload ?? body.request;
  if (!isRecord(candidate)) {
    throw new AppError('FAVORITE_PROMPT_PAYLOAD_REQUIRED', 'request_payload/requestPayload must be a JSON object.', 422);
  }
  return cloneRecord(candidate);
}

function hasRequestPayload(body: Record<string, unknown>): boolean {
  return hasOwn(body, 'request_payload') || hasOwn(body, 'requestPayload') || hasOwn(body, 'payload') || hasOwn(body, 'request');
}

function deriveFavoriteFields(payload: Record<string, unknown>, maxPromptChars: number): DerivedFavoriteFields {
  const prompt = firstString(payload, ['prompt', 'positive_prompt', 'positivePrompt']);
  if (!prompt) {
    throw new AppError('FAVORITE_PROMPT_PROMPT_REQUIRED', 'Saved generation request payload must include a non-empty prompt.', 422);
  }
  if (prompt.length > maxPromptChars) {
    throw new AppError('FAVORITE_PROMPT_TOO_LONG', `Prompt must be ${maxPromptChars} characters or fewer.`, 422, { max_prompt_chars: maxPromptChars });
  }

  const negativePrompt = firstString(payload, ['negative_prompt', 'negativePrompt']) ?? null;
  if (negativePrompt && negativePrompt.length > maxPromptChars) {
    throw new AppError('FAVORITE_PROMPT_NEGATIVE_TOO_LONG', `Negative prompt must be ${maxPromptChars} characters or fewer.`, 422, { max_prompt_chars: maxPromptChars });
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

function normalizeTitle(value: string | null, prompt: string): string {
  const title = value?.trim() || defaultTitleFromPrompt(prompt);
  return limitText(title, MAX_TITLE_CHARS);
}

function normalizeDescription(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new AppError('FAVORITE_PROMPT_INVALID_DESCRIPTION', 'Favorite prompt description must be a string or null.', 422);
  }
  const trimmed = value.trim();
  return trimmed ? limitText(trimmed, MAX_DESCRIPTION_CHARS) : null;
}

function readNullableString(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new AppError('FAVORITE_PROMPT_INVALID_TITLE', `Favorite prompt ${fieldName} must be a string.`, 422);
  }
  return value;
}

function defaultTitleFromPrompt(prompt: string): string {
  const title = previewText(prompt).replace(/\s+/gu, ' ').trim();
  return title || 'Untitled image prompt';
}

function previewText(value: string): string {
  return limitText(value.replace(/\s+/gu, ' ').trim(), PROMPT_PREVIEW_CHARS);
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

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
  } catch (error: unknown) {
    throw new AppError('FAVORITE_PROMPT_PAYLOAD_NOT_JSON', 'Saved generation request payload must be JSON-serializable.', 422, {
      cause: error instanceof Error ? error.message : String(error)
    });
  }
}

function cloneFavorite(favorite: FavoriteImagePrompt): FavoriteImagePrompt {
  return JSON.parse(JSON.stringify(favorite)) as FavoriteImagePrompt;
}

function isFavoriteImagePrompt(value: unknown): value is FavoriteImagePrompt {
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
