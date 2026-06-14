import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNvidiaSmiCsv, toLegacyGpu } from '../src/services/gpuService.ts';

test('parseNvidiaSmiCsv parses multiple NVIDIA GPU rows', () => {
  const output = `0, GPU-3090, NVIDIA GeForce RTX 3090, 595.71.05, 24576, 14168, 9958, 0, 45, 22.89, 420.00\n1, GPU-4080, NVIDIA GeForce RTX 4080, 595.71.05, 16384, 0, 16384, 0, 40, 20.00, 320.00`;
  const gpus = parseNvidiaSmiCsv(output);
  assert.equal(gpus.length, 2);
  assert.equal(gpus[0]?.name, 'NVIDIA GeForce RTX 3090');
  assert.equal(gpus[0]?.memory_total_mib, 24576);
  assert.equal(gpus[1]?.name, 'NVIDIA GeForce RTX 4080');
  assert.equal(gpus[1]?.power_limit_w, 320);
});

test('parseNvidiaSmiCsv preserves partial telemetry with warnings', () => {
  const output = '0, GPU-x, NVIDIA Test GPU, 595.71.05, 1024, N/A, 1024, [Not Supported], 40, N/A, 300';
  const [gpu] = parseNvidiaSmiCsv(output);
  assert.equal(gpu?.memory_used_mib, null);
  assert.equal(gpu?.utilization_gpu_percent, null);
  assert.ok((gpu?.warnings?.length ?? 0) > 0);
});

test('toLegacyGpu converts to old single-GPU shape without index and uuid', () => {
  const [gpu] = parseNvidiaSmiCsv('0, GPU-3090, NVIDIA GeForce RTX 3090, 595.71.05, 24576, 14168, 9958, 0, 45, 22.89, 420.00');
  const legacy = toLegacyGpu(gpu!);
  assert.deepEqual(legacy, {
    name: 'NVIDIA GeForce RTX 3090',
    driver_version: '595.71.05',
    memory_total_mib: 24576,
    memory_used_mib: 14168,
    memory_free_mib: 9958,
    utilization_gpu_percent: 0,
    temperature_c: 45,
    power_draw_w: 22.89,
    power_limit_w: 420
  });
  assert.equal('index' in legacy, false);
  assert.equal('uuid' in legacy, false);
});
