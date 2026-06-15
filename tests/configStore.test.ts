import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { tempConfigStore } from './helpers.ts';

test('ConfigStore creates config from fallback when missing', async () => {
  const store = await tempConfigStore('qwen3:14b');
  const config = await store.readConfig();
  assert.equal(config.default_model, 'qwen3:14b');
  const raw = await fs.readFile(store.path, 'utf8');
  assert.deepEqual(JSON.parse(raw), { default_model: 'qwen3:14b' });
});

test('ConfigStore allows an empty default model for image-only defaults', async () => {
  const store = await tempConfigStore('');
  const config = await store.readConfig();
  assert.equal(config.default_model, '');
  const raw = await fs.readFile(store.path, 'utf8');
  assert.deepEqual(JSON.parse(raw), { default_model: '' });
});

test('ConfigStore updates and persists default model when legacy mode sets one', async () => {
  const store = await tempConfigStore('');
  await store.updateDefaultModel('qwen3:14b');
  const config = await store.readConfig();
  assert.equal(config.default_model, 'qwen3:14b');
});
