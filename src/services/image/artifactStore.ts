import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../errors.ts';
import type { ArtifactMetadata, ImageArtifactData, NormalizedGenerationRequest } from '../../types.ts';

export class ArtifactStore {
  private readonly artifactPath: string;
  private readonly publicBaseUrl: string;

  constructor(artifactPath: string, publicBaseUrl: string) {
    this.artifactPath = artifactPath;
    this.publicBaseUrl = publicBaseUrl.replace(/\/+$/u, '');
  }

  async saveArtifacts(options: {
    jobId: string;
    provider: string;
    workflowId: string;
    request: NormalizedGenerationRequest;
    images: ImageArtifactData[];
  }): Promise<ArtifactMetadata[]> {
    await fs.mkdir(this.artifactPath, { recursive: true });

    const artifacts: ArtifactMetadata[] = [];
    for (let index = 0; index < options.images.length; index += 1) {
      const image = options.images[index]!;
      const id = crypto.randomUUID();
      const extension = extensionForMime(image.mimeType);
      const fileName = `${options.jobId}-${index + 1}-${id}${extension}`;
      const filePath = path.join(this.artifactPath, fileName);
      await fs.writeFile(filePath, image.buffer);

      const metadata: ArtifactMetadata = {
        id,
        jobId: options.jobId,
        fileName,
        filePath,
        url: `${this.publicBaseUrl}/${id}`,
        mimeType: image.mimeType,
        sizeBytes: image.buffer.byteLength,
        ...(image.width !== undefined ? { width: image.width } : {}),
        ...(image.height !== undefined ? { height: image.height } : {}),
        createdAt: new Date().toISOString(),
        provider: options.provider,
        workflowId: options.workflowId,
        model: options.request.model,
        prompt: options.request.prompt,
        ...(options.request.negativePrompt ? { negativePrompt: options.request.negativePrompt } : {}),
        seed: options.request.seed,
        request: publicRequestMetadata(options.request),
        ...(image.providerMetadata ? { providerMetadata: image.providerMetadata } : {})
      };

      await fs.writeFile(metadataPath(filePath), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
      artifacts.push(metadata);
    }

    return artifacts;
  }

  async getArtifact(id: string): Promise<{ metadata: ArtifactMetadata; buffer: Buffer }> {
    const metadata = await this.getMetadata(id);
    const buffer = await fs.readFile(metadata.filePath);
    return { metadata, buffer };
  }

  async getMetadata(id: string): Promise<ArtifactMetadata> {
    const metadataFiles = await this.findMetadataFiles();
    for (const filePath of metadataFiles) {
      try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
        if (isArtifactMetadata(parsed) && parsed.id === id) {
          return parsed;
        }
      } catch {
        continue;
      }
    }

    throw new AppError('ARTIFACT_NOT_FOUND', `Artifact ${id} was not found.`, 404);
  }

  private async findMetadataFiles(): Promise<string[]> {
    let entries;
    try {
      entries = await fs.readdir(this.artifactPath, { withFileTypes: true });
    } catch {
      return [];
    }

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(this.artifactPath, entry.name));
  }
}

function publicRequestMetadata(request: NormalizedGenerationRequest): Record<string, unknown> {
  return {
    prompt: request.prompt,
    negative_prompt: request.negativePrompt,
    model: request.model,
    workflow_id: request.workflowId,
    width: request.width,
    height: request.height,
    steps: request.steps,
    cfg_scale: request.cfgScale,
    seed: request.seed,
    sampler_name: request.samplerName,
    scheduler: request.scheduler,
    metadata: request.metadata
  };
}

function extensionForMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/png':
    default:
      return '.png';
  }
}

function metadataPath(filePath: string): string {
  return `${filePath}.json`;
}

function isArtifactMetadata(value: unknown): value is ArtifactMetadata {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { filePath?: unknown }).filePath === 'string'
    && typeof (value as { mimeType?: unknown }).mimeType === 'string';
}
