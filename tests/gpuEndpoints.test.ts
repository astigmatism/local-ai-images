import assert from 'node:assert/strict';
import test from 'node:test';
import { mockGpuService, mockOllama, sampleGpu0, sampleGpu1, tempConfigStore, testRuntimeConfig, withTestServer } from './helpers.ts';

test('GET /gpus returns all GPUs', async () => {
  await withTestServer({
    runtimeConfig: testRuntimeConfig(),
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: mockGpuService([sampleGpu0, sampleGpu1])
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/gpus`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.gpus.length, 2);
    assert.equal(body.gpus[0].index, 0);
    assert.match(body.gpus[1].name, /4080/);
  });
});

test('GET /gpu returns deterministic primary GPU', async () => {
  await withTestServer({
    runtimeConfig: testRuntimeConfig(),
    configStore: await tempConfigStore(),
    ollamaClient: mockOllama(),
    gpuService: mockGpuService([sampleGpu0, sampleGpu1])
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/gpu`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.match(body.gpu.name, /3090/);
    assert.equal(body.gpu.index, undefined);
  });
});
