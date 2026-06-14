import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { loadRuntimeConfig } from '../src/config/env.ts';

const managedEnvKeys = [
  'IMAGE_BACKEND',
  'IMAGE_API_KEYS',
  'REQUIRE_IMAGE_API_AUTH',
  'COMFYUI_BASE_URL',
  'IMAGE_MODEL_PATHS',
  'IMAGE_WORKFLOW_PATH',
  'IMAGE_ARTIFACT_PATH',
  'IMAGE_DEFAULT_WORKFLOW_ID',
  'IMAGE_QUEUE_CONCURRENCY',
  'IMAGE_MAX_QUEUED_JOBS'
];

test('loadRuntimeConfig parses image-generation backend, paths, auth, and queue settings', () => {
  const original = new Map(managedEnvKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.IMAGE_BACKEND = 'mock';
    process.env.IMAGE_API_KEYS = 'alpha,beta';
    process.env.REQUIRE_IMAGE_API_AUTH = 'true';
    process.env.COMFYUI_BASE_URL = 'http://127.0.0.1:8188/';
    process.env.IMAGE_MODEL_PATHS = './models,/srv/comfyui/models';
    process.env.IMAGE_WORKFLOW_PATH = './config/workflows';
    process.env.IMAGE_ARTIFACT_PATH = './data/artifacts';
    process.env.IMAGE_DEFAULT_WORKFLOW_ID = 'custom';
    process.env.IMAGE_QUEUE_CONCURRENCY = '2';
    process.env.IMAGE_MAX_QUEUED_JOBS = '9';

    const config = loadRuntimeConfig();
    assert.equal(config.imageBackend, 'mock');
    assert.deepEqual(config.imageApiKeys, ['alpha', 'beta']);
    assert.equal(config.requireImageApiAuth, true);
    assert.equal(config.comfyUiBaseUrl, 'http://127.0.0.1:8188');
    assert.equal(config.imageModelPaths[0], path.resolve(process.cwd(), './models'));
    assert.equal(config.imageModelPaths[1], '/srv/comfyui/models');
    assert.equal(config.imageWorkflowPath, path.resolve(process.cwd(), './config/workflows'));
    assert.equal(config.imageArtifactPath, path.resolve(process.cwd(), './data/artifacts'));
    assert.equal(config.imageDefaultWorkflowId, 'custom');
    assert.equal(config.imageQueueConcurrency, 2);
    assert.equal(config.imageMaxQueuedJobs, 9);
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});


test('loadRuntimeConfig uses local-ai-images default config path', () => {
  const original = process.env.CONFIG_PATH;
  try {
    delete process.env.CONFIG_PATH;
    const config = loadRuntimeConfig();
    assert.equal(config.configPath, path.resolve(process.cwd(), './config/local-ai-images.json'));
  } finally {
    if (original === undefined) delete process.env.CONFIG_PATH;
    else process.env.CONFIG_PATH = original;
  }
});
