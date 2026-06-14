import assert from 'node:assert/strict';
import test from 'node:test';
import { OllamaClient } from '../src/services/ollamaClient.ts';

test('OllamaClient lists running models through /api/ps', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<[string, RequestInit]> = [];
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push([String(url), init ?? {}]);
    return new Response(JSON.stringify({ models: [{ name: 'qwen3:14b' }] }), { status: 200 });
  };

  try {
    const client = new OllamaClient('http://ollama.test', 1000);
    const models = await client.listRunningModels();
    assert.deepEqual(models, [{ name: 'qwen3:14b' }]);
    assert.equal(calls[0]?.[0], 'http://ollama.test/api/ps');
    assert.equal(calls[0]?.[1].method, 'GET');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OllamaClient reads model capabilities through /api/show', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<[string, RequestInit]> = [];

  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push([String(url), init ?? {}]);
    return new Response(JSON.stringify({ capabilities: ['completion', 'vision'] }), { status: 200 });
  };

  try {
    const client = new OllamaClient('http://ollama.test', 1000);
    const info = await client.showModel('qwen3.6:35b-a3b-q4_K_M');
    assert.deepEqual(info.capabilities, ['completion', 'vision']);
    assert.equal(calls[0]?.[0], 'http://ollama.test/api/show');
    assert.equal(calls[0]?.[1].method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]?.[1].body)), { model: 'qwen3.6:35b-a3b-q4_K_M' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OllamaClient pre-warms model with stream false and keep_alive', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: unknown[] = [];
  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ done: true, done_reason: 'load' }), { status: 200 });
  };

  try {
    const client = new OllamaClient('http://ollama.test/', 1000);
    const result = await client.prewarmModel('qwen3:14b', -1, 1000);
    assert.equal(result.model, 'qwen3:14b');
    assert.deepEqual(bodies[0], { model: 'qwen3:14b', stream: false, keep_alive: -1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OllamaClient maps 404 responses to OLLAMA_MODEL_NOT_FOUND', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'model not found' }), { status: 404 });

  try {
    const client = new OllamaClient('http://ollama.test', 1000);
    await assert.rejects(client.prewarmModel('missing:model', -1), (error: unknown) => {
      return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'OLLAMA_MODEL_NOT_FOUND';
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OllamaClient generates images through /api/generate with stream false', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<[string, RequestInit]> = [];
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lzLZhwAAAABJRU5ErkJggg==';

  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push([String(url), init ?? {}]);
    return new Response(JSON.stringify({ model: 'sdxl:latest', image: pngBase64, done: true }), { status: 200 });
  };

  try {
    const client = new OllamaClient('http://ollama.test/', 1000);
    const result = await client.generateImage({
      model: 'sdxl:latest',
      prompt: 'a bear castle at sunset',
      timeoutMs: 2000,
      width: 1024,
      height: 1024,
      steps: 30
    });
    assert.equal(calls[0]?.[0], 'http://ollama.test/api/generate');
    assert.deepEqual(JSON.parse(String(calls[0]?.[1].body)), {
      model: 'sdxl:latest',
      prompt: 'a bear castle at sunset',
      stream: false,
      width: 1024,
      height: 1024,
      steps: 30
    });
    assert.equal(result.model, 'sdxl:latest');
    assert.equal(result.images[0]?.mimeType, 'image/png');
    assert.equal(result.images[0]?.base64, pngBase64);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OllamaClient rejects image-generation responses that do not contain image data', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ model: 'qwen3:14b', response: 'text only', done: true }), { status: 200 });

  try {
    const client = new OllamaClient('http://ollama.test', 1000);
    await assert.rejects(client.generateImage({ model: 'qwen3:14b', prompt: 'draw a bear' }), (error: unknown) => {
      return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'OLLAMA_IMAGE_NOT_RETURNED';
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
