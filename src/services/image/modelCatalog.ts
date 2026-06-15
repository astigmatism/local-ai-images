import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModelCatalogEntry, ModelInstallType } from '../../types.ts';

const INSTALL_TYPES = new Set<ModelInstallType>(['checkpoint', 'lora', 'vae', 'controlnet', 'upscaler', 'other']);

export class ModelCatalog {
  private readonly catalogPath: string;

  constructor(catalogPath: string) {
    this.catalogPath = catalogPath;
  }

  get path(): string {
    return this.catalogPath;
  }

  get examplePath(): string {
    const parsed = path.parse(this.catalogPath);
    const baseName = parsed.name.endsWith('.example') ? parsed.name : `${parsed.name}.example`;
    return path.join(parsed.dir, `${baseName}${parsed.ext || '.json'}`);
  }

  async load(): Promise<{ ok: true; path: string; source: 'runtime' | 'example' | 'empty'; entries: ModelCatalogEntry[] }> {
    const runtime = await readJsonIfExists(this.catalogPath);
    if (runtime.exists) {
      return { ok: true, path: this.catalogPath, source: 'runtime', entries: normalizeCatalogEntries(runtime.value) };
    }

    const example = await readJsonIfExists(this.examplePath);
    if (example.exists) {
      return { ok: true, path: this.examplePath, source: 'example', entries: normalizeCatalogEntries(example.value) };
    }

    return { ok: true, path: this.catalogPath, source: 'empty', entries: [] };
  }
}

async function readJsonIfExists(filePath: string): Promise<{ exists: true; value: unknown } | { exists: false }> {
  try {
    return { exists: true, value: JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown };
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return { exists: false };
    throw error;
  }
}

function normalizeCatalogEntries(value: unknown): ModelCatalogEntry[] {
  const rawEntries = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.models)
      ? value.models
      : isRecord(value) && Array.isArray(value.entries)
        ? value.entries
        : [];

  const entries: ModelCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const raw of rawEntries) {
    if (!isRecord(raw)) continue;
    const id = readRequiredString(raw.id) || slugify(readRequiredString(raw.name) || 'model');
    if (seen.has(id)) continue;
    seen.add(id);
    const name = readRequiredString(raw.name) || id;
    const type = normalizeInstallType(readRequiredString(raw.type)) ?? 'checkpoint';
    entries.push({
      id,
      name,
      type,
      ...(readOptionalString(raw.description) ? { description: readOptionalString(raw.description) } : {}),
      ...(readOptionalString(raw.base) ? { base: readOptionalString(raw.base) } : {}),
      ...(readStringArray(raw.recommendedFor).length ? { recommendedFor: readStringArray(raw.recommendedFor) } : {}),
      ...(readOptionalNumber(raw.minimumVramGb) !== null ? { minimumVramGb: readOptionalNumber(raw.minimumVramGb)! } : {}),
      ...(readOptionalString(raw.license) ? { license: readOptionalString(raw.license) } : {}),
      ...(readOptionalString(raw.sourceName) ? { sourceName: readOptionalString(raw.sourceName) } : {}),
      ...(readOptionalString(raw.sourceUrl) ? { sourceUrl: readOptionalString(raw.sourceUrl) } : {}),
      ...(readOptionalString(raw.downloadUrl) ? { downloadUrl: readOptionalString(raw.downloadUrl) } : {}),
      ...(readOptionalString(raw.fileName) ? { fileName: readOptionalString(raw.fileName) } : {}),
      ...(readOptionalString(raw.notes) ? { notes: readOptionalString(raw.notes) } : {}),
      ...(readStringArray(raw.tags).length ? { tags: readStringArray(raw.tags) } : {})
    });
  }
  return entries;
}

export function normalizeInstallType(value: unknown): ModelInstallType | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/gu, '_');
  const aliases: Record<string, ModelInstallType> = {
    checkpoint: 'checkpoint',
    checkpoints: 'checkpoint',
    ckpt: 'checkpoint',
    lora: 'lora',
    loras: 'lora',
    vae: 'vae',
    controlnet: 'controlnet',
    controlnets: 'controlnet',
    control_net: 'controlnet',
    upscaler: 'upscaler',
    upscale: 'upscaler',
    upscale_model: 'upscaler',
    upscale_models: 'upscaler',
    other: 'other',
    unknown: 'other'
  };
  const type = aliases[normalized] ?? null;
  return type && INSTALL_TYPES.has(type) ? type : null;
}

function readRequiredString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readOptionalString(value: unknown): string | undefined {
  const text = readRequiredString(value);
  return text || undefined;
}

function readOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '') || 'model';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
