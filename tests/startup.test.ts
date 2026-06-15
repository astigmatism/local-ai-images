import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
