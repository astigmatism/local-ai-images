import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { loadRuntimeConfig } from '../src/config/env.ts';

const managedEnvKeys = [
  'CONFIG_PATH',
  'IMAGE_BACKEND',
  'IMAGE_API_KEYS',
  'REQUIRE_IMAGE_API_AUTH',
  'COMFYUI_BASE_URL',
  'IMAGE_MODEL_PATHS',
  'IMAGE_WORKFLOW_PATH',
  'IMAGE_ARTIFACT_PATH',
  'IMAGE_DEFAULT_WORKFLOW_ID',
  'IMAGE_QUEUE_CONCURRENCY',
  'IMAGE_MAX_QUEUED_JOBS',
  'MODEL_INSTALLS_ENABLED',
  'MODEL_INSTALL_MAX_BYTES',
  'MODEL_INSTALL_ALLOW_CKPT',
  'MODEL_CATALOG_PATH',
  'MODEL_DOWNLOAD_METADATA_PATH',
  'COMFYUI_CHECKPOINT_PATH',
  'COMFYUI_LORA_PATH',
  'COMFYUI_VAE_PATH',
  'COMFYUI_CONTROLNET_PATH',
  'COMFYUI_UPSCALER_PATH',
  'COMFYUI_OTHER_MODEL_PATH',
  'LEGACY_OLLAMA_ENABLED',
  'OLLAMA_BASE_URL',
  'DEFAULT_MODEL',
  'PREWARM_DEFAULT_MODEL_ON_START',
  'LLM_IMAGE_PROMPT_ENABLED',
  'LLM_IMAGE_PROMPT_ENDPOINT_URL',
  'LLM_IMAGE_PROMPT_HEALTH_URL',
  'LLM_IMAGE_PROMPT_REQUEST_TIMEOUT_MS',
  'LLM_IMAGE_PROMPT_REQUEST_FORMAT',
  'LLM_IMAGE_PROMPT_INSTRUCTION',
  'LLM_IMAGE_PROMPT_TEMPERATURE',
  'LLM_IMAGE_PROMPT_MAX_TOKENS'
];

function withCleanEnv(fn: () => void): void {
  const original = new Map(managedEnvKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of managedEnvKeys) delete process.env[key];
    fn();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('loadRuntimeConfig parses image-generation backend, paths, auth, and queue settings', () => {
  withCleanEnv(() => {
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
    process.env.MODEL_INSTALLS_ENABLED = 'true';
    process.env.MODEL_INSTALL_MAX_BYTES = '123456';
    process.env.MODEL_INSTALL_ALLOW_CKPT = 'true';
    process.env.MODEL_CATALOG_PATH = './config/catalog.json';
    process.env.MODEL_DOWNLOAD_METADATA_PATH = './config/downloads.json';
    process.env.COMFYUI_CHECKPOINT_PATH = '/srv/comfyui/models/checkpoints';
    process.env.COMFYUI_LORA_PATH = '/srv/comfyui/models/loras';

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
    assert.equal(config.modelInstallsEnabled, true);
    assert.equal(config.modelInstallMaxBytes, 123456);
    assert.equal(config.modelInstallAllowCkpt, true);
    assert.equal(config.modelCatalogPath, path.resolve(process.cwd(), './config/catalog.json'));
    assert.equal(config.modelDownloadMetadataPath, path.resolve(process.cwd(), './config/downloads.json'));
    assert.equal(config.modelInstallDirectories.checkpoint, '/srv/comfyui/models/checkpoints');
    assert.equal(config.modelInstallDirectories.lora, '/srv/comfyui/models/loras');
  });
});

test('loadRuntimeConfig uses image-focused defaults with legacy Ollama disabled', () => {
  withCleanEnv(() => {
    const config = loadRuntimeConfig();
    assert.equal(config.configPath, path.resolve(process.cwd(), './config/local-ai-images.json'));
    assert.equal(config.imageBackend, 'comfyui');
    assert.equal(config.comfyUiBaseUrl, 'http://127.0.0.1:8188');
    assert.equal(config.legacyOllamaEnabled, false);
    assert.equal(config.ollamaBaseUrl, '');
    assert.equal(config.defaultModel, '');
    assert.equal(config.prewarmDefaultModelOnStart, false);
    assert.equal(config.modelInstallsEnabled, false);
    assert.equal(config.modelInstallMaxBytes, 20 * 1024 * 1024 * 1024);
    assert.equal(config.modelInstallAllowCkpt, false);
    assert.equal(config.modelInstallDirectories.checkpoint, path.resolve(process.cwd(), './models/checkpoints'));
  });
});

test('loadRuntimeConfig only enables legacy Ollama startup settings when explicitly requested', () => {
  withCleanEnv(() => {
    process.env.LEGACY_OLLAMA_ENABLED = 'true';
    process.env.PREWARM_DEFAULT_MODEL_ON_START = 'true';
    process.env.DEFAULT_MODEL = 'qwen3:14b';

    const config = loadRuntimeConfig();
    assert.equal(config.legacyOllamaEnabled, true);
    assert.equal(config.ollamaBaseUrl, 'http://127.0.0.1:11434');
    assert.equal(config.defaultModel, 'qwen3:14b');
    assert.equal(config.prewarmDefaultModelOnStart, true);
  });
});

test('loadRuntimeConfig parses local LLM image-prompt builder settings without configuring a model', () => {
  withCleanEnv(() => {
    process.env.LLM_IMAGE_PROMPT_ENABLED = 'true';
    process.env.LLM_IMAGE_PROMPT_ENDPOINT_URL = 'http://127.0.0.1:11434/active-chat/';
    process.env.LLM_IMAGE_PROMPT_HEALTH_URL = 'http://127.0.0.1:11434/api/version/';
    process.env.LLM_IMAGE_PROMPT_REQUEST_TIMEOUT_MS = '45000';
    process.env.LLM_IMAGE_PROMPT_REQUEST_FORMAT = 'simple_json';
    process.env.LLM_IMAGE_PROMPT_INSTRUCTION = 'Return positive image prompt text only.';
    process.env.LLM_IMAGE_PROMPT_TEMPERATURE = '0.5';
    process.env.LLM_IMAGE_PROMPT_MAX_TOKENS = '512';

    const config = loadRuntimeConfig();
    assert.equal(config.llmImagePromptEnabled, true);
    assert.equal(config.llmImagePromptEndpointUrl, 'http://127.0.0.1:11434/active-chat');
    assert.equal(config.llmImagePromptHealthUrl, 'http://127.0.0.1:11434/api/version');
    assert.equal(config.llmImagePromptRequestTimeoutMs, 45000);
    assert.equal(config.llmImagePromptRequestFormat, 'simple_json');
    assert.equal(config.llmImagePromptInstruction, 'Return positive image prompt text only.');
    assert.equal(config.llmImagePromptTemperature, 0.5);
    assert.equal(config.llmImagePromptMaxTokens, 512);
  });
});

