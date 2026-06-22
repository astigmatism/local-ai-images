import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { ComfyUiProvider, materializeComfyPrompt } from '../src/services/image/comfyUiProvider.ts';
import { builtinWorkflows } from '../src/services/image/workflowStore.ts';
import type { ProviderGenerationRequest } from '../src/types.ts';

const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lzLZhwAAAABJRU5ErkJggg==';

function providerRequest(overrides: Partial<ProviderGenerationRequest> = {}): ProviderGenerationRequest {
  const workflow = builtinWorkflows()[0]!;
  return {
    jobId: 'job-1',
    workflow,
    filenamePrefix: 'local-ai-images/job-1',
    prompt: 'a brass robot in a forest',
    negativePrompt: 'blur',
    model: 'custom.safetensors',
    workflowId: workflow.id,
    width: 640,
    height: 512,
    steps: 12,
    cfgScale: 6,
    seed: 77,
    samplerName: 'dpmpp_2m',
    scheduler: 'karras',
    output: 'url',
    syncTimeoutMs: 0,
    metadata: {},
    ...overrides
  };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) as unknown : {};
}

async function withServer(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => void Promise.resolve(handler(request, response)).catch((error) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('materializeComfyPrompt maps stable API request fields onto a ComfyUI workflow', () => {
  const request = providerRequest();
  const prompt = materializeComfyPrompt(request.workflow, request);
  assert.equal((prompt['6'] as any).inputs.text, 'a brass robot in a forest');
  assert.equal((prompt['7'] as any).inputs.text, 'blur');
  assert.equal((prompt['4'] as any).inputs.ckpt_name, 'custom.safetensors');
  assert.equal((prompt['5'] as any).inputs.width, 640);
  assert.equal((prompt['3'] as any).inputs.steps, 12);
  assert.equal((prompt['3'] as any).inputs.scheduler, 'karras');
});

test('ComfyUiProvider health succeeds when ComfyUI system stats are reachable', async () => {
  await withServer((request, response) => {
    if (request.url === '/system_stats') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ devices: [{ name: 'RTX 3080' }] }));
      return;
    }
    if (request.url === '/queue') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ queue_running: [], queue_pending: [] }));
      return;
    }
    response.writeHead(404).end();
  }, async (baseUrl) => {
    const provider = new ComfyUiProvider(baseUrl, 1000, 1);
    const health = await provider.health();
    assert.equal(health.ok, true);
    assert.equal(health.provider, 'comfyui');
  });
});

test('ComfyUiProvider submits a prompt, polls history, and downloads image output', async () => {
  let submitted: any = null;
  await withServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/prompt') {
      submitted = await readBody(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ prompt_id: 'p1' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/history/p1') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ p1: { outputs: { '9': { images: [{ filename: 'job-1.png', subfolder: '', type: 'output' }] } } } }));
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/view?')) {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from(tinyPngBase64, 'base64'));
      return;
    }
    response.writeHead(404).end();
  }, async (baseUrl) => {
    const provider = new ComfyUiProvider(baseUrl, 1000, 1);
    const result = await provider.generate(providerRequest());
    assert.equal(result.providerJobId, 'p1');
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0]?.mimeType, 'image/png');
    assert.equal(submitted.prompt['6'].inputs.text, 'a brass robot in a forest');
    assert.equal(submitted.prompt['4'].inputs.ckpt_name, 'custom.safetensors');
  });
});

test('ComfyUiProvider cancellation targets pending and running prompt IDs', async () => {
  let deleted: Record<string, unknown> | null = null;
  let interrupted = false;
  await withServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/queue') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        queue_pending: [['pending-prompt', 1]],
        queue_running: [['running-prompt', 2]]
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/queue') {
      deleted = await readBody(request);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === 'POST' && request.url === '/interrupt') {
      interrupted = true;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(404).end();
  }, async (baseUrl) => {
    const provider = new ComfyUiProvider(baseUrl, 1000, 1);
    const pendingCancel = await provider.cancel('pending-prompt');
    assert.equal(pendingCancel.requested, true);
    assert.equal(pendingCancel.queueDeleteRequested, true);
    assert.deepEqual(deleted?.delete, ['pending-prompt']);

    const runningCancel = await provider.cancel('running-prompt');
    assert.equal(runningCancel.requested, true);
    assert.equal(runningCancel.interruptRequested, true);
    assert.equal(interrupted, true);
  });
});

test('ComfyUiProvider maps submit failures to application errors', async () => {
  await withServer((request, response) => {
    if (request.method === 'POST' && request.url === '/prompt') {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'boom' }));
      return;
    }
    response.writeHead(404).end();
  }, async (baseUrl) => {
    const provider = new ComfyUiProvider(baseUrl, 1000, 1);
    await assert.rejects(() => provider.generate(providerRequest()), /HTTP 500/);
  });
});
