import assert from 'node:assert/strict';
import test from 'node:test';
import { isDefaultModelLoaded } from '../src/utils/modelState.ts';

test('isDefaultModelLoaded detects exact loaded default model', () => {
  assert.equal(isDefaultModelLoaded('qwen3:14b', [{ name: 'qwen3:14b', model: 'qwen3:14b' }]), true);
});

test('isDefaultModelLoaded treats missing latest tag as compatible', () => {
  assert.equal(isDefaultModelLoaded('llama3.2', [{ name: 'llama3.2:latest', model: 'llama3.2:latest' }]), true);
});

test('isDefaultModelLoaded returns false when default is not running', () => {
  assert.equal(isDefaultModelLoaded('qwen3:14b', [{ name: 'llama3.2:latest', model: 'llama3.2:latest' }]), false);
});
