import type { ImageJob, JobTimingMetrics, NormalizedGenerationRequest } from '../types.ts';

export interface JobMetricInput {
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  request: Pick<NormalizedGenerationRequest, 'steps'>;
}

export function calculateJobTimings(job: JobMetricInput): JobTimingMetrics {
  const created = Date.parse(job.createdAt);
  const started = job.startedAt ? Date.parse(job.startedAt) : Number.NaN;
  const completed = job.completedAt ? Date.parse(job.completedAt) : Number.NaN;

  const queueWaitMs = Number.isFinite(created) && Number.isFinite(started)
    ? Math.max(0, started - created)
    : null;
  const executionMs = Number.isFinite(started) && Number.isFinite(completed)
    ? Math.max(0, completed - started)
    : null;
  const totalMs = Number.isFinite(created) && Number.isFinite(completed)
    ? Math.max(0, completed - created)
    : null;

  const steps = job.request.steps;
  const executionSeconds = executionMs !== null ? executionMs / 1000 : null;
  const secondsPerStep = executionSeconds !== null && steps > 0
    ? executionSeconds / steps
    : null;
  const stepsPerSecond = executionSeconds !== null && executionSeconds > 0
    ? steps / executionSeconds
    : null;

  return {
    queueWaitMs,
    executionMs,
    totalMs,
    secondsPerStep,
    stepsPerSecond
  };
}

export function summarizeImageJob(job: ImageJob) {
  const timings = calculateJobTimings(job);
  return {
    id: job.id,
    status: job.status,
    clientId: job.clientId,
    createdAt: job.createdAt,
    submittedAt: job.submittedAt,
    updatedAt: job.updatedAt,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    cancelRequestedAt: job.cancelRequestedAt,
    canceledAt: job.canceledAt,
    cancellationReason: job.cancellationReason,
    provider: job.provider,
    providerJobId: job.providerJobId,
    workflowId: job.workflowId,
    model: job.model,
    generationSourceType: job.generationSourceType,
    generationSourceId: job.generationSourceId,
    generationSourceLabel: job.generationSourceLabel,
    prompt: job.request.prompt,
    negativePrompt: job.request.negativePrompt,
    seed: job.request.seed,
    width: job.request.width,
    height: job.request.height,
    steps: job.request.steps,
    cfgScale: job.request.cfgScale,
    samplerName: job.request.samplerName,
    scheduler: job.request.scheduler,
    output: job.request.output,
    artifactCount: job.artifacts.length,
    artifactSizes: job.artifacts.map((artifact) => artifact.sizeBytes),
    artifacts: job.artifacts.map(publicArtifactMetadata),
    thumbnailUrl: job.artifacts[0]?.url ?? null,
    request: job.request,
    ...(job.requestPayload ? { requestPayload: cloneRecord(job.requestPayload) } : {}),
    metadata: job.metadata,
    timings,
    queueWaitMs: timings.queueWaitMs,
    executionMs: timings.executionMs,
    totalMs: timings.totalMs,
    secondsPerStep: timings.secondsPerStep,
    stepsPerSecond: timings.stepsPerSecond,
    error: job.error ? { ...job.error } : null
  };
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

function publicArtifactMetadata(artifact: ImageJob['artifacts'][number]) {
  const { filePath: _filePath, ...publicMetadata } = artifact;
  return publicMetadata;
}
