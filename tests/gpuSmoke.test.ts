import assert from 'node:assert/strict';
import test from 'node:test';
import { NvidiaSmiGpuService } from '../src/services/gpuService.ts';

test('optional GPU smoke test queries nvidia-smi on real hardware', { skip: process.env.RUN_GPU_TESTS === '1' ? false : 'Set RUN_GPU_TESTS=1 to run hardware GPU smoke tests.' }, async () => {
  const service = new NvidiaSmiGpuService(5000);
  const gpus = await service.queryGpus();
  assert.ok(gpus.length >= 1);
  assert.ok(gpus[0]?.name);
});
