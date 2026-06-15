import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConfigStore } from '../src/config/store.ts';
import { validateModelDownloadRequest } from '../src/services/image/modelInstaller.ts';
import { calculateJobTimings } from '../src/utils/jobMetrics.ts';
import { mockOllama, tempConfigStore, testRuntimeConfig, withTestServer } from './helpers.ts';

async function tempModelRuntime(overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-management-'));
  const modelRoot = path.join(root, 'models');
  const checkpointDir = path.join(modelRoot, 'checkpoints');
  const loraDir = path.join(modelRoot, 'loras');
  const workflowPath = path.join(root, 'workflows');
  const artifactPath = path.join(root, 'artifacts');
  const configDir = path.join(root, 'config');
  await fs.mkdir(checkpointDir, { recursive: true });
  await fs.mkdir(loraDir, { recursive: true });
  await fs.mkdir(workflowPath, { recursive: true });
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(checkpointDir, 'demo.safetensors'), 'demo');
  await fs.writeFile(path.join(loraDir, 'style.safetensors'), 'lora');

  return {
    root,
    checkpointDir,
    loraDir,
    configPath: path.join(configDir, 'local-ai-images.json'),
    runtimeConfig: testRuntimeConfig({
      imageGenerationEnabled: true,
      imageBackend: 'mock',
      imageModelPaths: [modelRoot],
      imageWorkflowPath: workflowPath,
      imageArtifactPath: artifactPath,
      modelInstallsEnabled: true,
      modelInstallMaxBytes: 1024 * 1024,
      modelCatalogPath: path.join(configDir, 'model-catalog.json'),
      modelDownloadMetadataPath: path.join(configDir, 'model-downloads.json'),
      modelInstallDirectories: {
        checkpoint: checkpointDir,
        lora: loraDir,
        vae: path.join(modelRoot, 'vae'),
        controlnet: path.join(modelRoot, 'controlnet'),
        upscaler: path.join(modelRoot, 'upscale_models'),
        other: modelRoot
      },
      imageDefaultSyncTimeoutMs: 1000,
      ...overrides
    })
  };
}

test('ConfigStore persists and clears default image model separately from legacy default_model', async () => {
  const store = await tempConfigStore('legacy:model');
  await store.updateImageDefaultModel('demo.safetensors');
  assert.deepEqual(await store.readConfig(), { default_model: 'legacy:model', image_default_model: 'demo.safetensors' });

  const reopened = new ConfigStore(store.path, 'fallback:model');
  assert.equal((await reopened.readConfig()).image_default_model, 'demo.safetensors');

  await reopened.clearImageDefaultModel();
  assert.equal((await reopened.readConfig()).image_default_model, '');
});

test('model default endpoints validate checkpoint models and generation uses default when omitted', async () => {
  const env = await tempModelRuntime();
  const store = new ConfigStore(env.configPath, '');
  await withTestServer({
    runtimeConfig: env.runtimeConfig,
    configStore: store,
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return []; } }
  }, async (baseUrl) => {
    const models = await (await fetch(`${baseUrl}/api/v1/models`)).json();
    assert.equal(models.models.find((model: any) => model.fileName === 'demo.safetensors').usableByDefaultWorkflow, true);

    const rejectLora = await fetch(`${baseUrl}/api/v1/models/default`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'style.safetensors' })
    });
    assert.equal(rejectLora.status, 422);

    const setDefault = await (await fetch(`${baseUrl}/api/v1/models/default`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'demo.safetensors' })
    })).json();
    assert.equal(setDefault.ok, true);
    assert.equal(setDefault.default_model, 'demo.safetensors');

    const generated = await (await fetch(`${baseUrl}/api/v1/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'uses default checkpoint', sync_timeout_ms: 1000 })
    })).json();
    assert.equal(generated.job.model, 'demo.safetensors');
    assert.equal(generated.job.request.prompt, 'uses default checkpoint');
    assert.equal(generated.job.timings.queueWaitMs >= 0, true);

    const jobDetails = await (await fetch(`${baseUrl}/api/v1/jobs/${generated.job.id}`)).json();
    assert.equal(jobDetails.ok, true);
    assert.equal(jobDetails.job.request.prompt, 'uses default checkpoint');
    assert.equal(jobDetails.job.artifactCount, 1);

    const cleared = await (await fetch(`${baseUrl}/api/v1/models/default`, { method: 'DELETE' })).json();
    assert.equal(cleared.ok, true);
    assert.equal(cleared.default_model, '');
  });
});

test('model catalog loads runtime catalog entries', async () => {
  const env = await tempModelRuntime();
  await fs.writeFile(env.runtimeConfig.modelCatalogPath, JSON.stringify({
    models: [{
      id: 'demo-xl',
      name: 'Demo XL',
      description: 'A test checkpoint',
      type: 'checkpoint',
      sourceUrl: 'https://example.test/demo-xl',
      downloadUrl: 'https://example.test/demo-xl.safetensors',
      fileName: 'demo-xl.safetensors',
      tags: ['test']
    }]
  }), 'utf8');

  await withTestServer({ runtimeConfig: env.runtimeConfig, configStore: new ConfigStore(env.configPath, ''), ollamaClient: mockOllama() }, async (baseUrl) => {
    const catalog = await (await fetch(`${baseUrl}/api/v1/model-catalog`)).json();
    assert.equal(catalog.ok, true);
    assert.equal(catalog.source, 'runtime');
    assert.equal(catalog.entries[0].id, 'demo-xl');
    assert.equal(catalog.entries[0].type, 'checkpoint');
  });
});

test('model download validation rejects unsafe URL, filename, destination, and existing files', async () => {
  const env = await tempModelRuntime();
  assert.throws(() => validateModelDownloadRequest({ url: 'file:///tmp/model.safetensors', type: 'checkpoint' }, env.runtimeConfig), /http or https/);
  assert.throws(() => validateModelDownloadRequest({ url: 'https://example.test/model.safetensors', type: 'checkpoint', fileName: '../model.safetensors' }, env.runtimeConfig), /path traversal/);
  assert.throws(() => validateModelDownloadRequest({ url: 'https://example.test/model.safetensors', type: 'checkpoint', destination: env.loraDir }, env.runtimeConfig), /approved ComfyUI model directory/);

  await withTestServer({ runtimeConfig: env.runtimeConfig, configStore: new ConfigStore(env.configPath, ''), ollamaClient: mockOllama() }, async (baseUrl) => {
    const existsResponse = await fetch(`${baseUrl}/api/v1/model-downloads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.test/demo.safetensors', type: 'checkpoint', fileName: 'demo.safetensors' })
    });
    assert.equal(existsResponse.status, 409);
  });
});

test('model download streams to .part, records metadata, refreshes inventory, and can set default', async () => {
  const env = await tempModelRuntime();
  const downloadServer = createServer((request, response) => {
    assert.equal(request.url, '/new-model.safetensors');
    const body = Buffer.from('new model bytes');
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': body.byteLength });
    response.end(body);
  });
  await new Promise<void>((resolve) => downloadServer.listen(0, '127.0.0.1', resolve));
  const address = downloadServer.address() as AddressInfo;
  const downloadUrl = `http://127.0.0.1:${address.port}/new-model.safetensors`;

  try {
    const store = new ConfigStore(env.configPath, '');
    await withTestServer({ runtimeConfig: env.runtimeConfig, configStore: store, ollamaClient: mockOllama() }, async (baseUrl) => {
      const started = await (await fetch(`${baseUrl}/api/v1/model-downloads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: downloadUrl, type: 'checkpoint', set_default: true })
      })).json();
      assert.equal(started.ok, true);
      assert.equal(started.job.status, 'queued');

      let job = started.job;
      for (let i = 0; i < 20 && job.status !== 'succeeded' && job.status !== 'failed'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        job = (await (await fetch(`${baseUrl}/api/v1/model-downloads/${started.job.id}`)).json()).job;
      }
      assert.equal(job.status, 'succeeded');
      assert.equal(job.progress, 1);
      assert.equal(await fs.readFile(path.join(env.checkpointDir, 'new-model.safetensors'), 'utf8'), 'new model bytes');
      assert.equal((await store.readConfig()).image_default_model, 'new-model.safetensors');

      const inventory = await (await fetch(`${baseUrl}/api/v1/models`)).json();
      assert.ok(inventory.models.some((model: any) => model.fileName === 'new-model.safetensors'));

      const downloadLog = JSON.parse(await fs.readFile(env.runtimeConfig.modelDownloadMetadataPath, 'utf8'));
      assert.equal(downloadLog[0].fileName, 'new-model.safetensors');
      assert.equal(downloadLog[0].status, 'succeeded');
    });
  } finally {
    await new Promise<void>((resolve, reject) => downloadServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('recent job timing metrics calculate diffusion-specific rates without token metrics', () => {
  const timings = calculateJobTimings({
    createdAt: '2026-06-15T00:00:00.000Z',
    startedAt: '2026-06-15T00:00:02.000Z',
    completedAt: '2026-06-15T00:00:12.000Z',
    request: { steps: 20 }
  });
  assert.equal(timings.queueWaitMs, 2000);
  assert.equal(timings.executionMs, 10000);
  assert.equal(timings.totalMs, 12000);
  assert.equal(timings.secondsPerStep, 0.5);
  assert.equal(timings.stepsPerSecond, 2);
  assert.equal('tokensPerSecond' in timings, false);
});

test('model install/default endpoints honor image API auth', async () => {
  const env = await tempModelRuntime({ imageApiKeys: ['secret'], requireImageApiAuth: true });
  await withTestServer({ runtimeConfig: env.runtimeConfig, configStore: new ConfigStore(env.configPath, ''), ollamaClient: mockOllama() }, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/api/v1/models/default`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'demo.safetensors' })
    });
    assert.equal(missing.status, 401);

    const missingDownload = await fetch(`${baseUrl}/api/v1/model-downloads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.test/secure.safetensors', type: 'checkpoint' })
    });
    assert.equal(missingDownload.status, 401);

    const authorized = await fetch(`${baseUrl}/api/v1/models/default`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: JSON.stringify({ model: 'demo.safetensors' })
    });
    assert.equal(authorized.status, 200);
  });
});
