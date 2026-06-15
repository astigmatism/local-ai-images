import fs from 'node:fs/promises';
import path from 'node:path';
import type { ModelInventory, ModelInventoryItem } from '../../types.ts';

const MODEL_EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.gguf', '.onnx']);
const TYPE_HINTS: Array<[string, string]> = [
  ['checkpoints', 'checkpoint'],
  ['checkpoint', 'checkpoint'],
  ['stable-diffusion', 'checkpoint'],
  ['stable_diffusion', 'checkpoint'],
  ['loras', 'lora'],
  ['lora', 'lora'],
  ['vae', 'vae'],
  ['controlnet', 'controlnet'],
  ['controlnets', 'controlnet'],
  ['embeddings', 'embedding'],
  ['textual_inversion', 'embedding'],
  ['upscale_models', 'upscaler'],
  ['upscalers', 'upscaler'],
  ['clip', 'clip']
];

const TYPE_ROOT_NAMES: Record<string, string[]> = {
  checkpoint: ['checkpoints', 'checkpoint'],
  lora: ['loras', 'lora'],
  vae: ['vae'],
  controlnet: ['controlnet', 'controlnets'],
  upscaler: ['upscale_models', 'upscalers']
};

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

    models.sort((left, right) => left.type.localeCompare(right.type) || left.displayName.localeCompare(right.displayName));

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
    const fileName = path.basename(entry.name);
    const type = inferModelType(relativePath, rootPath, extension);
    const displayName = path.basename(entry.name, extension);
    const comfyName = comfyNameForType(relativePath, fileName, type);
    output.push({
      id: stableModelId(relativePath),
      name: displayName,
      displayName,
      fileName,
      type,
      category: type,
      path: fullPath,
      rootPath,
      relativePath,
      comfyName,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      extension
    });
  }
}

function inferModelType(relativePath: string, rootPath: string, extension: string): string {
  const relativeSegments = relativePath.toLowerCase().split('/').filter(Boolean);
  for (const [needle, type] of TYPE_HINTS) {
    if (relativeSegments.includes(needle)) return type;
  }

  // Operators often configure IMAGE_MODEL_PATHS or COMFYUI_CHECKPOINT_PATH to point
  // directly at ComfyUI's checkpoints directory. In that layout the relative path is
  // just "model.safetensors", so there is no "checkpoints/" segment to infer from.
  const rootSegments = path.resolve(rootPath).toLowerCase().split(/[\\/]+/u).filter(Boolean);
  for (const [needle, type] of TYPE_HINTS) {
    if (rootSegments.includes(needle)) return type;
  }

  // A top-level .safetensors or .ckpt file in a scanned model root is treated as a
  // checkpoint by default so real checkpoint files get load/default controls instead
  // of becoming inert generic "model" entries.
  if (extension === '.ckpt' || extension === '.safetensors') return 'checkpoint';

  return 'model';
}

function comfyNameForType(relativePath: string, fileName: string, type: string): string {
  const segments = relativePath.split('/').filter(Boolean);
  const roots = TYPE_ROOT_NAMES[type] ?? [];
  if (segments.length > 1 && roots.includes(segments[0]!.toLowerCase())) {
    return segments.slice(1).join('/');
  }
  return segments.length > 0 ? segments.join('/') : fileName;
}

function stableModelId(relativePath: string): string {
  return relativePath
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/u, '')
    .replace(/[^a-z0-9._/-]+/gu, '-')
    .replace(/[/-]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'model';
}
