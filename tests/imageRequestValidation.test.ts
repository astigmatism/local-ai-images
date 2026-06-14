import assert from 'node:assert/strict';
import test from 'node:test';
import { testRuntimeConfig } from './helpers.ts';
import { validateAndNormalizeGenerationRequest } from '../src/utils/imageRequests.ts';
import { builtinWorkflows } from '../src/services/image/workflowStore.ts';

test('validateAndNormalizeGenerationRequest normalizes a simple text-to-image request', () => {
  const result = validateAndNormalizeGenerationRequest({
    prompt: '  an alpine cabin at dawn  ',
    negative_prompt: 'blur',
    width: 768,
    height: 512,
    steps: 20,
    cfg_scale: 6.5,
    seed: 42,
    output: 'base64',
    sync_timeout_ms: 100
  }, testRuntimeConfig({ imageDefaultSyncTimeoutMs: 0, imageMaxSyncTimeoutMs: 1000 }), builtinWorkflows());

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.prompt, 'an alpine cabin at dawn');
  assert.equal(result.value.negativePrompt, 'blur');
  assert.equal(result.value.workflowId, 'sdxl-text-to-image');
  assert.equal(result.value.model, 'sd_xl_base_1.0.safetensors');
  assert.equal(result.value.width, 768);
  assert.equal(result.value.height, 512);
  assert.equal(result.value.steps, 20);
  assert.equal(result.value.cfgScale, 6.5);
  assert.equal(result.value.seed, 42);
  assert.equal(result.value.output, 'base64');
  assert.equal(result.value.syncTimeoutMs, 100);
});

test('validateAndNormalizeGenerationRequest rejects invalid prompts and numeric ranges', () => {
  const result = validateAndNormalizeGenerationRequest({
    prompt: '',
    width: 32,
    height: 9000,
    steps: 151,
    cfg_scale: 99,
    output: 'gif'
  }, testRuntimeConfig(), builtinWorkflows());

  assert.equal(result.ok, false);
  if (result.ok) return;
  const locations = result.response.detail.map((detail) => detail.loc.join('.'));
  assert.ok(locations.includes('body.prompt'));
  assert.ok(locations.includes('body.width'));
  assert.ok(locations.includes('body.height'));
  assert.ok(locations.includes('body.steps'));
  assert.ok(locations.includes('body.cfg_scale'));
  assert.ok(locations.includes('body.output'));
});

test('validateAndNormalizeGenerationRequest turns seed -1 into an operator-local random seed', () => {
  const result = validateAndNormalizeGenerationRequest({ prompt: 'seed test', seed: -1 }, testRuntimeConfig(), builtinWorkflows());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(Number.isInteger(result.value.seed), true);
  assert.ok(result.value.seed >= 0);
});
