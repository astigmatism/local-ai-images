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
    favoriteImagePromptsPath: path.join(root, 'favorite-image-prompts.json'),
    imageFavoritesPath: path.join(root, 'image-favorites.json'),
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

    let result;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      result = await (await fetch(`${baseUrl}/api/v1/jobs/${create.job.id}/result?format=metadata`)).json();
      if (result.job.status !== 'queued' && result.job.status !== 'running') break;
    }
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

test('GET /api/v1/jobs paginates image history newest first with a default page size of 9', async () => {
  const runtimeConfig = await tempImageRuntimeConfig({ imageDefaultSyncTimeoutMs: 1000, imageMockDelayMs: 1 });
  await withTestServer({
    runtimeConfig,
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return []; } }
  }, async (baseUrl) => {
    for (let index = 1; index <= 12; index += 1) {
      const generated = await (await fetch(`${baseUrl}/api/v1/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: `paginated job ${index}`, sync_timeout_ms: 1000 })
      })).json();
      assert.equal(generated.ok, true);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const firstPage = await (await fetch(`${baseUrl}/api/v1/jobs`)).json();
    assert.equal(firstPage.ok, true);
    assert.equal(firstPage.page, 1);
    assert.equal(firstPage.pageSize, 9);
    assert.equal(firstPage.jobs.length, 9);
    assert.equal(firstPage.totalItems, 12);
    assert.equal(firstPage.totalPages, 2);
    assert.equal(firstPage.hasNextPage, true);
    assert.equal(firstPage.hasPreviousPage, false);
    assert.equal(firstPage.jobs[0].prompt, 'paginated job 12');
    assert.equal(firstPage.jobs[8].prompt, 'paginated job 4');

    const secondPage = await (await fetch(`${baseUrl}/api/v1/jobs?page=2&pageSize=9`)).json();
    assert.equal(secondPage.ok, true);
    assert.equal(secondPage.page, 2);
    assert.equal(secondPage.jobs.length, 3);
    assert.equal(secondPage.hasNextPage, false);
    assert.equal(secondPage.hasPreviousPage, true);
    assert.deepEqual(secondPage.jobs.map((job: { prompt?: string }) => job.prompt), ['paginated job 3', 'paginated job 2', 'paginated job 1']);

    const byLimit = await (await fetch(`${baseUrl}/api/v1/jobs?limit=12`)).json();
    assert.equal(byLimit.pageSize, 12);
    assert.equal(byLimit.jobs.length, 12);

    const outOfRange = await (await fetch(`${baseUrl}/api/v1/jobs?page=99&pageSize=9`)).json();
    assert.equal(outOfRange.page, 2);
    assert.equal(outOfRange.jobs.length, 3);
  });
});

test('GET /api/v1/jobs paginates durable artifact history after restart', async () => {
  const runtimeConfig = await tempImageRuntimeConfig({ imageDefaultSyncTimeoutMs: 1000, imageMockDelayMs: 1 });

  await withTestServer({
    runtimeConfig,
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return []; } }
  }, async (baseUrl) => {
    for (let index = 1; index <= 10; index += 1) {
      const generated = await (await fetch(`${baseUrl}/api/v1/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: `durable page job ${index}`, sync_timeout_ms: 1000 })
      })).json();
      assert.equal(generated.ok, true);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  });

  await withTestServer({
    runtimeConfig,
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return []; } }
  }, async (baseUrl) => {
    const firstPage = await (await fetch(`${baseUrl}/api/v1/jobs`)).json();
    assert.equal(firstPage.ok, true);
    assert.equal(firstPage.pageSize, 9);
    assert.equal(firstPage.totalItems, 10);
    assert.equal(firstPage.jobs.length, 9);
    assert.equal(firstPage.jobs[0].prompt, 'durable page job 10');

    const secondPage = await (await fetch(`${baseUrl}/api/v1/jobs?page=2&pageSize=9`)).json();
    assert.equal(secondPage.page, 2);
    assert.equal(secondPage.jobs.length, 1);
    assert.equal(secondPage.jobs[0].prompt, 'durable page job 1');
    assert.equal(secondPage.jobs[0].durable, true);
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

test('favorite prompt endpoints persist full image-generation request payloads', async () => {
  const runtimeConfig = await tempImageRuntimeConfig();
  const payload = {
    prompt: 'a favorite glass lighthouse',
    negative_prompt: 'low detail',
    model: 'demo.safetensors',
    workflow_id: 'sdxl-text-to-image',
    width: 768,
    height: 512,
    steps: 18,
    cfg_scale: 6.5,
    seed: 42,
    sampler_name: 'euler',
    scheduler: 'normal',
    output: 'url',
    metadata: { source: 'test-suite' },
    future_provider_field: { preserved: true }
  };
  let favoriteId = '';

  await withTestServer({
    runtimeConfig,
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return []; } }
  }, async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/v1/favorite-prompts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Glass lighthouse favorite', request_payload: payload })
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.equal(created.ok, true);
    assert.equal(created.favorite.prompt, payload.prompt);
    assert.equal(created.favorite.negativePrompt, payload.negative_prompt);
    assert.equal(created.favorite.width, payload.width);
    assert.deepEqual(created.favorite.requestPayload.future_provider_field, { preserved: true });
    favoriteId = created.favorite.id;

    const list = await (await fetch(`${baseUrl}/api/v1/favorite-prompts`)).json();
    assert.equal(list.ok, true);
    assert.equal(list.favorites.length, 1);
    assert.equal(list.favorites[0].title, 'Glass lighthouse favorite');
    assert.equal(list.favorites[0].requestPayload, undefined);

    const single = await (await fetch(`${baseUrl}/api/v1/favorite-prompts/${favoriteId}`)).json();
    assert.equal(single.ok, true);
    assert.equal(single.favorite.requestPayload.prompt, payload.prompt);

    const patched = await (await fetch(`${baseUrl}/api/v1/favorite-prompts/${favoriteId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed favorite', notes: 'kept for regression coverage' })
    })).json();
    assert.equal(patched.favorite.title, 'Renamed favorite');
    assert.equal(patched.favorite.description, 'kept for regression coverage');
  });

  await withTestServer({
    runtimeConfig,
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return []; } }
  }, async (baseUrl) => {
    const persisted = await (await fetch(`${baseUrl}/api/v1/favorite-prompts/${favoriteId}`)).json();
    assert.equal(persisted.ok, true);
    assert.equal(persisted.favorite.title, 'Renamed favorite');
    assert.deepEqual(persisted.favorite.requestPayload.future_provider_field, { preserved: true });

    const deleted = await (await fetch(`${baseUrl}/api/v1/favorite-prompts/${favoriteId}`, { method: 'DELETE' })).json();
    assert.equal(deleted.ok, true);
    const missing = await fetch(`${baseUrl}/api/v1/favorite-prompts/${favoriteId}`);
    assert.equal(missing.status, 404);
  });
});

test.skip('GET /image-generator serves the dedicated generator portal and preload-only frontend asset', async () => {
  await withTestServer({
    runtimeConfig: await tempImageRuntimeConfig(),
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return []; } }
  }, async (baseUrl) => {
    const pageResponse = await fetch(`${baseUrl}/image-generator`);
    assert.equal(pageResponse.status, 200);
    assert.match(pageResponse.headers.get('content-type') ?? '', /text\/html/u);
    const html = await pageResponse.text();
    assert.match(html, /id="image-lab-form"/u);
    assert.match(html, /id="image-lab-gallery"/u);
    assert.match(html, /id="image-lab-model"/u);
    assert.match(html, /id="image-lab-prompt"/u);
    assert.match(html, /id="image-lab-negative"/u);
    assert.match(html, /id="image-lab-width"/u);
    assert.match(html, /id="image-lab-height"/u);
    assert.match(html, /id="image-lab-steps"/u);
    assert.match(html, /id="image-lab-cfg"/u);
    assert.match(html, /id="image-lab-seed"/u);
    assert.match(html, /placeholder="random"/u);
    assert.doesNotMatch(html, /<h1/u);
    assert.doesNotMatch(html, /Dashboard API key/u);
    assert.doesNotMatch(html, /id="image-lab-api-key"/u);
    assert.doesNotMatch(html, /id="image-lab-workflow"/u);
    assert.doesNotMatch(html, /image-lab-workflow-label/u);
    assert.doesNotMatch(html, /image-lab-random-seed/u);
    assert.doesNotMatch(html, /image-lab-prewarm/u);
    assert.match(html, /\/assets\/image-generator\.js/u);

    const scriptResponse = await fetch(`${baseUrl}/assets/image-generator.js`);
    assert.equal(scriptResponse.status, 200);
    assert.match(scriptResponse.headers.get('content-type') ?? '', /application\/javascript/u);
    const script = await scriptResponse.text();
    assert.match(script, /\/api\/v1\/models\/preload/u);
    assert.doesNotMatch(script, /\/api\/v1\/models\/default/u);
    assert.match(script, /\/api\/v1\/image-favorites/u);
  });
});

test('image favorite endpoints persist generated artifact references and full request payloads', async () => {
  const runtimeConfig = await tempImageRuntimeConfig({ imageDefaultSyncTimeoutMs: 1000, imageMockDelayMs: 1 });
  const payload = {
    prompt: 'a persisted gallery favorite',
    negative_prompt: 'low detail',
    model: 'demo.safetensors',
    workflow_id: 'sdxl-text-to-image',
    width: 512,
    height: 512,
    steps: 5,
    cfg_scale: 6,
    seed: 123,
    sampler_name: 'euler',
    scheduler: 'normal',
    output: 'url',
    sync_timeout_ms: 1000,
    future_provider_field: { preserved: true }
  };
  let favoriteId = '';

  await withTestServer({
    runtimeConfig,
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return []; } }
  }, async (baseUrl) => {
    const generateResponse = await fetch(`${baseUrl}/api/v1/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    assert.equal(generateResponse.status, 200);
    const generated = await generateResponse.json() as { ok: boolean; job: Record<string, unknown>; artifacts: Record<string, unknown>[] };
    assert.equal(generated.ok, true);
    assert.equal(generated.job.status, 'succeeded');
    assert.equal(generated.job.model, payload.model);
    assert.equal(generated.job.seed, payload.seed);
    assert.deepEqual((generated.job.requestPayload as Record<string, unknown>).future_provider_field, { preserved: true });
    assert.ok(generated.artifacts[0]?.url);

    const createResponse = await fetch(`${baseUrl}/api/v1/image-favorites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Pinned generated image',
        request_payload: generated.job.requestPayload,
        image_url: generated.artifacts[0]!.url,
        artifact_id: generated.artifacts[0]!.id,
        job_id: generated.job.id,
        artifact: generated.artifacts[0],
        job: generated.job
      })
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json() as { ok: boolean; favorite: Record<string, unknown> };
    assert.equal(created.ok, true);
    assert.equal(created.favorite.title, 'Pinned generated image');
    assert.equal(created.favorite.prompt, payload.prompt);
    assert.equal(created.favorite.negativePrompt, payload.negative_prompt);
    assert.equal(created.favorite.model, payload.model);
    assert.equal(created.favorite.width, payload.width);
    assert.equal(created.favorite.height, payload.height);
    assert.equal(created.favorite.steps, payload.steps);
    assert.equal(created.favorite.cfgScale, payload.cfg_scale);
    assert.equal(created.favorite.seed, payload.seed);
    assert.equal(created.favorite.imageUrl, generated.artifacts[0]!.url);
    assert.deepEqual((created.favorite.requestPayload as Record<string, unknown>).future_provider_field, { preserved: true });
    favoriteId = String(created.favorite.id);

    const list = await (await fetch(`${baseUrl}/api/v1/image-favorites`)).json() as { ok: boolean; favorites: Record<string, unknown>[] };
    assert.equal(list.ok, true);
    assert.equal(list.favorites.length, 1);
    assert.equal(list.favorites[0]!.requestPayload, undefined);
    assert.equal(list.favorites[0]!.artifactId, generated.artifacts[0]!.id);

    const single = await (await fetch(`${baseUrl}/api/v1/image-favorites/${favoriteId}`)).json() as { ok: boolean; favorite: Record<string, unknown> };
    assert.equal(single.ok, true);
    assert.equal((single.favorite.requestPayload as Record<string, unknown>).prompt, payload.prompt);
    assert.equal((single.favorite.job as Record<string, unknown>).id, generated.job.id);
  });

  await withTestServer({
    runtimeConfig,
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return []; } }
  }, async (baseUrl) => {
    const persisted = await (await fetch(`${baseUrl}/api/v1/image-favorites/${favoriteId}`)).json() as { ok: boolean; favorite: Record<string, unknown> };
    assert.equal(persisted.ok, true);
    assert.deepEqual((persisted.favorite.requestPayload as Record<string, unknown>).future_provider_field, { preserved: true });

    const patched = await (await fetch(`${baseUrl}/api/v1/image-favorites/${favoriteId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed pinned image', notes: 'loaded from compact favorites strip' })
    })).json() as { ok: boolean; favorite: Record<string, unknown> };
    assert.equal(patched.ok, true);
    assert.equal(patched.favorite.title, 'Renamed pinned image');
    assert.equal(patched.favorite.description, 'loaded from compact favorites strip');

    const deleted = await (await fetch(`${baseUrl}/api/v1/image-favorites/${favoriteId}`, { method: 'DELETE' })).json() as { ok: boolean; deleted_id: string };
    assert.equal(deleted.ok, true);
    assert.equal(deleted.deleted_id, favoriteId);
    const missing = await fetch(`${baseUrl}/api/v1/image-favorites/${favoriteId}`);
    assert.equal(missing.status, 404);
  });
});
