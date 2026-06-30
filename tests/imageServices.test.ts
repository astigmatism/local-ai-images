import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLogger } from '../src/logger.ts';
import { ArtifactStore } from '../src/services/image/artifactStore.ts';
import { GenerationSourceRegistry } from '../src/services/image/generationSources.ts';
import { ImageJobQueue } from '../src/services/image/jobQueue.ts';
import { MockImageProvider } from '../src/services/image/mockProvider.ts';
import { ModelScanner } from '../src/services/image/modelScanner.ts';
import { builtinWorkflows, WorkflowStore } from '../src/services/image/workflowStore.ts';
import type { ImageGenerationProvider, NormalizedGenerationRequest } from '../src/types.ts';
import { testRuntimeConfig } from './helpers.ts';

function baseRequest(overrides: Partial<NormalizedGenerationRequest> = {}): NormalizedGenerationRequest {
  return {
    prompt: 'a test prompt',
    negativePrompt: '',
    model: 'sd_xl_base_1.0.safetensors',
    workflowId: 'sdxl-text-to-image',
    generationSourceType: 'checkpoint',
    generationSourceId: 'checkpoint:sd_xl_base_1.0.safetensors',
    generationSourceLabel: 'sd_xl_base_1.0.safetensors',
    checkpointName: 'sd_xl_base_1.0.safetensors',
    workflowSourceId: null,
    width: 512,
    height: 512,
    steps: 4,
    cfgScale: 5,
    seed: 123,
    samplerName: 'euler',
    scheduler: 'normal',
    output: 'url',
    syncTimeoutMs: 1000,
    metadata: {},
    ...overrides
  };
}

test('ModelScanner scans configured model paths without failing on missing directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-models-'));
  await fs.mkdir(path.join(root, 'checkpoints'), { recursive: true });
  await fs.mkdir(path.join(root, 'loras'), { recursive: true });
  await fs.writeFile(path.join(root, 'checkpoints', 'base.safetensors'), 'checkpoint');
  await fs.writeFile(path.join(root, 'loras', 'style.safetensors'), 'lora');

  const scanner = new ModelScanner([root, path.join(root, 'missing')]);
  const inventory = await scanner.refresh();

  assert.equal(inventory.ok, true);
  assert.equal(inventory.models.length, 2);
  assert.deepEqual(inventory.models.map((model) => model.type).sort(), ['checkpoint', 'lora']);
  assert.ok(inventory.models.every((model) => model.sizeBytes !== null));
});


test('ModelScanner treats a configured checkpoints directory as checkpoint models', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-checkpoint-root-'));
  const checkpointDir = path.join(root, 'checkpoints');
  await fs.mkdir(checkpointDir, { recursive: true });
  await fs.writeFile(path.join(checkpointDir, 'direct.safetensors'), 'checkpoint');

  const scanner = new ModelScanner([checkpointDir]);
  const inventory = await scanner.refresh();

  assert.equal(inventory.ok, true);
  assert.equal(inventory.models.length, 1);
  assert.equal(inventory.models[0]?.fileName, 'direct.safetensors');
  assert.equal(inventory.models[0]?.comfyName, 'direct.safetensors');
  assert.equal(inventory.models[0]?.type, 'checkpoint');
});

test('WorkflowStore loads builtin and operator workflow presets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-workflows-'));
  const custom = builtinWorkflows()[0]!;
  await fs.writeFile(path.join(root, 'custom.json'), JSON.stringify({
    ...custom,
    id: 'custom-sdxl',
    name: 'Custom SDXL',
    source: undefined
  }));

  const store = new WorkflowStore(root, 'custom-sdxl');
  const workflows = await store.refresh();
  assert.equal(workflows[0]?.id, 'custom-sdxl');
  const workflow = await store.get('custom-sdxl');
  assert.equal(workflow.source, 'file');
  assert.equal(workflow.name, 'Custom SDXL');
});

test('WorkflowStore preserves explicit split ComfyUI control mappings from operator presets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-workflows-'));
  const custom = builtinWorkflows()[0]!;
  await fs.writeFile(path.join(root, 'custom-split.json'), JSON.stringify({
    ...custom,
    id: 'custom-split-controls',
    name: 'Custom split controls',
    source: undefined,
    comfyui: {
      ...custom.comfyui,
      mappings: {
        ...custom.comfyui.mappings,
        seedNode: '15',
        seedInput: 'noise_seed',
        stepsNode: '13',
        cfgNode: '10',
        cfgInput: 'guidance',
        samplerSelectorNode: '12',
        samplerInput: 'sampler_name',
        schedulerNode: '13'
      }
    }
  }));

  const store = new WorkflowStore(root, 'custom-split-controls');
  const workflow = await store.get('custom-split-controls');
  assert.equal(workflow.comfyui.mappings.seedNode, '15');
  assert.equal(workflow.comfyui.mappings.seedInput, 'noise_seed');
  assert.equal(workflow.comfyui.mappings.stepsNode, '13');
  assert.equal(workflow.comfyui.mappings.cfgNode, '10');
  assert.equal(workflow.comfyui.mappings.cfgInput, 'guidance');
  assert.equal(workflow.comfyui.mappings.samplerNameNode, '12');
  assert.equal(workflow.comfyui.mappings.samplerNameInput, 'sampler_name');
  assert.equal(workflow.comfyui.mappings.schedulerNode, '13');
});

test('GenerationSourceRegistry keeps plausible checkpoint candidates selectable while ComfyUI is unavailable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-source-registry-'));
  const modelPath = path.join(root, 'models');
  const workflowPath = path.join(root, 'workflows');
  await fs.mkdir(path.join(modelPath, 'checkpoints'), { recursive: true });
  await fs.mkdir(path.join(modelPath, 'text_encoders'), { recursive: true });
  await fs.mkdir(workflowPath, { recursive: true });
  await fs.writeFile(path.join(modelPath, 'checkpoints', 'candidate.safetensors'), 'checkpoint');
  await fs.writeFile(path.join(modelPath, 'text_encoders', 'not-a-checkpoint.safetensors'), 'text encoder');

  const provider: ImageGenerationProvider = {
    name: 'comfyui',
    async health() {
      return {
        ok: false,
        provider: 'comfyui',
        error: { code: 'COMFYUI_UNAVAILABLE', message: 'Unable to connect to ComfyUI.' }
      };
    },
    async generate() {
      throw new Error('generate should not be called before provider readiness is confirmed');
    },
    async listCheckpoints() {
      throw new Error('listCheckpoints should not be called before provider readiness is confirmed');
    }
  };

  const registry = new GenerationSourceRegistry({
    runtimeConfig: testRuntimeConfig({ imageModelPaths: [modelPath], imageWorkflowPath: workflowPath }),
    provider,
    modelScanner: new ModelScanner([modelPath]),
    workflowStore: new WorkflowStore(workflowPath, 'sdxl-text-to-image'),
    logger: createLogger('silent')
  });

  const list = await registry.refresh();
  const checkpoints = list.sourceGroups.checkpoints;
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]?.checkpointName, 'candidate.safetensors');
  assert.equal(checkpoints[0]?.probeStatus, 'pending');
  assert.equal(checkpoints[0]?.capabilityStatus, 'candidate');
  assert.equal(checkpoints[0]?.selectable, true);
  assert.equal(list.sourceGroups.workflows.length, 0);

  await new Promise((resolve) => setTimeout(resolve, 10));
  const cached = registry.cachedSourceList();
  assert.equal(cached.sourceGroups.checkpoints[0]?.checkpointName, 'candidate.safetensors');
  assert.equal(cached.sourceGroups.checkpoints[0]?.probeStatus, 'pending');
  assert.equal(cached.status.checkpointProbe.pending, 1);
  assert.equal(cached.status.checkpointProbe.error, 0);
});

test('ArtifactStore writes image data and sidecar metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-artifacts-'));
  const store = new ArtifactStore(root, '/api/v1/artifacts');
  const [artifact] = await store.saveArtifacts({
    jobId: 'job-1',
    provider: 'mock',
    workflowId: 'sdxl-text-to-image',
    request: baseRequest(),
    images: [{ mimeType: 'image/png', buffer: Buffer.from('image-bytes'), width: 1, height: 1 }]
  });

  assert.ok(artifact);
  assert.equal(artifact?.url, `/api/v1/artifacts/${artifact.id}`);
  const loaded = await store.getArtifact(artifact!.id);
  assert.equal(loaded.metadata.prompt, 'a test prompt');
  assert.equal(loaded.buffer.toString(), 'image-bytes');
});

test('ArtifactStore lists completed job history beyond the old recent cap', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-artifacts-history-'));
  const store = new ArtifactStore(root, '/api/v1/artifacts');
  const baseTime = Date.parse('2026-01-01T00:00:00.000Z');

  for (let index = 1; index <= 260; index += 1) {
    const createdAt = new Date(baseTime + index * 1000).toISOString();
    await store.saveArtifacts({
      jobId: `history-job-${index}`,
      provider: 'mock',
      workflowId: 'sdxl-text-to-image',
      request: baseRequest({ prompt: `history prompt ${index}` }),
      images: [{ mimeType: 'image/png', buffer: Buffer.from(`image-${index}`), width: 1, height: 1 }],
      job: {
        id: `history-job-${index}`,
        status: 'succeeded',
        createdAt,
        queuedAt: createdAt,
        startedAt: createdAt,
        completedAt: createdAt,
        timings: { queueWaitMs: 0, executionMs: 0, totalMs: 0, secondsPerStep: 0, stepsPerSecond: 0 }
      }
    });
  }

  const jobs = await store.listRecentCompletedJobs(260);
  assert.equal(jobs.length, 260);
  assert.equal((jobs[0] as { id?: string }).id, 'history-job-260');
  assert.equal((jobs[259] as { id?: string }).id, 'history-job-1');

  const oldestJob = await store.getRecentCompletedJob('history-job-1') as { prompt?: string } | null;
  assert.equal(oldestJob?.prompt, 'history prompt 1');
});

test('ImageJobQueue moves jobs from queued to succeeded and persists artifacts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-queue-artifacts-'));
  const queue = new ImageJobQueue({
    provider: new MockImageProvider(1),
    artifactStore: new ArtifactStore(root, '/api/v1/artifacts'),
    concurrency: 1,
    maxQueuedJobs: 8,
    logger: createLogger('silent')
  });

  const job = queue.submit(baseRequest(), builtinWorkflows()[0]!);
  assert.equal(job.status, 'queued');
  const completed = await queue.waitForCompletion(job.id, 1000);
  assert.equal(completed?.status, 'succeeded');
  assert.equal(completed?.artifacts.length, 1);
  assert.equal(queue.stats().succeeded, 1);
});

test('ImageJobQueue cancels queued jobs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-queue-cancel-'));
  const queue = new ImageJobQueue({
    provider: new MockImageProvider(50),
    artifactStore: new ArtifactStore(root, '/api/v1/artifacts'),
    concurrency: 1,
    maxQueuedJobs: 8,
    logger: createLogger('silent')
  });

  const first = queue.submit(baseRequest({ prompt: 'first' }), builtinWorkflows()[0]!);
  const second = queue.submit(baseRequest({ prompt: 'second' }), builtinWorkflows()[0]!);
  const canceled = await queue.cancel(second.id);
  assert.equal(canceled.status, 'canceled');
  assert.ok(canceled.canceledAt);
  assert.ok(canceled.cancelRequestedAt);
  assert.equal(canceled.cancellationReason, 'User requested cancellation.');
  const canceledDetails = queue.getJob(second.id);
  assert.equal(canceledDetails.status, 'canceled');
  const completed = await queue.waitForCompletion(first.id, 1000);
  assert.equal(completed?.status, 'succeeded');
  assert.equal(queue.stats().canceled, 1);
  assert.ok(queue.listJobs(10).some((job) => job.id === second.id && job.status === 'canceled'));
});

test('ImageJobQueue cancels running jobs without marking them failed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-queue-running-cancel-'));
  const queue = new ImageJobQueue({
    provider: new MockImageProvider(200),
    artifactStore: new ArtifactStore(root, '/api/v1/artifacts'),
    concurrency: 1,
    maxQueuedJobs: 8,
    logger: createLogger('silent')
  });

  const job = queue.submit(baseRequest({ prompt: 'cancel running' }), builtinWorkflows()[0]!);
  for (let attempt = 0; attempt < 20 && queue.getJob(job.id).status !== 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(queue.getJob(job.id).status, 'running');

  const cancelRequested = await queue.cancel(job.id);
  assert.equal(cancelRequested.status, 'running');
  assert.ok(cancelRequested.cancelRequestedAt);
  assert.equal(queue.stats().failed, 0);

  const completed = await queue.waitForCompletion(job.id, 1000);
  assert.equal(completed?.status, 'canceled');
  assert.equal(completed?.error?.code, 'IMAGE_JOB_CANCELED');
  assert.ok(completed?.canceledAt);
  assert.equal(queue.stats().failed, 0);
  assert.equal(queue.stats().canceled, 1);
});
