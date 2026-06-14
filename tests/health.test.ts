import assert from 'node:assert/strict';
import test from 'node:test';
import { mockGpuService, mockOllama, tempConfigStore, testRuntimeConfig, withTestServer } from './helpers.ts';

test('GET /health returns compatibility health shape and default loaded state', async () => {
  const configStore = await tempConfigStore('qwen3:14b');
  await withTestServer({
    runtimeConfig: testRuntimeConfig(),
    configStore,
    ollamaClient: mockOllama([{ name: 'qwen3:14b', model: 'qwen3:14b' }]),
    gpuService: mockGpuService()
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.default_model, 'qwen3:14b');
    assert.equal(body.default_model_loaded, true);
    assert.equal(Array.isArray(body.running_models), true);
    assert.equal(body.service, 'Local AI Images');
  });
});
