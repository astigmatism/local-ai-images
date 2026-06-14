import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModelInventory, ModelInventoryItem } from '../../types.ts';

const MODEL_EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx']);
const TYPE_HINTS: Array<[string, string]> = [
  ['checkpoints', 'checkpoint'],
  ['checkpoint', 'checkpoint'],
  ['loras', 'lora'],
  ['lora', 'lora'],
  ['vae', 'vae'],
  ['controlnet', 'controlnet'],
  ['controlnets', 'controlnet'],
  ['embeddings', 'embedding'],
  ['textual_inversion', 'embedding'],
  ['upscale_models', 'upscale'],
  ['upscalers', 'upscale'],
  ['clip', 'clip']
];

export class ModelScanner {
  private readonly modelPaths: string[];
  private cachedInventory: ModelInventory | null = null;

  constructor(modelPaths: string[]) {
    this.modelPaths = modelPaths;
  }

  get paths(): string[] {
    return [...this.modelPaths];
  }

  getCachedInventory(): ModelInventory | null {
    return this.cachedInventory;
  }

  async refresh(): Promise<ModelInventory> {
    const models: ModelInventoryItem[] = [];

    for (const rootPath of this.modelPaths) {
      const absoluteRoot = path.resolve(rootPath);
      await scanDirectory(absoluteRoot, absoluteRoot, models);
    }

    models.sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name));

    this.cachedInventory = {
      ok: true,
      refreshedAt: new Date().toISOString(),
      paths: [...this.modelPaths],
      models
    };
    return this.cachedInventory;
  }

  async list(): Promise<ModelInventory> {
    return this.cachedInventory ?? this.refresh();
  }
}

async function scanDirectory(rootPath: string, directoryPath: string, output: ModelInventoryItem[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      await scanDirectory(rootPath, fullPath, output);
      continue;
    }

    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!MODEL_EXTENSIONS.has(extension)) continue;

    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue;
    }

    const relativePath = path.relative(rootPath, fullPath).split(path.sep).join('/');
    output.push({
      id: stableModelId(relativePath),
      name: path.basename(entry.name, extension),
      type: inferModelType(relativePath),
      path: fullPath,
      relativePath,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      extension
    });
  }
}

function inferModelType(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  for (const [needle, type] of TYPE_HINTS) {
    if (lower.split('/').includes(needle)) return type;
  }
  return 'model';
}

function stableModelId(relativePath: string): string {
  return relativePath
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/u, '')
    .replace(/[^a-z0-9._/-]+/gu, '-')
    .replace(/[/-]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'model';
}
