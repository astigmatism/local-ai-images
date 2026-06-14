import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AppError } from '../src/errors.ts';
import { mockOllama, sampleGpu0, tempConfigStore, testRuntimeConfig, withTestServer } from './helpers.ts';

async function tempImageRuntimeConfig(overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-api-v1-'));
  const modelPath = path.join(root, 'models');
  const workflowPath = path.join(root, 'workflows');
  const artifactPath = path.join(root, 'artifacts');
  await fs.mkdir(path.join(modelPath, 'checkpoints'), { recursive: true });
  await fs.mkdir(workflowPath, { recursive: true });
  await fs.writeFile(path.join(modelPath, 'checkpoints', 'demo.safetensors'), 'demo');

  return testRuntimeConfig({
    imageGenerationEnabled: true,
    imageBackend: 'mock',
    imageModelPaths: [modelPath],
    imageWorkflowPath: workflowPath,
    imageArtifactPath: artifactPath,
    imageDefaultSyncTimeoutMs: 0,
    imageMaxSyncTimeoutMs: 2000,
    imageMockDelayMs: 1,
    ...overrides
  });
}

test('GET /api/v1/health and /api/v1/stats report engine, GPU, and queue state', async () => {
  await withTestServer({
    runtimeConfig: await tempImageRuntimeConfig(),
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return [sampleGpu0]; } }
  }, async (baseUrl) => {
    const health = await (await fetch(`${baseUrl}/api/v1/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.backend, 'mock');
    assert.equal(health.engine.ok, true);
    assert.equal(health.gpu.ok, true);
    assert.equal(health.queue.total, 0);

    const stats = await (await fetch(`${baseUrl}/api/v1/stats`)).json();
    assert.equal(stats.ok, true);
    assert.equal(stats.gpu.gpus[0].name, sampleGpu0.name);
  });
});

test('GET /api/v1/stats reports no-GPU and missing-driver failures without crashing the API', async () => {
  await withTestServer({
    runtimeConfig: await tempImageRuntimeConfig(),
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { throw new AppError('NVIDIA_SMI_UNAVAILABLE', 'nvidia-smi is not installed or is not on PATH', 503); } }
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/stats`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.gpu.ok, false);
    assert.equal(body.gpu.error.code, 'NVIDIA_SMI_UNAVAILABLE');
  });
});

test('GET /api/v1/models and POST /api/v1/models/refresh scan configured model paths', async () => {
  await withTestServer({
    runtimeConfig: await tempImageRuntimeConfig(),
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return []; } }
  }, async (baseUrl) => {
    const first = await (await fetch(`${baseUrl}/api/v1/models`)).json();
    assert.equal(first.ok, true);
    assert.equal(first.models.length, 1);
    assert.equal(first.models[0].type, 'checkpoint');

    const refreshed = await (await fetch(`${baseUrl}/api/v1/models/refresh`, { method: 'POST' })).json();
    assert.equal(refreshed.ok, true);
    assert.equal(refreshed.models[0].extension, '.safetensors');
  });
});

test('GET /api/v1/workflows returns stable preset metadata without exposing raw ComfyUI prompt JSON', async () => {
  await withTestServer({
    runtimeConfig: await tempImageRuntimeConfig(),
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return []; } }
  }, async (baseUrl) => {
    const list = await (await fetch(`${baseUrl}/api/v1/workflows`)).json();
    assert.equal(list.ok, true);
    assert.ok(list.workflows.some((workflow: any) => workflow.id === 'sdxl-text-to-image'));
    assert.equal(list.workflows[0].comfyui, undefined);

    const detail = await (await fetch(`${baseUrl}/api/v1/workflows/sdxl-text-to-image`)).json();
    assert.equal(detail.ok, true);
    assert.equal(detail.workflow.id, 'sdxl-text-to-image');
    assert.equal(detail.workflow.comfyui, undefined);
    assert.ok(detail.workflow.mappings.positivePromptNode);
  });
});

test('POST /api/v1/generate can complete synchronously and return URL/base64/binary artifact delivery', async () => {
  await withTestServer({
    runtimeConfig: await tempImageRuntimeConfig({ imageDefaultSyncTimeoutMs: 1000 }),
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return []; } }
  }, async (baseUrl) => {
    const urlResponse = await fetch(`${baseUrl}/api/v1/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a glass lighthouse', output: 'url', sync_timeout_ms: 1000 })
    });
    assert.equal(urlResponse.status, 200);
    const urlBody = await urlResponse.json();
    assert.equal(urlBody.ok, true);
    assert.equal(urlBody.job.status, 'succeeded');
    assert.ok(urlBody.artifacts[0].url.startsWith('/api/v1/artifacts/'));

    const artifactId = urlBody.artifacts[0].id;
    const artifact = await fetch(`${baseUrl}/api/v1/artifacts/${artifactId}`);
    assert.equal(artifact.status, 200);
    assert.equal(artifact.headers.get('content-type'), 'image/png');
    assert.ok((await artifact.arrayBuffer()).byteLength > 0);

    const metadata = await (await fetch(`${baseUrl}/api/v1/artifacts/${artifactId}?metadata=1`)).json();
    assert.equal(metadata.ok, true);
    assert.equal(metadata.artifact.prompt, 'a glass lighthouse');
    assert.equal(metadata.artifact.filePath, undefined);

    const base64Body = await (await fetch(`${baseUrl}/api/v1/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a copper moon', output: 'base64', sync_timeout_ms: 1000 })
    })).json();
    assert.equal(typeof base64Body.artifacts[0].base64, 'string');

    const binary = await fetch(`${baseUrl}/api/v1/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a binary image', output: 'binary', sync_timeout_ms: 1000 })
    });
    assert.equal(binary.status, 200);
    assert.equal(binary.headers.get('content-type'), 'image/png');
  });
});

test('POST /api/v1/generate supports async jobs, job result polling, and cancellation', async () => {
  await withTestServer({
    runtimeConfig: await tempImageRuntimeConfig({ imageMockDelayMs: 25 }),
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return []; } }
  }, async (baseUrl) => {
    const create = await (await fetch(`${baseUrl}/api/v1/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'async job', sync_timeout_ms: 0 })
    })).json();
    assert.equal(create.ok, true);
    assert.equal(create.job.status, 'queued');

    let job = await (await fetch(`${baseUrl}/api/v1/jobs/${create.job.id}`)).json();
    assert.equal(job.ok, true);

    await new Promise((resolve) => setTimeout(resolve, 80));
    const result = await (await fetch(`${baseUrl}/api/v1/jobs/${create.job.id}/result?format=metadata`)).json();
    assert.equal(result.ok, true);
    assert.equal(result.job.status, 'succeeded');

    const cancelCreate = await (await fetch(`${baseUrl}/api/v1/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'cancel me', sync_timeout_ms: 0 })
    })).json();
    const canceled = await (await fetch(`${baseUrl}/api/v1/jobs/${cancelCreate.job.id}/cancel`, { method: 'POST' })).json();
    assert.equal(canceled.ok, true);
    assert.ok(['canceled', 'succeeded'].includes(canceled.job.status));

    const list = await (await fetch(`${baseUrl}/api/v1/jobs`)).json();
    assert.equal(list.ok, true);
    assert.ok(list.jobs.length >= 2);
  });
});

test('configured image API keys enforce bearer or X-API-Key authentication', async () => {
  await withTestServer({
    runtimeConfig: await tempImageRuntimeConfig({ imageApiKeys: ['secret'], requireImageApiAuth: true }),
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return []; } }
  }, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/api/v1/health`);
    assert.equal(missing.status, 401);
    const invalid = await fetch(`${baseUrl}/api/v1/health`, { headers: { authorization: 'Bearer wrong' } });
    assert.equal(invalid.status, 403);
    const bearer = await fetch(`${baseUrl}/api/v1/health`, { headers: { authorization: 'Bearer secret' } });
    assert.equal(bearer.status, 200);
    const xApiKey = await fetch(`${baseUrl}/api/v1/capabilities`, { headers: { 'x-api-key': 'secret' } });
    assert.equal(xApiKey.status, 200);
  });
});
