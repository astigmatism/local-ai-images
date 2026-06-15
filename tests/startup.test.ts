import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('npm start image-only defaults do not prewarm or contact Ollama', async () => {
  const configPath = path.join(os.tmpdir(), `local-ai-images-startup-${process.pid}-${Date.now()}.json`);
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_NO_WARNINGS: '1',
      HOST: '127.0.0.1',
      PORT: '0',
      LOG_LEVEL: 'info',
      CONFIG_PATH: configPath,
      IMAGE_BACKEND: 'mock',
      REQUIRE_IMAGE_API_AUTH: 'false',
      IMAGE_API_KEYS: '',
      LEGACY_OLLAMA_ENABLED: 'false',
      OLLAMA_BASE_URL: 'http://127.0.0.1:9',
      PREWARM_DEFAULT_MODEL_ON_START: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });

  try {
    await waitForOutput(() => output.includes('Local AI Images listening'), 5000);
    await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    if (!child.killed) child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }

  assert.match(output, /Local AI Images listening/);
  assert.doesNotMatch(output, /Unable to connect to Ollama/);
  assert.doesNotMatch(output, /pre-warm/i);
  assert.doesNotMatch(output, /\"model\":\"[^\"]+\"/);
});

async function waitForOutput(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for startup output');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('npm start preloads the default image checkpoint on startup when enabled', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `local-ai-images-startup-preload-${process.pid}-${Date.now()}-`));
  const modelRoot = path.join(root, 'models');
  const checkpointDir = path.join(modelRoot, 'checkpoints');
  const configPath = path.join(root, 'config.json');
  await fs.mkdir(checkpointDir, { recursive: true });
  await fs.writeFile(path.join(checkpointDir, 'boot.safetensors'), 'boot');

  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_NO_WARNINGS: '1',
      HOST: '127.0.0.1',
      PORT: '0',
      LOG_LEVEL: 'info',
      CONFIG_PATH: configPath,
      IMAGE_BACKEND: 'mock',
      IMAGE_MOCK_DELAY_MS: '1',
      IMAGE_MODEL_PATHS: modelRoot,
      COMFYUI_CHECKPOINT_PATH: checkpointDir,
      IMAGE_DEFAULT_MODEL: 'boot.safetensors',
      IMAGE_PRELOAD_DEFAULT_ON_STARTUP: 'true',
      IMAGE_PRELOAD_TIMEOUT_MS: '1000',
      REQUIRE_IMAGE_API_AUTH: 'false',
      IMAGE_API_KEYS: '',
      LEGACY_OLLAMA_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });

  try {
    await waitForOutput(() => output.includes('Local AI Images listening'), 5000);
    await waitForOutput(() => output.includes('Image default model startup preload succeeded'), 5000);
  } finally {
    if (!child.killed) child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  }

  assert.match(output, /Image default model startup preload started/);
  assert.match(output, /Image default model startup preload succeeded/);
  assert.match(output, /boot\.safetensors/);
});

test('npm start startup preload failure does not crash when ComfyUI is unavailable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `local-ai-images-startup-preload-fail-${process.pid}-${Date.now()}-`));
  const modelRoot = path.join(root, 'models');
  const checkpointDir = path.join(modelRoot, 'checkpoints');
  const configPath = path.join(root, 'config.json');
  await fs.mkdir(checkpointDir, { recursive: true });
  await fs.writeFile(path.join(checkpointDir, 'boot.safetensors'), 'boot');

  const unavailableComfy = createServer((_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not ready' }));
  });
  await new Promise<void>((resolve) => unavailableComfy.listen(0, '127.0.0.1', resolve));
  const address = unavailableComfy.address() as AddressInfo;

  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      NODE_NO_WARNINGS: '1',
      HOST: '127.0.0.1',
      PORT: '0',
      LOG_LEVEL: 'info',
      CONFIG_PATH: configPath,
      IMAGE_BACKEND: 'comfyui',
      COMFYUI_BASE_URL: `http://127.0.0.1:${address.port}`,
      IMAGE_MODEL_PATHS: modelRoot,
      COMFYUI_CHECKPOINT_PATH: checkpointDir,
      IMAGE_DEFAULT_MODEL: 'boot.safetensors',
      IMAGE_PRELOAD_DEFAULT_ON_STARTUP: 'true',
      IMAGE_PRELOAD_TIMEOUT_MS: '100',
      REQUIRE_IMAGE_API_AUTH: 'false',
      IMAGE_API_KEYS: '',
      LEGACY_OLLAMA_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });

  try {
    await waitForOutput(() => output.includes('Local AI Images listening'), 5000);
    await waitForOutput(() => output.includes('Image default model startup preload failed'), 5000);
    assert.equal(child.exitCode, null);
  } finally {
    if (!child.killed) child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    await new Promise<void>((resolve, reject) => unavailableComfy.close((error) => error ? reject(error) : resolve()));
  }

  assert.match(output, /Image default model startup preload started/);
  assert.match(output, /Image default model startup preload failed/);
  assert.match(output, /Local AI Images listening/);
});
