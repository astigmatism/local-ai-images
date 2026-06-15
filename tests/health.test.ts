import assert from 'node:assert/strict';
import test from 'node:test';
import { mockGpuService, sampleGpu0, tempConfigStore, testRuntimeConfig, throwingOllama, withTestServer } from './helpers.ts';

test('GET /health is image-focused by default and does not call Ollama', async () => {
  await withTestServer({
    runtimeConfig: testRuntimeConfig({ imageBackend: 'mock', imageGenerationEnabled: true }),
    configStore: tempConfigStore(),
    ollamaClient: throwingOllama(),
    gpuService: mockGpuService([sampleGpu0])
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'Local AI Images Image Generation API');
    assert.equal(body.backend, 'mock');
    assert.equal(body.engine.provider, 'mock');
    assert.equal('ollama' in body, false);
    assert.equal(body.gpu.ok, true);
    assert.equal(body.gpu.gpus.length, 1);
  });
});

test('GET /api/capabilities is image-focused by default and does not call Ollama', async () => {
  await withTestServer({
    runtimeConfig: testRuntimeConfig({ imageBackend: 'mock', imageGenerationEnabled: true }),
    configStore: tempConfigStore(),
    ollamaClient: throwingOllama(),
    gpuService: mockGpuService([sampleGpu0])
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/capabilities`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'local-ai-images');
    assert.equal(body.backend, 'mock');
    assert.equal(body.engine, 'mock');
    assert.equal('ollama' in body, false);
    assert.equal(body.endpoints.generate, '/api/v1/generate');
  });
});
