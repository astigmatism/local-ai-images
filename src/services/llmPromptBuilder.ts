import { AppError } from '../errors.ts';
import type { BuildImagePromptResponse, ImagePromptLlmRequestFormat, ImagePromptLlmSettings, RuntimeConfig } from '../types.ts';

export const DEFAULT_IMAGE_PROMPT_INSTRUCTION = [
  'The user is building a text-to-image positive prompt.',
  'Convert the user guidance into a clear, descriptive image prompt focused on visible subject matter, composition, style, lighting, materials, colors, and camera/framing details.',
  'Prefer concrete visual detail over commentary.',
  'Do not include explanations, markdown headings, bullets, JSON, or prose around the prompt unless the user explicitly asks for those.',
  'Return only the prompt text that should be placed into the positive prompt box.'
].join(' ');

const REQUEST_FORMATS: ImagePromptLlmRequestFormat[] = ['openai_chat', 'ollama_chat', 'ollama_generate', 'simple_json'];
const DEFAULT_TIMEOUT_MS = 30000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 600000;
const MAX_INSTRUCTION_CHARS = 8000;
const MAX_GUIDANCE_CHARS = 12000;
const MAX_TEMPERATURE = 2;
const MAX_MAX_TOKENS = 32768;

export function isImagePromptLlmRequestFormat(value: string): value is ImagePromptLlmRequestFormat {
  return REQUEST_FORMATS.includes(value as ImagePromptLlmRequestFormat);
}

export function imagePromptLlmSettingsFromRuntime(runtimeConfig: RuntimeConfig): ImagePromptLlmSettings {
  return {
    enabled: runtimeConfig.llmImagePromptEnabled,
    endpoint_url: runtimeConfig.llmImagePromptEndpointUrl,
    health_url: runtimeConfig.llmImagePromptHealthUrl,
    request_timeout_ms: runtimeConfig.llmImagePromptRequestTimeoutMs,
    request_format: runtimeConfig.llmImagePromptRequestFormat,
    instruction: runtimeConfig.llmImagePromptInstruction || DEFAULT_IMAGE_PROMPT_INSTRUCTION,
    temperature: runtimeConfig.llmImagePromptTemperature,
    max_tokens: runtimeConfig.llmImagePromptMaxTokens
  };
}

export function effectiveImagePromptLlmSettings(runtimeConfig: RuntimeConfig, configured?: Partial<ImagePromptLlmSettings> | null): ImagePromptLlmSettings {
  return normalizeImagePromptLlmSettings(configured, imagePromptLlmSettingsFromRuntime(runtimeConfig));
}

export function normalizeImagePromptLlmSettings(input: unknown, fallback?: Partial<ImagePromptLlmSettings> | null): ImagePromptLlmSettings {
  const source = isRecord(input) ? input : {};
  const base = fallback ?? {};
  const requestFormat = readString(source.request_format, base.request_format ?? 'openai_chat');
  return {
    enabled: readBoolean(source.enabled, base.enabled ?? false),
    endpoint_url: normalizeUrlString(readString(source.endpoint_url, base.endpoint_url ?? '')),
    health_url: normalizeUrlString(readString(source.health_url, base.health_url ?? '')),
    request_timeout_ms: readInteger(source.request_timeout_ms, base.request_timeout_ms ?? DEFAULT_TIMEOUT_MS),
    request_format: isImagePromptLlmRequestFormat(requestFormat) ? requestFormat : (base.request_format ?? 'openai_chat'),
    instruction: readString(source.instruction, base.instruction ?? DEFAULT_IMAGE_PROMPT_INSTRUCTION).trim() || DEFAULT_IMAGE_PROMPT_INSTRUCTION,
    temperature: readNullableNumber(source.temperature, base.temperature ?? null),
    max_tokens: readNullableInteger(source.max_tokens, base.max_tokens ?? null)
  };
}

export function validateImagePromptLlmSettings(input: unknown, fallback?: Partial<ImagePromptLlmSettings> | null): ImagePromptLlmSettings {
  const source = isRecord(input) ? input : {};
  const normalized = normalizeImagePromptLlmSettings(source, fallback);
  const errors: Array<{ field: string; message: string }> = [];

  if (typeof source.enabled !== 'boolean') {
    errors.push({ field: 'enabled', message: 'enabled must be true or false.' });
  }

  if (normalized.enabled && normalized.endpoint_url === '') {
    errors.push({ field: 'endpoint_url', message: 'endpoint_url is required when the LLM image prompt integration is enabled.' });
  }

  if (normalized.endpoint_url && !isHttpUrl(normalized.endpoint_url)) {
    errors.push({ field: 'endpoint_url', message: 'endpoint_url must be an http:// or https:// URL.' });
  }

  if (normalized.health_url && !isHttpUrl(normalized.health_url)) {
    errors.push({ field: 'health_url', message: 'health_url must be blank or an http:// or https:// URL.' });
  }

  if (!isImagePromptLlmRequestFormat(String(normalized.request_format))) {
    errors.push({ field: 'request_format', message: `request_format must be one of: ${REQUEST_FORMATS.join(', ')}.` });
  }

  if (!Number.isInteger(normalized.request_timeout_ms) || normalized.request_timeout_ms < MIN_TIMEOUT_MS || normalized.request_timeout_ms > MAX_TIMEOUT_MS) {
    errors.push({ field: 'request_timeout_ms', message: `request_timeout_ms must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}.` });
  }

  if (!normalized.instruction.trim()) {
    errors.push({ field: 'instruction', message: 'instruction must not be blank.' });
  } else if (normalized.instruction.length > MAX_INSTRUCTION_CHARS) {
    errors.push({ field: 'instruction', message: `instruction must be ${MAX_INSTRUCTION_CHARS} characters or fewer.` });
  }

  if (normalized.temperature !== null && (!Number.isFinite(normalized.temperature) || normalized.temperature < 0 || normalized.temperature > MAX_TEMPERATURE)) {
    errors.push({ field: 'temperature', message: `temperature must be blank or a number from 0 to ${MAX_TEMPERATURE}.` });
  }

  if (normalized.max_tokens !== null && (!Number.isInteger(normalized.max_tokens) || normalized.max_tokens < 1 || normalized.max_tokens > MAX_MAX_TOKENS)) {
    errors.push({ field: 'max_tokens', message: `max_tokens must be blank or an integer from 1 to ${MAX_MAX_TOKENS}.` });
  }

  if (errors.length > 0) {
    throw new AppError('LLM_IMAGE_PROMPT_SETTINGS_INVALID', 'LLM image prompt settings are invalid.', 422, { errors });
  }

  return normalized;
}

export async function buildImagePromptWithLlm(settings: ImagePromptLlmSettings, guidance: string): Promise<BuildImagePromptResponse> {
  const trimmedGuidance = guidance.trim();
  if (!trimmedGuidance) {
    throw new AppError('LLM_IMAGE_PROMPT_GUIDANCE_EMPTY', 'Guidance must be a non-empty string.', 422);
  }
  if (trimmedGuidance.length > MAX_GUIDANCE_CHARS) {
    throw new AppError('LLM_IMAGE_PROMPT_GUIDANCE_TOO_LONG', `Guidance must be ${MAX_GUIDANCE_CHARS} characters or fewer.`, 422);
  }
  if (!settings.enabled) {
    throw new AppError('LLM_IMAGE_PROMPT_DISABLED', 'The local LLM image prompt integration is disabled. Enable and save it in the status portal before sending guidance.', 503);
  }
  if (!settings.endpoint_url) {
    throw new AppError('LLM_IMAGE_PROMPT_NOT_CONFIGURED', 'No local LLM endpoint URL is configured for image prompt building.', 503);
  }

  validateImagePromptLlmSettings(settings, settings);

  const startedAt = Date.now();
  const body = buildProviderRequestBody(settings, trimmedGuidance);
  const raw = await requestProviderText(settings.endpoint_url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/plain;q=0.9, */*;q=0.8' },
    body: JSON.stringify(body)
  }, settings.request_timeout_ms);

  const parsed = parseProviderResponse(raw.text, raw.contentType);
  const prompt = cleanPromptText(extractPromptText(parsed));
  if (!prompt) {
    throw new AppError('LLM_IMAGE_PROMPT_EMPTY_RESPONSE', 'The local LLM returned an empty prompt response.', 502);
  }

  return {
    prompt,
    modelInfo: extractModelInfo(parsed),
    elapsedMs: Date.now() - startedAt
  };
}

export async function testImagePromptLlmConnection(settings: ImagePromptLlmSettings): Promise<{ ok: true; status: number; message: string; checkedUrl: string }> {
  if (!settings.enabled) {
    throw new AppError('LLM_IMAGE_PROMPT_DISABLED', 'The local LLM image prompt integration is disabled.', 503);
  }
  if (!settings.endpoint_url) {
    throw new AppError('LLM_IMAGE_PROMPT_NOT_CONFIGURED', 'No local LLM endpoint URL is configured.', 503);
  }

  validateImagePromptLlmSettings(settings, settings);
  const checkedUrl = settings.health_url || settings.endpoint_url;
  const method = settings.health_url ? 'GET' : 'OPTIONS';
  const status = await requestReachability(checkedUrl, method, settings.request_timeout_ms);
  const message = settings.health_url
    ? `Health URL responded with HTTP ${status}.`
    : `Endpoint was reachable with HTTP ${status}; no prompt request was sent, so no model was selected or loaded by this test.`;
  return { ok: true, status, message, checkedUrl };
}

function buildProviderRequestBody(settings: ImagePromptLlmSettings, guidance: string): Record<string, unknown> {
  const temperature = settings.temperature;
  const maxTokens = settings.max_tokens;
  const promptText = `${settings.instruction.trim()}\n\nUser guidance:\n${guidance}\n\nReturn only the positive image prompt text.`;
  const messages = [
    { role: 'system', content: settings.instruction.trim() },
    { role: 'user', content: guidance }
  ];

  if (settings.request_format === 'ollama_generate') {
    return withOptionalGenerationParams({ prompt: promptText, stream: false }, temperature, maxTokens, true);
  }

  if (settings.request_format === 'ollama_chat') {
    return withOptionalGenerationParams({ messages, stream: false }, temperature, maxTokens, true);
  }

  if (settings.request_format === 'simple_json') {
    return withOptionalGenerationParams({ instruction: settings.instruction.trim(), guidance, stream: false }, temperature, maxTokens, false);
  }

  return withOptionalGenerationParams({ messages, stream: false }, temperature, maxTokens, false);
}

function withOptionalGenerationParams(base: Record<string, unknown>, temperature: number | null, maxTokens: number | null, useOllamaOptions: boolean): Record<string, unknown> {
  if (useOllamaOptions) {
    const options: Record<string, unknown> = {};
    if (temperature !== null) options.temperature = temperature;
    if (maxTokens !== null) options.num_predict = maxTokens;
    return Object.keys(options).length > 0 ? { ...base, options } : base;
  }

  return {
    ...base,
    ...(temperature !== null ? { temperature } : {}),
    ...(maxTokens !== null ? { max_tokens: maxTokens } : {})
  };
}

async function requestProviderText(url: string, init: RequestInit, timeoutMs: number): Promise<{ text: string; contentType: string }> {
  const response = await requestWithTimeout(url, init, timeoutMs);
  const text = await response.text();
  if (!response.ok) {
    const providerMessage = providerErrorMessage(text);
    throw new AppError('LLM_IMAGE_PROMPT_PROVIDER_ERROR', providerMessage || `Local LLM endpoint returned HTTP ${response.status}.`, response.status >= 400 && response.status < 500 ? 502 : 503, {
      status: response.status,
      endpoint_url: redactedUrl(url)
    });
  }
  return { text, contentType: response.headers.get('content-type') || '' };
}

async function requestReachability(url: string, method: string, timeoutMs: number): Promise<number> {
  const response = await requestWithTimeout(url, { method, headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.8' } }, timeoutMs);
  if (response.status >= 500) {
    throw new AppError('LLM_IMAGE_PROMPT_HEALTH_FAILED', `Local LLM service responded with HTTP ${response.status}.`, 503, {
      status: response.status,
      checked_url: redactedUrl(url)
    });
  }
  await response.arrayBuffer().catch(() => new ArrayBuffer(0));
  return response.status;
}

async function requestWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error: unknown) {
    if (isAbortError(error)) {
      throw new AppError('LLM_IMAGE_PROMPT_TIMEOUT', `Timed out talking to the local LLM endpoint after ${timeoutMs}ms.`, 504, {
        endpoint_url: redactedUrl(url)
      });
    }
    throw new AppError('LLM_IMAGE_PROMPT_UNAVAILABLE', 'Unable to connect to the configured local LLM endpoint.', 503, {
      endpoint_url: redactedUrl(url),
      cause: error instanceof Error ? error.message : String(error),
      timed_out: timedOut
    });
  } finally {
    clearTimeout(timeout);
  }
}

function providerErrorMessage(text: string): string | null {
  const parsed = parseMaybeJson(text);
  const candidates: unknown[] = [];
  if (isRecord(parsed)) {
    candidates.push(parsed.error);
    candidates.push(parsed.message);
    if (isRecord(parsed.error)) candidates.push(parsed.error.message);
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

function parseProviderResponse(raw: string, contentType: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (isJsonContentType(contentType)) {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      const records = parseNdjsonRecords(trimmed);
      if (records.length > 0) return records;
      throw new AppError('LLM_IMAGE_PROMPT_MALFORMED_RESPONSE', 'The local LLM endpoint returned malformed JSON.', 502);
    }
  }
  return parseMaybeJson(trimmed);
}

function parseMaybeJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const records = parseNdjsonRecords(trimmed);
    return records.length > 0 ? records : trimmed;
  }
}

function isJsonContentType(contentType: string): boolean {
  return /(?:^|;)\s*(?:application\/json|[^;]+\+json)/iu.test(contentType);
}

function parseNdjsonRecords(raw: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // Ignore partial or provider-specific progress lines; the caller validates the final prompt text.
    }
  }
  return records;
}

function extractPromptText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const record of [...value].reverse()) {
      const text = extractPromptText(record);
      if (text.trim()) return text;
    }
    return '';
  }
  if (!isRecord(value)) return '';

  const directKeys = ['prompt', 'text', 'output', 'response', 'content', 'completion'];
  for (const key of directKeys) {
    const item = value[key];
    if (typeof item === 'string' && item.trim()) return item;
  }

  const message = value.message;
  if (isRecord(message) && typeof message.content === 'string' && message.content.trim()) {
    return message.content;
  }

  const choices = value.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!isRecord(choice)) continue;
      if (typeof choice.text === 'string' && choice.text.trim()) return choice.text;
      if (isRecord(choice.message) && typeof choice.message.content === 'string' && choice.message.content.trim()) {
        return choice.message.content;
      }
      if (isRecord(choice.delta) && typeof choice.delta.content === 'string' && choice.delta.content.trim()) {
        return choice.delta.content;
      }
    }
  }

  const result = value.result;
  if (typeof result === 'string' && result.trim()) return result;
  if (isRecord(result)) return extractPromptText(result);

  const data = value.data;
  if (typeof data === 'string' && data.trim()) return data;
  if (isRecord(data) || Array.isArray(data)) return extractPromptText(data);

  return '';
}

function extractModelInfo(value: unknown): string | null {
  const record = Array.isArray(value) ? [...value].reverse().find(isRecord) : value;
  if (!isRecord(record)) return null;
  const model = record.model;
  if (typeof model === 'string' && model.trim()) return model.trim();
  const id = record.id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

export function cleanPromptText(value: string): string {
  let text = value.trim();
  if (!text) return '';

  const fenceMatch = /^```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)\s*```$/u.exec(text);
  if (fenceMatch?.[1]) text = fenceMatch[1].trim();

  text = text
    .split(/\r?\n/u)
    .map((line) => line.replace(/^#{1,6}\s+/u, '').trimEnd())
    .filter((line) => !/^[-*_]{3,}$/u.test(line.trim()))
    .join('\n')
    .trim();

  text = text.replace(/^(?:positive\s+)?(?:image\s+)?prompt\s*:\s*/iu, '').trim();
  text = text.replace(/^here(?:'s| is)\s+(?:the\s+)?(?:positive\s+)?(?:image\s+)?prompt\s*:\s*/iu, '').trim();

  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }

  return text;
}

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  return fallback;
}

function readInteger(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) return parsed;
  }
  return fallback;
}

function readNullableNumber(value: unknown, fallback: number | null): number | null {
  if (value === null || value === '') return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function readNullableInteger(value: unknown, fallback: number | null): number | null {
  if (value === null || value === '') return null;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : fallback;
  }
  return fallback;
}

function normalizeUrlString(value: string): string {
  return value.trim().replace(/\/+$/u, '');
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function redactedUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = '[redacted]';
    if (url.password) url.password = '[redacted]';
    return url.toString();
  } catch {
    return value;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
