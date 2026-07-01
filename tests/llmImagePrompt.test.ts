import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { mockOllama, tempConfigStore, testRuntimeConfig, withTestServer } from './helpers.ts';

type JsonRecord = Record<string, unknown>;

type ProviderHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void> | void;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readProviderJson(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const parsed = raw ? JSON.parse(raw) as unknown : {};
  return isRecord(parsed) ? parsed : {};
}

async function withProvider(handler: ProviderHandler, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function postJson(url: string, body: JsonRecord): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('POST /api/v1/llm/image-prompt rejects blank guidance before contacting an LLM endpoint', async () => {
  await withTestServer({ runtimeConfig: testRuntimeConfig(), configStore: await tempConfigStore(), ollamaClient: mockOllama() }, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/v1/llm/image-prompt`, { guidance: '   ' });
    assert.equal(response.status, 422);
    const body = await response.json() as JsonRecord;
    assert.equal(Array.isArray(body.detail), true);
  });
});

test('POST /api/v1/llm/image-prompt fails closed when the integration is disabled', async () => {
  await withTestServer({ runtimeConfig: testRuntimeConfig({ llmImagePromptEnabled: false }), configStore: await tempConfigStore(), ollamaClient: mockOllama() }, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/v1/llm/image-prompt`, { guidance: 'Build a cinematic fox prompt.' });
    assert.equal(response.status, 503);
    const body = await response.json() as JsonRecord;
    assert.equal(isRecord(body.error) ? body.error.code : '', 'LLM_IMAGE_PROMPT_DISABLED');
  });
});

test('POST /api/v1/llm/image-prompt calls the configured active-model endpoint without sending a model name', async () => {
  let providerBody: JsonRecord | null = null;

  await withProvider(async (request, response) => {
    providerBody = await readProviderJson(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      choices: [{ message: { content: 'Prompt: cinematic red fox in a misty pine forest, rim light, detailed fur, shallow depth of field' } }],
      model: 'provider-active-model'
    }));
  }, async (providerUrl) => {
    const runtimeConfig = testRuntimeConfig({
      llmImagePromptEnabled: true,
      llmImagePromptEndpointUrl: `${providerUrl}/v1/chat/completions`,
      llmImagePromptRequestFormat: 'openai_chat',
      llmImagePromptInstruction: 'Return only positive prompt text.',
      llmImagePromptRequestTimeoutMs: 1000
    });

    await withTestServer({ runtimeConfig, configStore: await tempConfigStore(), ollamaClient: mockOllama() }, async (baseUrl) => {
      const response = await postJson(`${baseUrl}/api/v1/llm/image-prompt`, { guidance: 'A cinematic red fox in mist.' });
      assert.equal(response.status, 200);
      const body = await response.json() as JsonRecord;
      assert.equal(body.ok, true);
      assert.equal(body.prompt, 'cinematic red fox in a misty pine forest, rim light, detailed fur, shallow depth of field');
      assert.equal(body.modelInfo, 'provider-active-model');
    });
  });

  assert.ok(providerBody);
  assert.equal('model' in providerBody, false);
  assert.equal(Array.isArray(providerBody.messages), true);
});

test('POST /api/v1/llm/image-prompt handles malformed JSON responses cleanly', async () => {
  await withProvider((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{not-valid-json');
  }, async (providerUrl) => {
    const runtimeConfig = testRuntimeConfig({
      llmImagePromptEnabled: true,
      llmImagePromptEndpointUrl: `${providerUrl}/v1/chat/completions`,
      llmImagePromptRequestTimeoutMs: 1000
    });

    await withTestServer({ runtimeConfig, configStore: await tempConfigStore(), ollamaClient: mockOllama() }, async (baseUrl) => {
      const response = await postJson(`${baseUrl}/api/v1/llm/image-prompt`, { guidance: 'A malformed response test.' });
      assert.equal(response.status, 502);
      const body = await response.json() as JsonRecord;
      assert.equal(isRecord(body.error) ? body.error.code : '', 'LLM_IMAGE_PROMPT_MALFORMED_RESPONSE');
    });
  });
});

test('PUT /api/v1/llm/image-prompt/settings persists runtime settings for immediate use', async () => {
  const store = await tempConfigStore();
  await withTestServer({ runtimeConfig: testRuntimeConfig(), configStore: store, ollamaClient: mockOllama() }, async (baseUrl) => {
    const settings = {
      enabled: true,
      endpoint_url: 'http://127.0.0.1:11434/active-chat',
      health_url: 'http://127.0.0.1:11434/api/version',
      request_timeout_ms: 25000,
      request_format: 'simple_json',
      instruction: 'Return one concise positive image prompt only.',
      temperature: 0.4,
      max_tokens: 320
    };
    const response = await fetch(`${baseUrl}/api/v1/llm/image-prompt/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(settings)
    });
    assert.equal(response.status, 200);
    const body = await response.json() as JsonRecord;
    const responseSettings = isRecord(body.settings) ? body.settings : {};
    assert.equal(responseSettings.enabled, true);
    assert.equal(responseSettings.endpoint_url, settings.endpoint_url);
    assert.equal(responseSettings.request_format, 'simple_json');

    const saved = await store.readConfig();
    assert.equal(saved.llm_image_prompt?.enabled, true);
    assert.equal(saved.llm_image_prompt?.endpoint_url, settings.endpoint_url);
    assert.equal(saved.llm_image_prompt?.max_tokens, 320);
  });
});

test('POST /api/v1/llm/image-prompt/test checks reachability without sending prompt guidance or a model name', async () => {
  let seenMethod = '';
  let seenBody = '';

  await withProvider(async (request, response) => {
    seenMethod = request.method || '';
    for await (const chunk of request) seenBody += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : Buffer.from(chunk).toString('utf8');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  }, async (providerUrl) => {
    const runtimeConfig = testRuntimeConfig({
      llmImagePromptEnabled: true,
      llmImagePromptEndpointUrl: `${providerUrl}/v1/chat/completions`,
      llmImagePromptHealthUrl: `${providerUrl}/health`,
      llmImagePromptRequestTimeoutMs: 1000
    });

    await withTestServer({ runtimeConfig, configStore: await tempConfigStore(), ollamaClient: mockOllama() }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/v1/llm/image-prompt/test`, { method: 'POST' });
      assert.equal(response.status, 200);
      const body = await response.json() as JsonRecord;
      assert.equal(body.ok, true);
    });
  });

  assert.equal(seenMethod, 'GET');
  assert.equal(seenBody, '');
});
