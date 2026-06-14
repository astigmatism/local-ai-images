import crypto from 'node:crypto';
import { AppError } from '../../errors.ts';
import type { Logger } from '../../logger.ts';
import type {
  ArtifactMetadata,
  ImageGenerationProvider,
  ImageJob,
  ImageJobSummary,
  JobStatus,
  NormalizedGenerationRequest,
  ProviderGenerationRequest,
  QueueStats,
  WorkflowPreset
} from '../../types.ts';
import { ArtifactStore } from './artifactStore.ts';

interface QueueItem {
  jobId: string;
  workflow: WorkflowPreset;
}

type Waiter = (job: ImageJob) => void;

export class ImageJobQueue {
  private readonly provider: ImageGenerationProvider;
  private readonly artifactStore: ArtifactStore;
  private readonly concurrency: number;
  private readonly maxQueuedJobs: number;
  private readonly logger: Logger;
  private readonly jobs = new Map<string, ImageJob>();
  private readonly queue: QueueItem[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly waiters = new Map<string, Waiter[]>();
  private runningCount = 0;

  constructor(options: {
    provider: ImageGenerationProvider;
    artifactStore: ArtifactStore;
    concurrency: number;
    maxQueuedJobs: number;
    logger: Logger;
  }) {
    this.provider = options.provider;
    this.artifactStore = options.artifactStore;
    this.concurrency = options.concurrency;
    this.maxQueuedJobs = options.maxQueuedJobs;
    this.logger = options.logger;
  }

  submit(request: NormalizedGenerationRequest, workflow: WorkflowPreset): ImageJob {
    if (this.queue.length >= this.maxQueuedJobs) {
      throw new AppError('IMAGE_QUEUE_FULL', 'The image generation queue is full. Try again after existing jobs complete.', 429, {
        queued: this.queue.length,
        maxQueuedJobs: this.maxQueuedJobs
      });
    }

    const now = new Date().toISOString();
    const job: ImageJob = {
      id: crypto.randomUUID(),
      status: 'queued',
      request,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
      provider: this.provider.name,
      providerJobId: null,
      workflowId: workflow.id,
      model: request.model,
      artifacts: [],
      error: null,
      metadata: {}
    };

    this.jobs.set(job.id, job);
    this.queue.push({ jobId: job.id, workflow });
    queueMicrotask(() => this.drain());
    return cloneJob(job);
  }

  listJobs(limit = 50): ImageJobSummary[] {
    const boundedLimit = Math.min(Math.max(limit, 1), 250);
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, boundedLimit)
      .map((job) => ({
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        provider: job.provider,
        workflowId: job.workflowId,
        model: job.model,
        artifactCount: job.artifacts.length,
        error: job.error ? { ...job.error } : null
      }));
  }

  getJob(jobId: string): ImageJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new AppError('JOB_NOT_FOUND', `Job ${jobId} was not found.`, 404);
    return cloneJob(job);
  }

  async cancel(jobId: string): Promise<ImageJob> {
    const job = this.jobs.get(jobId);
    if (!job) throw new AppError('JOB_NOT_FOUND', `Job ${jobId} was not found.`, 404);

    if (isTerminalStatus(job.status)) {
      return cloneJob(job);
    }

    const queuedIndex = this.queue.findIndex((item) => item.jobId === jobId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
    }

    const controller = this.controllers.get(jobId);
    controller?.abort();
    if (job.status === 'running' && this.provider.cancel) {
      await this.provider.cancel(job.providerJobId ?? undefined).catch((error: unknown) => {
        this.logger.warn({ err: error, jobId }, 'Provider cancel failed');
      });
    }

    this.markCanceled(job);
    return cloneJob(job);
  }

  waitForCompletion(jobId: string, timeoutMs: number): Promise<ImageJob | null> {
    const job = this.jobs.get(jobId);
    if (!job) throw new AppError('JOB_NOT_FOUND', `Job ${jobId} was not found.`, 404);
    if (isTerminalStatus(job.status)) return Promise.resolve(cloneJob(job));
    if (timeoutMs <= 0) return Promise.resolve(null);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.removeWaiter(jobId, waiter);
        resolve(null);
      }, timeoutMs);
      const waiter = (completedJob: ImageJob) => {
        clearTimeout(timeout);
        resolve(cloneJob(completedJob));
      };
      const waiters = this.waiters.get(jobId) ?? [];
      waiters.push(waiter);
      this.waiters.set(jobId, waiters);
    });
  }

  stats(): QueueStats {
    const counts: Record<JobStatus, number> = {
      queued: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      canceled: 0
    };

    for (const job of this.jobs.values()) {
      counts[job.status] += 1;
    }

    return {
      queued: counts.queued,
      running: counts.running,
      succeeded: counts.succeeded,
      failed: counts.failed,
      canceled: counts.canceled,
      total: this.jobs.size,
      concurrency: this.concurrency,
      maxQueuedJobs: this.maxQueuedJobs
    };
  }

  private drain(): void {
    while (this.runningCount < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift()!;
      void this.runJob(item);
    }
  }

  private async runJob(item: QueueItem): Promise<void> {
    const job = this.jobs.get(item.jobId);
    if (!job || job.status !== 'queued') return;

    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    this.runningCount += 1;
    this.markRunning(job);

    try {
      const providerRequest: ProviderGenerationRequest = {
        ...job.request,
        jobId: job.id,
        workflow: item.workflow,
        filenamePrefix: safeFilenamePrefix(job.id),
        signal: controller.signal
      };

      const providerResult = await this.provider.generate(providerRequest);
      if (controller.signal.aborted || job.status === 'canceled') {
        throw new AppError('IMAGE_JOB_CANCELED', 'Image generation was canceled.', 499);
      }

      job.providerJobId = providerResult.providerJobId ?? null;
      const artifacts = await this.artifactStore.saveArtifacts({
        jobId: job.id,
        provider: providerResult.provider,
        workflowId: item.workflow.id,
        request: job.request,
        images: providerResult.images
      });
      this.markSucceeded(job, artifacts, providerResult.metadata);
    } catch (error: unknown) {
      if (job.status === 'canceled') {
        this.notify(job);
        return;
      }
      if (error instanceof AppError && error.code === 'IMAGE_JOB_CANCELED') {
        this.markCanceled(job);
        return;
      }
      this.markFailed(job, error);
    } finally {
      this.controllers.delete(job.id);
      this.runningCount -= 1;
      this.drain();
    }
  }

  private markRunning(job: ImageJob): void {
    const now = new Date().toISOString();
    job.status = 'running';
    job.startedAt = now;
    job.updatedAt = now;
  }

  private markSucceeded(job: ImageJob, artifacts: ArtifactMetadata[], metadata: Record<string, unknown>): void {
    const now = new Date().toISOString();
    job.status = 'succeeded';
    job.artifacts = artifacts;
    job.metadata = metadata;
    job.completedAt = now;
    job.updatedAt = now;
    this.notify(job);
  }

  private markFailed(job: ImageJob, error: unknown): void {
    const now = new Date().toISOString();
    job.status = 'failed';
    job.completedAt = now;
    job.updatedAt = now;
    job.error = errorToJobError(error);
    this.logger.warn({ err: error, jobId: job.id }, 'Image generation job failed');
    this.notify(job);
  }

  private markCanceled(job: ImageJob): void {
    const now = new Date().toISOString();
    job.status = 'canceled';
    job.completedAt = now;
    job.updatedAt = now;
    job.error = { code: 'IMAGE_JOB_CANCELED', message: 'Image generation was canceled.' };
    this.notify(job);
  }

  private notify(job: ImageJob): void {
    const waiters = this.waiters.get(job.id) ?? [];
    this.waiters.delete(job.id);
    for (const waiter of waiters) {
      waiter(job);
    }
  }

  private removeWaiter(jobId: string, waiter: Waiter): void {
    const waiters = this.waiters.get(jobId) ?? [];
    const next = waiters.filter((candidate) => candidate !== waiter);
    if (next.length === 0) this.waiters.delete(jobId);
    else this.waiters.set(jobId, next);
  }
}

function errorToJobError(error: unknown): ImageJob['error'] {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details })
    };
  }

  if (error instanceof Error) {
    return { code: 'IMAGE_JOB_FAILED', message: error.message };
  }

  return { code: 'IMAGE_JOB_FAILED', message: 'Unknown image-generation failure.' };
}

function isTerminalStatus(status: JobStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled';
}

function cloneJob(job: ImageJob): ImageJob {
  return JSON.parse(JSON.stringify(job)) as ImageJob;
}

function safeFilenamePrefix(jobId: string): string {
  return `local-ai-image/${jobId.replace(/[^a-zA-Z0-9_-]/gu, '')}`;
}
