import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mockOllama, tempConfigStore, testRuntimeConfig, withTestServer } from './helpers.ts';

async function tempGeneratorRuntimeConfig(overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'image-generator-'));
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
    generationSourceMetadataPath: path.join(root, 'generation-source-metadata.json'),
    imageDefaultSyncTimeoutMs: 1000,
    imageMaxSyncTimeoutMs: 2000,
    imageMockDelayMs: 1,
    ...overrides
  });
}

test('image favorite endpoints persist generated artifacts and full request payloads', async () => {
  const runtimeConfig = await tempGeneratorRuntimeConfig();

  await withTestServer({
    runtimeConfig,
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return []; } }
  }, async (baseUrl) => {
    const generated = await (await fetch(`${baseUrl}/api/v1/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'a favorite crystal observatory',
        negative_prompt: 'blur, low detail',
        llm_image_prompt_guidance: 'make it crystalline, cinematic, and observatory-themed',
        model: 'demo.safetensors',
        workflow_id: 'sdxl-text-to-image',
        width: 1024,
        height: 1024,
        steps: 24,
        cfg_scale: 7.5,
        seed: -1,
        sampler_name: 'euler',
        scheduler: 'normal',
        output: 'url',
        sync_timeout_ms: 1000,
        metadata: { llmImagePromptGuidance: 'make it crystalline, cinematic, and observatory-themed' },
        future_provider_field: { preserved: true }
      })
    })).json();

    assert.equal(generated.ok, true);
    assert.equal(generated.job.status, 'succeeded');
    assert.equal(generated.job.requestPayload.prompt, 'a favorite crystal observatory');
    assert.equal(generated.job.requestPayload.llm_image_prompt_guidance, 'make it crystalline, cinematic, and observatory-themed');
    assert.equal(generated.job.metadata.llmImagePromptGuidance, 'make it crystalline, cinematic, and observatory-themed');
    assert.notEqual(generated.job.requestPayload.seed, -1);
    assert.ok(generated.artifacts[0].url.startsWith('/api/v1/artifacts/'));

    const createdResponse = await fetch(`${baseUrl}/api/v1/image-favorites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Crystal observatory favorite',
        request_payload: generated.job.requestPayload,
        artifact_id: generated.artifacts[0].id,
        artifact_url: generated.artifacts[0].url,
        image_url: generated.artifacts[0].url,
        artifact: generated.artifacts[0],
        artifacts: generated.artifacts,
        job_id: generated.job.id,
        job: generated.job,
        metadata: { source: 'test' }
      })
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.ok, true);
    assert.equal(created.favorite.title, 'Crystal observatory favorite');
    assert.equal(created.favorite.prompt, 'a favorite crystal observatory');
    assert.equal(created.favorite.negativePrompt, 'blur, low detail');
    assert.equal(created.favorite.llmImagePromptGuidance, 'make it crystalline, cinematic, and observatory-themed');
    assert.equal(created.favorite.llmImagePromptGuidancePreview, 'make it crystalline, cinematic, and observatory-themed');
    assert.equal(created.favorite.model, 'demo.safetensors');
    assert.equal(created.favorite.width, 1024);
    assert.equal(created.favorite.height, 1024);
    assert.equal(created.favorite.steps, 24);
    assert.equal(created.favorite.cfgScale, 7.5);
    assert.equal(created.favorite.sampler, 'euler');
    assert.equal(created.favorite.scheduler, 'normal');
    assert.equal(created.favorite.seed, generated.job.requestPayload.seed);
    assert.equal(created.favorite.artifactId, generated.artifacts[0].id);
    assert.equal(created.favorite.imageUrl, generated.artifacts[0].url);
    assert.deepEqual(created.favorite.requestPayload.future_provider_field, { preserved: true });
    assert.equal(created.favorite.requestPayload.llm_image_prompt_guidance, 'make it crystalline, cinematic, and observatory-themed');

    const list = await (await fetch(`${baseUrl}/api/v1/image-favorites?limit=10`)).json();
    assert.equal(list.ok, true);
    assert.equal(list.favorites.length, 1);
    assert.equal(list.favorites[0].requestPayload, undefined);
    assert.equal(list.favorites[0].llmImagePromptGuidance, 'make it crystalline, cinematic, and observatory-themed');
    assert.equal(list.favorites[0].artifactId, generated.artifacts[0].id);

    const single = await (await fetch(`${baseUrl}/api/v1/image-favorites/${created.favorite.id}`)).json();
    assert.equal(single.ok, true);
    assert.equal(single.favorite.requestPayload.prompt, 'a favorite crystal observatory');
    assert.equal(single.favorite.requestPayload.llm_image_prompt_guidance, 'make it crystalline, cinematic, and observatory-themed');
    assert.equal(single.favorite.job.id, generated.job.id);

    const patched = await (await fetch(`${baseUrl}/api/v1/image-favorites/${created.favorite.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Renamed favorite', notes: 'kept for regeneration' })
    })).json();
    assert.equal(patched.favorite.title, 'Renamed favorite');
    assert.equal(patched.favorite.description, 'kept for regeneration');

    const deleted = await (await fetch(`${baseUrl}/api/v1/image-favorites/${created.favorite.id}`, { method: 'DELETE' })).json();
    assert.equal(deleted.ok, true);
    assert.equal(deleted.deleted_id, created.favorite.id);

    const missing = await fetch(`${baseUrl}/api/v1/image-favorites/${created.favorite.id}`);
    assert.equal(missing.status, 404);
  });
});

test('image favorites resolve stale random request payload seeds from completed job metadata', async () => {
  const runtimeConfig = await tempGeneratorRuntimeConfig();

  await withTestServer({
    runtimeConfig,
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return []; } }
  }, async (baseUrl) => {
    const generated = await (await fetch(`${baseUrl}/api/v1/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt: 'a favorite with a resolved random seed',
        negative_prompt: 'low detail',
        model: 'demo.safetensors',
        workflow_id: 'sdxl-text-to-image',
        width: 768,
        height: 768,
        steps: 18,
        cfg_scale: 6.5,
        seed: -1,
        sampler_name: 'euler',
        scheduler: 'normal',
        output: 'url',
        sync_timeout_ms: 1000
      })
    })).json();

    assert.equal(generated.ok, true);
    const actualSeed = generated.job.seed;
    assert.equal(Number.isSafeInteger(actualSeed), true);
    assert.notEqual(actualSeed, -1);

    const staleRandomPayload = { ...generated.job.requestPayload, seed: -1 };
    const created = await (await fetch(`${baseUrl}/api/v1/image-favorites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Resolved random seed favorite',
        request_payload: staleRandomPayload,
        image_url: generated.artifacts[0].url,
        artifact_id: generated.artifacts[0].id,
        artifact: generated.artifacts[0],
        job_id: generated.job.id,
        job: generated.job
      })
    })).json();

    assert.equal(created.ok, true);
    assert.equal(created.favorite.seed, actualSeed);
    assert.equal(created.favorite.requestPayload.seed, actualSeed);
    assert.notEqual(created.favorite.requestPayload.seed, -1);

    const regenerated = await (await fetch(`${baseUrl}/api/v1/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(created.favorite.requestPayload)
    })).json();
    assert.equal(regenerated.ok, true);
    assert.equal(regenerated.job.seed, actualSeed);

    const nestedSeed = 246813579;
    const nested = await (await fetch(`${baseUrl}/api/v1/image-favorites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Nested string seed favorite',
        request_payload: {
          prompt: 'nested string seed favorite',
          negative_prompt: 'noise',
          model: 'demo.safetensors',
          workflow_id: 'sdxl-text-to-image',
          width: 512,
          height: 512,
          steps: 10,
          cfg_scale: 5,
          seed: -1,
          sampler_name: 'euler',
          scheduler: 'normal',
          output: 'url',
          sync_timeout_ms: 0
        },
        image_url: '/api/v1/artifacts/nested-string-seed',
        artifact_id: 'nested-string-seed',
        job: {
          id: 'nested-string-seed-job',
          metadata: { seedUsed: String(nestedSeed) }
        }
      })
    })).json();
    assert.equal(nested.ok, true);
    assert.equal(nested.favorite.seed, nestedSeed);
    assert.equal(nested.favorite.requestPayload.seed, nestedSeed);

    const missingSeed = await fetch(`${baseUrl}/api/v1/image-favorites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_payload: {
          prompt: 'missing actual seed favorite',
          model: 'demo.safetensors',
          workflow_id: 'sdxl-text-to-image',
          width: 512,
          height: 512,
          steps: 8,
          cfg_scale: 5,
          seed: -1,
          sampler_name: 'euler',
          scheduler: 'normal',
          output: 'url',
          sync_timeout_ms: 0
        },
        image_url: '/api/v1/artifacts/missing-actual-seed'
      })
    });
    assert.equal(missingSeed.status, 422);
    const missingSeedBody = await missingSeed.json();
    assert.equal(missingSeedBody.error.code, 'IMAGE_FAVORITE_ACTUAL_SEED_REQUIRED');
  });
});

test('image favorites without LLM guidance remain backward compatible', async () => {
  const runtimeConfig = await tempGeneratorRuntimeConfig();

  await withTestServer({
    runtimeConfig,
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return []; } }
  }, async (baseUrl) => {
    const created = await (await fetch(`${baseUrl}/api/v1/image-favorites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Legacy favorite without guidance',
        request_payload: {
          prompt: 'legacy favorite prompt',
          negative_prompt: 'legacy negative',
          model: 'demo.safetensors',
          workflow_id: 'sdxl-text-to-image',
          width: 512,
          height: 512,
          steps: 12,
          cfg_scale: 6,
          seed: 12345,
          sampler_name: 'euler',
          scheduler: 'normal',
          output: 'url',
          sync_timeout_ms: 0
        },
        image_url: '/api/v1/artifacts/legacy-no-guidance',
        artifact_id: 'legacy-no-guidance'
      })
    })).json();

    assert.equal(created.ok, true);
    assert.equal(created.favorite.prompt, 'legacy favorite prompt');
    assert.equal(created.favorite.negativePrompt, 'legacy negative');
    assert.equal(created.favorite.llmImagePromptGuidance, null);
    assert.equal(created.favorite.llmImagePromptGuidancePreview, null);

    const single = await (await fetch(`${baseUrl}/api/v1/image-favorites/${created.favorite.id}`)).json();
    assert.equal(single.ok, true);
    assert.equal(single.favorite.requestPayload.prompt, 'legacy favorite prompt');
    assert.equal(single.favorite.requestPayload.llm_image_prompt_guidance, undefined);
    assert.equal(single.favorite.llmImagePromptGuidance, null);
  });
});

test('image generator portal route, asset, and persisted favorites survive runtime recreation', async () => {
  const runtimeConfig = await tempGeneratorRuntimeConfig();
  let favoriteId = '';

  await withTestServer({
    runtimeConfig,
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return []; } }
  }, async (baseUrl) => {
    const portal = await fetch(`${baseUrl}/image-generator`);
    assert.equal(portal.status, 200);
    const html = await portal.text();
    assert.match(html, /Image Generator/);
    assert.match(html, /\/assets\/image-generator\.js/);

    const asset = await fetch(`${baseUrl}/assets/image-generator.js`);
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /image-favorites/);

    const created = await (await fetch(`${baseUrl}/api/v1/image-favorites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request_payload: {
          prompt: 'persistent favorite payload',
          negative_prompt: 'noise',
          model: 'demo.safetensors',
          workflow_id: 'sdxl-text-to-image',
          width: 512,
          height: 512,
          steps: 12,
          cfg_scale: 6,
          seed: 12345,
          sampler_name: 'euler',
          scheduler: 'normal',
          output: 'url',
          sync_timeout_ms: 0,
          preserved_later_field: { yes: true }
        },
        image_url: '/api/v1/artifacts/missing-test-artifact',
        artifact_id: 'missing-test-artifact'
      })
    })).json();
    favoriteId = created.favorite.id;
  });

  await withTestServer({
    runtimeConfig,
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: { async queryGpus() { return []; } }
  }, async (baseUrl) => {
    const persisted = await (await fetch(`${baseUrl}/api/v1/image-favorites/${favoriteId}`)).json();
    assert.equal(persisted.ok, true);
    assert.equal(persisted.favorite.seed, 12345);
    assert.equal(persisted.favorite.imageUrl, '/api/v1/artifacts/missing-test-artifact');
    assert.deepEqual(persisted.favorite.requestPayload.preserved_later_field, { yes: true });
  });
});
