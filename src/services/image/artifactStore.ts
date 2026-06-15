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
    job?: ArtifactMetadata['job'];
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
        ...(image.providerMetadata ? { providerMetadata: image.providerMetadata } : {}),
        ...(options.job ? { job: options.job } : {})
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

  async listRecentCompletedJobs(limit = 50): Promise<unknown[]> {
    const metadataFiles = await this.findMetadataFiles();
    const artifacts: ArtifactMetadata[] = [];
    for (const filePath of metadataFiles) {
      try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
        if (isArtifactMetadata(parsed)) artifacts.push(parsed);
      } catch {
        continue;
      }
    }

    const byJob = new Map<string, ArtifactMetadata[]>();
    for (const artifact of artifacts) {
      const list = byJob.get(artifact.jobId) ?? [];
      list.push(artifact);
      byJob.set(artifact.jobId, list);
    }

    return [...byJob.entries()]
      .map(([jobId, jobArtifacts]) => durableJobSummary(jobId, jobArtifacts))
      .sort((left: any, right: any) => String(right.completedAt ?? right.createdAt).localeCompare(String(left.completedAt ?? left.createdAt)))
      .slice(0, Math.min(Math.max(limit, 1), 250));
  }

  async getRecentCompletedJob(jobId: string): Promise<unknown | null> {
    const jobs = await this.listRecentCompletedJobs(250);
    return jobs.find((job: any) => job?.id === jobId) ?? null;
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
    output: request.output,
    metadata: request.metadata
  };
}

function durableJobSummary(jobId: string, artifacts: ArtifactMetadata[]) {
  const first = artifacts[0]!;
  const job = first.job;
  const request = first.request ?? {};
  return {
    id: jobId,
    status: job?.status ?? 'succeeded',
    createdAt: job?.createdAt ?? first.createdAt,
    updatedAt: job?.completedAt ?? first.createdAt,
    queuedAt: job?.queuedAt ?? job?.createdAt ?? first.createdAt,
    startedAt: job?.startedAt ?? null,
    completedAt: job?.completedAt ?? first.createdAt,
    provider: first.provider,
    providerJobId: null,
    workflowId: first.workflowId,
    model: first.model,
    prompt: first.prompt,
    negativePrompt: first.negativePrompt ?? '',
    seed: first.seed,
    width: typeof request.width === 'number' ? request.width : null,
    height: typeof request.height === 'number' ? request.height : null,
    steps: typeof request.steps === 'number' ? request.steps : null,
    cfgScale: typeof request.cfg_scale === 'number' ? request.cfg_scale : null,
    samplerName: typeof request.sampler_name === 'string' ? request.sampler_name : null,
    scheduler: typeof request.scheduler === 'string' ? request.scheduler : null,
    output: typeof request.output === 'string' ? request.output : null,
    artifactCount: artifacts.length,
    artifactSizes: artifacts.map((artifact) => artifact.sizeBytes),
    artifacts: artifacts.map((artifact) => publicArtifactMetadata(artifact)),
    request,
    metadata: {},
    timings: job?.timings ?? {
      queueWaitMs: null,
      executionMs: null,
      totalMs: null,
      secondsPerStep: null,
      stepsPerSecond: null
    },
    error: null,
    durable: true
  };
}

function publicArtifactMetadata(artifact: ArtifactMetadata) {
  const { filePath: _filePath, ...publicMetadata } = artifact;
  return publicMetadata;
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
