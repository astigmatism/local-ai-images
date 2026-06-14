import assert from 'node:assert/strict';
import test from 'node:test';
import { mockGpuService, mockOllama, tempConfigStore, testRuntimeConfig, withTestServer } from './helpers.ts';

test('POST /model/load returns FastAPI-style validation errors', async () => {
  await withTestServer({
    runtimeConfig: testRuntimeConfig(),
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: mockGpuService()
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/model/load`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: '', make_default: 'nope' })
    });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(Array.isArray(body.detail), true);
    assert.deepEqual(body.detail[0].loc, ['body', 'model']);
  });
});

test('POST /model/load pre-warms and persists default model', async () => {
  const configStore = await tempConfigStore('llama3.2:latest');
  await withTestServer({
    runtimeConfig: testRuntimeConfig(),
    configStore,
    ollamaClient: mockOllama([{ name: 'qwen3:14b', model: 'qwen3:14b' }]),
    gpuService: mockGpuService()
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/model/load`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3:14b', make_default: true })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.model, 'qwen3:14b');
    assert.equal(body.made_default, true);
    assert.equal(body.loaded, true);
    assert.equal((await configStore.readConfig()).default_model, 'qwen3:14b');
  });
});
