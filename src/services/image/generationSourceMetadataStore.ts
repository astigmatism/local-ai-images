import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../errors.ts';
import type { GenerationSourceUserMetadata } from '../../types.ts';

const MAX_SOURCE_ID_CHARS = 512;
const MAX_NOTES_CHARS = 8000;
const MAX_OVERRIDE_CHARS = 120;

export class GenerationSourceMetadataStore {
  private readonly filePath: string;
  private updateQueue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get path(): string {
    return this.filePath;
  }

  async list(): Promise<GenerationSourceUserMetadata[]> {
    return (await this.readAll()).map(cloneMetadata).sort(compareMetadataBySourceId);
  }

  async get(sourceId: string): Promise<GenerationSourceUserMetadata> {
    const normalizedSourceId = normalizeSourceId(sourceId);
    const metadata = (await this.readAll()).find((item) => item.sourceId === normalizedSourceId);
    if (!metadata) {
      throw new AppError('GENERATION_SOURCE_METADATA_NOT_FOUND', `Generation source metadata for ${normalizedSourceId} was not found.`, 404);
    }
    return cloneMetadata(metadata);
  }

  async update(sourceId: string, body: unknown): Promise<GenerationSourceUserMetadata> {
    const operation = this.updateQueue.then(() => this.updateNow(sourceId, body));
    this.updateQueue = operation.catch(() => undefined);
    return operation;
  }

  private async updateNow(sourceId: string, body: unknown): Promise<GenerationSourceUserMetadata> {
    const normalizedSourceId = normalizeSourceId(sourceId);
    if (!isRecord(body)) {
      throw new AppError('GENERATION_SOURCE_METADATA_INVALID_REQUEST', 'Generation source metadata update must be a JSON object.', 422);
    }

    const records = await this.readAll();
    const index = records.findIndex((item) => item.sourceId === normalizedSourceId);
    const now = new Date().toISOString();
    const existing = index >= 0 ? records[index]! : createEmptyMetadata(normalizedSourceId, now);
    const next: GenerationSourceUserMetadata = {
      ...existing,
      updatedAt: now
    };

    if (hasOwn(body, 'favorite') || hasOwn(body, 'is_favorite') || hasOwn(body, 'isFavorite')) {
      next.favorite = readBoolean(body.favorite ?? body.is_favorite ?? body.isFavorite, 'favorite');
    }

    if (hasOwn(body, 'notes') || hasOwn(body, 'note')) {
      next.notes = normalizeNotes(body.notes ?? body.note);
    }

    if (hasOwn(body, 'promptStyleOverride') || hasOwn(body, 'prompt_style_override')) {
      next.promptStyleOverride = normalizeNullableOverride(body.promptStyleOverride ?? body.prompt_style_override, 'promptStyleOverride');
    }

    if (hasOwn(body, 'categoryOverride') || hasOwn(body, 'category_override')) {
      next.categoryOverride = normalizeNullableOverride(body.categoryOverride ?? body.category_override, 'categoryOverride');
    }

    if (hasOwn(body, 'colorOverride') || hasOwn(body, 'color_override')) {
      next.colorOverride = normalizeNullableOverride(body.colorOverride ?? body.color_override, 'colorOverride');
    }

    if (index >= 0) records[index] = next;
    else records.push(next);

    await this.writeAll(records);
    return cloneMetadata(next);
  }

  private async readAll(): Promise<GenerationSourceUserMetadata[]> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      const records = storedRecords(parsed);
      const bySourceId = new Map<string, GenerationSourceUserMetadata>();
      for (const record of records) {
        const normalized = normalizeStoredMetadata(record);
        if (normalized) bySourceId.set(normalized.sourceId, normalized);
      }
      return [...bySourceId.values()].sort(compareMetadataBySourceId).map(cloneMetadata);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') return [];
      if (error instanceof SyntaxError) {
        throw new AppError('GENERATION_SOURCE_METADATA_READ_FAILED', `Generation source metadata file is not valid JSON: ${this.filePath}`, 500, { path: this.filePath });
      }
      throw new AppError('GENERATION_SOURCE_METADATA_READ_FAILED', `Unable to read generation source metadata file: ${this.filePath}`, 500, {
        path: this.filePath,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async writeAll(records: GenerationSourceUserMetadata[]): Promise<void> {
    const directory = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const normalized = records
      .map(normalizeStoredMetadata)
      .filter((item): item is GenerationSourceUserMetadata => item !== null)
      .sort(compareMetadataBySourceId);
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      sources: normalized
    };

    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await fs.rename(tempPath, this.filePath);
    } catch (error: unknown) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw new AppError('GENERATION_SOURCE_METADATA_WRITE_FAILED', `Unable to write generation source metadata file: ${this.filePath}`, 500, {
        path: this.filePath,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

function createEmptyMetadata(sourceId: string, now: string): GenerationSourceUserMetadata {
  return {
    sourceId,
    favorite: false,
    notes: '',
    promptStyleOverride: null,
    categoryOverride: null,
    colorOverride: null,
    createdAt: now,
    updatedAt: now
  };
}

function storedRecords(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  if (Array.isArray(value.sources)) return value.sources;
  if (Array.isArray(value.metadata)) return value.metadata;
  if (isRecord(value.sources)) return Object.values(value.sources);
  return [];
}

function normalizeStoredMetadata(value: unknown): GenerationSourceUserMetadata | null {
  if (!isRecord(value)) return null;
  const sourceIdRaw = value.sourceId ?? value.source_id ?? value.id;
  if (typeof sourceIdRaw !== 'string') return null;
  let sourceId: string;
  try {
    sourceId = normalizeSourceId(sourceIdRaw);
  } catch {
    return null;
  }
  const now = new Date().toISOString();
  const createdAt = readDateString(value.createdAt ?? value.created_at) ?? readDateString(value.updatedAt ?? value.updated_at) ?? now;
  const updatedAt = readDateString(value.updatedAt ?? value.updated_at) ?? createdAt;
  return {
    sourceId,
    favorite: value.favorite === true || value.isFavorite === true || value.is_favorite === true,
    notes: normalizeStoredNotes(value.notes ?? value.note),
    promptStyleOverride: normalizeStoredNullableOverride(value.promptStyleOverride ?? value.prompt_style_override),
    categoryOverride: normalizeStoredNullableOverride(value.categoryOverride ?? value.category_override),
    colorOverride: normalizeStoredNullableOverride(value.colorOverride ?? value.color_override),
    createdAt,
    updatedAt
  };
}

function normalizeSourceId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new AppError('GENERATION_SOURCE_METADATA_INVALID_SOURCE_ID', 'Generation source id must be a non-empty string.', 422);
  }
  if (normalized.length > MAX_SOURCE_ID_CHARS) {
    throw new AppError('GENERATION_SOURCE_METADATA_SOURCE_ID_TOO_LONG', `Generation source id must be ${MAX_SOURCE_ID_CHARS} characters or fewer.`, 422, { max_source_id_chars: MAX_SOURCE_ID_CHARS });
  }
  return normalized;
}

function normalizeNotes(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') {
    throw new AppError('GENERATION_SOURCE_METADATA_INVALID_NOTES', 'Generation source notes must be a string.', 422);
  }
  if (value.length > MAX_NOTES_CHARS) {
    throw new AppError('GENERATION_SOURCE_METADATA_NOTES_TOO_LONG', `Generation source notes must be ${MAX_NOTES_CHARS} characters or fewer.`, 422, { max_notes_chars: MAX_NOTES_CHARS });
  }
  return value;
}

function normalizeStoredNotes(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, MAX_NOTES_CHARS) : '';
}

function normalizeNullableOverride(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new AppError('GENERATION_SOURCE_METADATA_INVALID_OVERRIDE', `${fieldName} must be a string or null.`, 422, { field: fieldName });
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > MAX_OVERRIDE_CHARS) {
    throw new AppError('GENERATION_SOURCE_METADATA_OVERRIDE_TOO_LONG', `${fieldName} must be ${MAX_OVERRIDE_CHARS} characters or fewer.`, 422, { field: fieldName, max_chars: MAX_OVERRIDE_CHARS });
  }
  return normalized;
}

function normalizeStoredNullableOverride(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, MAX_OVERRIDE_CHARS) : null;
}

function readBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value === 'boolean') return value;
  throw new AppError('GENERATION_SOURCE_METADATA_INVALID_BOOLEAN', `${fieldName} must be true or false.`, 422, { field: fieldName });
}

function readDateString(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function cloneMetadata(metadata: GenerationSourceUserMetadata): GenerationSourceUserMetadata {
  return { ...metadata };
}

function compareMetadataBySourceId(left: GenerationSourceUserMetadata, right: GenerationSourceUserMetadata): number {
  return left.sourceId.localeCompare(right.sourceId, undefined, { sensitivity: 'base', numeric: true });
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
