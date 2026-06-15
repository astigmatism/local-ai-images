import assert from 'node:assert/strict';
import test from 'node:test';
import { mockGpuService, mockOllama, tempConfigStore, testRuntimeConfig, withTestServer } from './helpers.ts';
import type { OllamaImageGenerateRequest } from '../src/types.ts';

const imageModel = 'sdxl:latest';
const installedImageModel = { name: imageModel, model: imageModel };

test('LEGACY_OLLAMA_ENABLED=true: GET /api/capabilities reports legacy image generation disabled', async () => {
  await withTestServer({
    runtimeConfig: testRuntimeConfig({ legacyOllamaEnabled: true }),
    configStore: await tempConfigStore('qwen3:14b'),
    ollamaClient: mockOllama([], [installedImageModel]),
    gpuService: mockGpuService()
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/capabilities`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.imageGeneration.available, false);
    assert.equal(body.imageGeneration.enabled, false);
    assert.equal(body.imageGeneration.currentModel, 'qwen3:14b');
    assert.equal(body.imageGeneration.loaded, null);
    assert.match(body.imageGeneration.reason, /disabled/i);
  });
});

test('LEGACY_OLLAMA_ENABLED=true: GET /api/capabilities distinguishes vision input from image generation output', async () => {
  const visionModel = 'qwen3.6:35b-a3b-q4_K_M';
  const installedVisionModel = { name: visionModel, model: visionModel };

  await withTestServer({
    runtimeConfig: testRuntimeConfig({ legacyOllamaEnabled: true, imageGenerationEnabled: true }),
    configStore: await tempConfigStore(visionModel),
    ollamaClient: mockOllama([], [installedVisionModel], undefined, undefined, {
      capabilities: ['completion', 'vision', 'tools', 'thinking']
    }),
    gpuService: mockGpuService()
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/capabilities`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.imageGeneration.available, false);
    assert.equal(body.imageGeneration.supportsImageGeneration, false);
    assert.equal(body.imageGeneration.supportsImageInput, true);
    assert.deepEqual(body.imageGeneration.modelCapabilities, ['completion', 'vision', 'tools', 'thinking']);
    assert.match(body.imageGeneration.reason, /does not report Ollama image-generation capability "image"/);
    assert.match(body.imageGeneration.reason, /vision is not image-generation output/);
    assert.equal(body.modelCapabilities.imageInput.available, true);
    assert.equal(body.modelCapabilities.imageGeneration.available, false);
  });
});

test('POST /api/images/generate is disabled unless LEGACY_OLLAMA_ENABLED=true', async () => {
  await withTestServer({
    runtimeConfig: testRuntimeConfig(),
    configStore: await tempConfigStore(imageModel),
    ollamaClient: mockOllama([], [installedImageModel]),
    gpuService: mockGpuService()
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/images/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a bear castle at sunset' })
    });
    assert.equal(response.status, 410);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'LEGACY_OLLAMA_DISABLED');
    assert.match(body.error.message, /LEGACY_OLLAMA_ENABLED=true/);
  });
});

test('POST /api/images/generate requires the current model to be installed', async () => {
  await withTestServer({
    runtimeConfig: testRuntimeConfig({ legacyOllamaEnabled: true, imageGenerationEnabled: true }),
    configStore: await tempConfigStore(imageModel),
    ollamaClient: mockOllama([], [{ name: 'qwen3:14b', model: 'qwen3:14b' }]),
    gpuService: mockGpuService()
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/images/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a bear castle at sunset' })
    });
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error.code, 'IMAGE_MODEL_NOT_INSTALLED');
  });
});

test('POST /api/images/generate rejects installed models without the Ollama image capability', async () => {
  const visionModel = 'qwen3.6:35b-a3b-q4_K_M';
  const installedVisionModel = { name: visionModel, model: visionModel };
  let generateCalled = false;

  await withTestServer({
    runtimeConfig: testRuntimeConfig({ legacyOllamaEnabled: true, imageGenerationEnabled: true }),
    configStore: await tempConfigStore(visionModel),
    ollamaClient: mockOllama([], [installedVisionModel], undefined, () => {
      generateCalled = true;
    }, { capabilities: ['completion', 'vision', 'tools', 'thinking'] }),
    gpuService: mockGpuService()
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/images/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a bear castle at sunset' })
    });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'IMAGE_GENERATION_UNSUPPORTED_MODEL');
    assert.match(body.error.message, /does not report Ollama image-generation capability "image"/);
    assert.equal(body.error.details.supportsImageInput, true);
    assert.deepEqual(body.error.details.reportedCapabilities, ['completion', 'vision', 'tools', 'thinking']);
  });

  assert.equal(generateCalled, false);
});

test('POST /api/images/generate uses the current Ollama model and returns base64 image data', async () => {
  let observedRequest: OllamaImageGenerateRequest | null = null;

  await withTestServer({
    runtimeConfig: testRuntimeConfig({ legacyOllamaEnabled: true, imageGenerationEnabled: true, imageGenerationTimeoutMs: 12345 }),
    configStore: await tempConfigStore(imageModel),
    ollamaClient: mockOllama([], [installedImageModel], undefined, (request) => {
      observedRequest = request;
    }, { capabilities: ['image'] }),
    gpuService: mockGpuService()
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/images/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a bear castle at sunset', options: { width: 1024, height: 768, steps: 30 } })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.model, imageModel);
    assert.equal(body.images[0].mimeType, 'image/png');
    assert.equal(typeof body.images[0].base64, 'string');
    assert.equal(body.metadata.endpoint, '/api/generate');
    assert.equal(observedRequest?.model, imageModel);
    assert.equal(observedRequest?.prompt, 'a bear castle at sunset');
    assert.equal(observedRequest?.timeoutMs, 12345);
    assert.equal(observedRequest?.width, 1024);
    assert.equal(observedRequest?.height, 768);
    assert.equal(observedRequest?.steps, 30);
    assert.ok(observedRequest?.signal instanceof AbortSignal);
  });
});

test('POST /api/images/generate rejects /model overrides that do not match configuration', async () => {
  await withTestServer({
    runtimeConfig: testRuntimeConfig({ legacyOllamaEnabled: true, imageGenerationEnabled: true }),
    configStore: await tempConfigStore(imageModel),
    ollamaClient: mockOllama([], [installedImageModel]),
    gpuService: mockGpuService()
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/images/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a bear castle at sunset', model: 'other:image-model' })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'IMAGE_MODEL_OVERRIDE_NOT_ALLOWED');
  });
});
