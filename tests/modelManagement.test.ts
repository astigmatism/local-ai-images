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

    const recentJobs = await (await fetch(`${baseUrl}/api/v1/jobs?limit=5`)).json();
    const listedJob = recentJobs.jobs.find((job: any) => job.id === generated.job.id);
    assert.ok(listedJob);
    assert.equal(listedJob.prompt, 'uses default checkpoint');
    assert.equal(listedJob.request.prompt, 'uses default checkpoint');
    assert.equal(listedJob.artifacts.length, 1);
    assert.ok(listedJob.thumbnailUrl);
    assert.equal(typeof listedJob.timings.totalMs, 'number');

    const cleared = await (await fetch(`${baseUrl}/api/v1/models/default`, { method: 'DELETE' })).json();
    assert.equal(cleared.ok, true);
    assert.equal(cleared.default_model, '');
  });
});


test('model lifecycle controls stay enabled when IMAGE_MODEL_PATHS points directly at checkpoints', async () => {
  const env = await tempModelRuntime();
  const runtimeConfig = testRuntimeConfig({
    ...env.runtimeConfig,
    imageModelPaths: [env.checkpointDir]
  });
  const store = new ConfigStore(env.configPath, '');

  await withTestServer({ runtimeConfig, configStore: store, ollamaClient: mockOllama() }, async (baseUrl) => {
    const inventory = await (await fetch(`${baseUrl}/api/v1/models`)).json();
    const demo = inventory.models.find((model: any) => model.fileName === 'demo.safetensors');
    assert.ok(demo);
    assert.equal(demo.type, 'checkpoint');
    assert.equal(demo.canSetDefault, true);
    assert.equal(demo.canPreload, true);
    assert.equal(demo.loadedStatus, 'not_confirmed_loaded');

    const setDefault = await fetch(`${baseUrl}/api/v1/models/default`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'demo.safetensors' })
    });
    assert.equal(setDefault.status, 200);
    assert.equal((await store.readConfig()).image_default_model, 'demo.safetensors');
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

test('ConfigStore persists image default preload-on-startup setting', async () => {
  const store = await tempConfigStore('legacy:model');
  await store.updateImageDefaultModel('demo.safetensors');
  await store.updateImagePreloadDefaultOnStartup(true);

  const config = await store.readConfig();
  assert.equal(config.default_model, 'legacy:model');
  assert.equal(config.image_default_model, 'demo.safetensors');
  assert.equal(config.image_preload_default_on_startup, true);

  const reopened = new ConfigStore(store.path, 'fallback:model');
  assert.equal((await reopened.readConfig()).image_preload_default_on_startup, true);

  await reopened.updateImagePreloadDefaultOnStartup(false);
  assert.equal((await reopened.readConfig()).image_preload_default_on_startup, false);
});

test('top-level checkpoint files expose load and default actions from checkpoint and flat scan roots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-scan-top-level-'));
  const checkpointRoot = path.join(root, 'ComfyUI', 'models', 'checkpoints');
  const flatModelRoot = path.join(root, 'flat-model-root');
  const loraDir = path.join(root, 'ComfyUI', 'models', 'loras');
  const workflowPath = path.join(root, 'workflows');
  const artifactPath = path.join(root, 'artifacts');
  const configPath = path.join(root, 'config.json');
  await fs.mkdir(checkpointRoot, { recursive: true });
  await fs.mkdir(flatModelRoot, { recursive: true });
  await fs.mkdir(loraDir, { recursive: true });
  await fs.mkdir(workflowPath, { recursive: true });
  await fs.mkdir(artifactPath, { recursive: true });
  await fs.writeFile(path.join(checkpointRoot, 'direct-checkpoint.safetensors'), 'checkpoint');
  await fs.writeFile(path.join(flatModelRoot, 'flat-checkpoint.ckpt'), 'checkpoint');

  const runtimeConfig = testRuntimeConfig({
    imageGenerationEnabled: true,
    imageBackend: 'mock',
    imageModelPaths: [checkpointRoot, flatModelRoot],
    imageWorkflowPath: workflowPath,
    imageArtifactPath: artifactPath,
    modelInstallsEnabled: true,
    modelInstallMaxBytes: 1024 * 1024,
    modelCatalogPath: path.join(root, 'model-catalog.json'),
    modelDownloadMetadataPath: path.join(root, 'model-downloads.json'),
    modelInstallDirectories: {
      checkpoint: checkpointRoot,
      lora: loraDir,
      vae: path.join(root, 'ComfyUI', 'models', 'vae'),
      controlnet: path.join(root, 'ComfyUI', 'models', 'controlnet'),
      upscaler: path.join(root, 'ComfyUI', 'models', 'upscale_models'),
      other: flatModelRoot
    },
    imageDefaultSyncTimeoutMs: 1000
  });

  await withTestServer({ runtimeConfig, configStore: new ConfigStore(configPath, ''), ollamaClient: mockOllama() }, async (baseUrl) => {
    const inventory = await (await fetch(`${baseUrl}/api/v1/models`)).json();
    for (const fileName of ['direct-checkpoint.safetensors', 'flat-checkpoint.ckpt']) {
      const model = inventory.models.find((item: any) => item.fileName === fileName);
      assert.ok(model, `${fileName} should be present in inventory`);
      assert.equal(model.type, 'checkpoint');
      assert.equal(model.canSetDefault, true);
      assert.equal(model.canPreload, true);
      assert.equal(model.loadedStatus, 'not_confirmed_loaded');
    }

    const setDefault = await (await fetch(`${baseUrl}/api/v1/models/default`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'direct-checkpoint.safetensors' })
    })).json();
    assert.equal(setDefault.ok, true);
    assert.equal(setDefault.default_model, 'direct-checkpoint.safetensors');

    const preloaded = await (await fetch(`${baseUrl}/api/v1/models/preload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'flat-checkpoint.ckpt' })
    })).json();
    assert.equal(preloaded.ok, true);
    assert.equal(preloaded.preload.lastConfirmedLoadedModel, 'flat-checkpoint.ckpt');
  });
});

test('GET /api/v1/models exposes default, preload, delete, missing, and loaded state', async () => {
  const env = await tempModelRuntime();
  const store = new ConfigStore(env.configPath, '');
  await store.updateImageDefaultModel('missing.safetensors');
  await store.updateImagePreloadDefaultOnStartup(true);

  await withTestServer({ runtimeConfig: env.runtimeConfig, configStore: store, ollamaClient: mockOllama() }, async (baseUrl) => {
    const missing = await (await fetch(`${baseUrl}/api/v1/models`)).json();
    assert.equal(missing.defaultModel, 'missing.safetensors');
    assert.equal(missing.defaultStatus.defaultFileExists, false);
    assert.equal(missing.defaultStatus.preloadOnStartup, true);
    assert.match(missing.defaultStatus.defaultWarning, /missing\.safetensors/);

    const initialDemo = missing.models.find((model: any) => model.fileName === 'demo.safetensors');
    assert.equal(initialDemo.isDefault, false);
    assert.equal(initialDemo.canSetDefault, true);
    assert.equal(initialDemo.canPreload, true);
    assert.equal(initialDemo.canDelete, true);
    assert.equal(initialDemo.loadedStatus, 'not_confirmed_loaded');
    assert.equal(initialDemo.deletePreview.confirmationValue, 'demo.safetensors');

    const lora = missing.models.find((model: any) => model.fileName === 'style.safetensors');
    assert.equal(lora.canSetDefault, false);
    assert.equal(lora.canPreload, false);
    assert.equal(lora.loadedStatus, 'not_applicable');

    const setDefault = await (await fetch(`${baseUrl}/api/v1/models/default`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'demo.safetensors', preload_on_startup: true })
    })).json();
    assert.equal(setDefault.ok, true);
    assert.equal(setDefault.default_model, 'demo.safetensors');
    assert.equal(setDefault.preload_on_startup, true);

    const configured = await (await fetch(`${baseUrl}/api/v1/models`)).json();
    const configuredDemo = configured.models.find((model: any) => model.fileName === 'demo.safetensors');
    assert.equal(configured.defaultModel, 'demo.safetensors');
    assert.equal(configured.preload.preloadOnStartup, true);
    assert.equal(configuredDemo.isDefault, true);
    assert.equal(configuredDemo.isLastConfirmedLoaded, false);
    assert.equal(configuredDemo.loadedStatus, 'default_not_confirmed_loaded');

    const generated = await (await fetch(`${baseUrl}/api/v1/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'generation confirms loaded checkpoint', sync_timeout_ms: 1000 })
    })).json();
    assert.equal(generated.ok, true);
    assert.equal(generated.job.model, 'demo.safetensors');

    const loaded = await (await fetch(`${baseUrl}/api/v1/models`)).json();
    const loadedDemo = loaded.models.find((model: any) => model.fileName === 'demo.safetensors');
    assert.equal(loadedDemo.isLastConfirmedLoaded, true);
    assert.equal(loadedDemo.loadedStatus, 'last_confirmed_loaded');
    assert.equal(loaded.preload.lastConfirmedLoadedModel, 'demo.safetensors');
    assert.equal(loaded.preload.lastConfirmedLoadedSource, 'generation');
  });
});

test('model preload endpoints validate input and record success and failure status', async () => {
  const env = await tempModelRuntime();
  const store = new ConfigStore(env.configPath, '');

  await withTestServer({ runtimeConfig: env.runtimeConfig, configStore: store, ollamaClient: mockOllama() }, async (baseUrl) => {
    const missingDefault = await fetch(`${baseUrl}/api/v1/models/preload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(missingDefault.status, 422);
    const missingDefaultBody = await missingDefault.json();
    assert.equal(missingDefaultBody.error.code, 'MODEL_PRELOAD_MODEL_REQUIRED');
    assert.equal(missingDefaultBody.preload.lastPreloadResult, 'not_attempted');
    assert.equal(missingDefaultBody.preload.lastPreloadError, null);

    const rejectLora = await fetch(`${baseUrl}/api/v1/models/preload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'style.safetensors' })
    });
    assert.equal(rejectLora.status, 422);

    const invalidStartup = await fetch(`${baseUrl}/api/v1/models/preload/startup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(invalidStartup.status, 422);

    const startup = await (await fetch(`${baseUrl}/api/v1/models/preload/startup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true })
    })).json();
    assert.equal(startup.ok, true);
    assert.equal(startup.preload.preloadOnStartup, true);
    assert.equal((await store.readConfig()).image_preload_default_on_startup, true);

    const success = await (await fetch(`${baseUrl}/api/v1/models/preload`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'demo.safetensors', set_default: true })
    })).json();
    assert.equal(success.ok, true);
    assert.equal(success.preload.lastPreloadResult, 'succeeded');
    assert.equal(success.preload.lastPreloadModel, 'demo.safetensors');
    assert.equal(success.preload.lastConfirmedLoadedModel, 'demo.safetensors');
    assert.equal(success.preload.lastConfirmedLoadedSource, 'manual_preload');
    assert.equal((await store.readConfig()).image_default_model, 'demo.safetensors');
  });

  const failureEnv = await tempModelRuntime({
    imageBackend: 'comfyui',
    imagePreloadTimeoutMs: 100,
    comfyUiPollIntervalMs: 10
  });
  const unavailableServer = createServer((_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not ready' }));
  });
  await new Promise<void>((resolve) => unavailableServer.listen(0, '127.0.0.1', resolve));
  const address = unavailableServer.address() as AddressInfo;
  const failureConfig = {
    ...failureEnv.runtimeConfig,
    comfyUiBaseUrl: `http://127.0.0.1:${address.port}`
  };
  const failureStore = new ConfigStore(failureEnv.configPath, '');
  await failureStore.updateImageDefaultModel('demo.safetensors');

  try {
    await withTestServer({ runtimeConfig: failureConfig, configStore: failureStore, ollamaClient: mockOllama() }, async (baseUrl) => {
      const failed = await fetch(`${baseUrl}/api/v1/models/preload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      assert.notEqual(failed.status, 200);
      const status = await (await fetch(`${baseUrl}/api/v1/models/preload`)).json();
      assert.equal(status.lastPreloadResult, 'failed');
      assert.ok(status.lastPreloadError.code);
      assert.equal(status.lastPreloadModel, 'demo.safetensors');
    });
  } finally {
    await new Promise<void>((resolve, reject) => unavailableServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('safe delete endpoint validates approved paths, confirmations, default handling, and inventory refresh', async () => {
  const env = await tempModelRuntime();
  const unapprovedRoot = path.join(env.root, 'unapproved-models');
  const unapprovedCheckpointDir = path.join(unapprovedRoot, 'checkpoints');
  await fs.mkdir(unapprovedCheckpointDir, { recursive: true });
  await fs.writeFile(path.join(unapprovedCheckpointDir, 'unsafe.safetensors'), 'unsafe');

  const runtimeConfig = testRuntimeConfig({
    ...env.runtimeConfig,
    imageModelPaths: [...env.runtimeConfig.imageModelPaths, unapprovedRoot]
  });
  const store = new ConfigStore(env.configPath, '');

  await withTestServer({ runtimeConfig, configStore: store, ollamaClient: mockOllama() }, async (baseUrl) => {
    const inventory = await (await fetch(`${baseUrl}/api/v1/models`)).json();
    const unsafe = inventory.models.find((model: any) => model.fileName === 'unsafe.safetensors');
    assert.equal(unsafe.canDelete, false);

    const missingConfirmation = await fetch(`${baseUrl}/api/v1/models/${encodeURIComponent('demo.safetensors')}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(missingConfirmation.status, 422);

    const wrongConfirmation = await fetch(`${baseUrl}/api/v1/models/${encodeURIComponent('demo.safetensors')}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm_file_name: 'wrong.safetensors' })
    });
    assert.equal(wrongConfirmation.status, 422);

    const unsafeDelete = await fetch(`${baseUrl}/api/v1/models/${encodeURIComponent('unsafe.safetensors')}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm_file_name: 'unsafe.safetensors' })
    });
    assert.equal(unsafeDelete.status, 403);
    assert.equal(await fs.readFile(path.join(unapprovedCheckpointDir, 'unsafe.safetensors'), 'utf8'), 'unsafe');

    const defaultResponse = await fetch(`${baseUrl}/api/v1/models/default`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'demo.safetensors' })
    });
    assert.equal(defaultResponse.status, 200);

    const blockedDefaultDelete = await fetch(`${baseUrl}/api/v1/models/${encodeURIComponent('demo.safetensors')}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm_file_name: 'demo.safetensors' })
    });
    assert.equal(blockedDefaultDelete.status, 409);
    assert.equal(await fs.readFile(path.join(env.checkpointDir, 'demo.safetensors'), 'utf8'), 'demo');

    const deleted = await (await fetch(`${baseUrl}/api/v1/models/${encodeURIComponent('demo.safetensors')}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm_file_name: 'demo.safetensors', delete_and_clear_default: true })
    })).json();
    assert.equal(deleted.ok, true);
    assert.equal(deleted.clearedDefault, true);
    await assert.rejects(fs.stat(path.join(env.checkpointDir, 'demo.safetensors')), /ENOENT/);
    assert.equal((await store.readConfig()).image_default_model, '');
    assert.equal(deleted.inventory.models.some((model: any) => model.fileName === 'demo.safetensors'), false);

    const refreshed = await (await fetch(`${baseUrl}/api/v1/models`)).json();
    assert.equal(refreshed.models.some((model: any) => model.fileName === 'demo.safetensors'), false);
  });
});
