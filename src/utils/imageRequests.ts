import type { RuntimeConfig, NormalizedGenerationRequest, OutputDelivery, WorkflowPreset } from '../types.ts';
import type { ValidationDetail, ValidationErrorResponse } from './validation.ts';

const MIN_DIMENSION = 64;
const MAX_DIMENSION = 4096;
const MIN_STEPS = 1;
const MAX_STEPS = 150;
const MIN_CFG = 0;
const MAX_CFG = 30;
const MAX_SEED = Number.MAX_SAFE_INTEGER;

export function validateAndNormalizeGenerationRequest(
  body: unknown,
  runtimeConfig: RuntimeConfig,
  workflows: WorkflowPreset[],
  options: { defaultImageModel?: string | null } = {}
): { ok: true; value: NormalizedGenerationRequest; workflow: WorkflowPreset } | { ok: false; response: ValidationErrorResponse } {
  const details: ValidationDetail[] = [];

  if (!isRecord(body)) {
    return {
      ok: false,
      response: {
        detail: [{
          loc: ['body'],
          msg: 'Input should be a valid object',
          type: 'model_attributes_type',
          input: body,
          ctx: {}
        }]
      }
    };
  }

  const promptRaw = body.prompt ?? body.positive_prompt;
  const prompt = validateString(promptRaw, ['body', 'prompt'], 1, runtimeConfig.imageGenerationMaxPromptChars, details);
  const negativePrompt = validateString(body.negative_prompt ?? body.negativePrompt ?? '', ['body', 'negative_prompt'], 0, runtimeConfig.imageGenerationMaxPromptChars, details) ?? '';
  const workflowId = validateWorkflowId(body.workflow_id ?? body.workflowId ?? runtimeConfig.imageDefaultWorkflowId, workflows, details);
  const workflow = workflows.find((item) => item.id === workflowId) ?? workflows[0]!;

  const defaultImageModel = workflow.comfyui.mappings.checkpointNode && options.defaultImageModel ? options.defaultImageModel : null;
  const model = validateOptionalModel(body.model ?? defaultImageModel ?? workflow.defaults.checkpoint ?? null, details);
  const width = validateInteger(body.width, ['body', 'width'], MIN_DIMENSION, MAX_DIMENSION, workflow.defaults.width ?? 1024, details);
  const height = validateInteger(body.height, ['body', 'height'], MIN_DIMENSION, MAX_DIMENSION, workflow.defaults.height ?? 1024, details);
  const steps = validateInteger(body.steps, ['body', 'steps'], MIN_STEPS, MAX_STEPS, workflow.defaults.steps ?? 28, details);
  const cfgScale = validateNumber(body.cfg_scale ?? body.cfgScale, ['body', 'cfg_scale'], MIN_CFG, MAX_CFG, workflow.defaults.cfgScale ?? 7, details);
  const seed = normalizeSeed(body.seed, workflow.defaults.seed ?? -1, details);
  const samplerName = validateString(body.sampler_name ?? body.samplerName ?? workflow.defaults.samplerName ?? 'euler', ['body', 'sampler_name'], 1, 64, details) ?? 'euler';
  const scheduler = validateString(body.scheduler ?? workflow.defaults.scheduler ?? 'normal', ['body', 'scheduler'], 1, 64, details) ?? 'normal';
  const output = validateOutputDelivery(body.output ?? body.output_delivery ?? body.outputDelivery, details);
  const syncTimeoutMs = validateSyncTimeout(body.sync_timeout_ms ?? body.syncTimeoutMs, runtimeConfig, details);
  const metadata = validateMetadata(body.metadata, details);

  if (details.length > 0 || !prompt || !workflow) {
    return { ok: false, response: { detail: details } };
  }

  return {
    ok: true,
    workflow,
    value: {
      prompt,
      negativePrompt,
      model,
      workflowId: workflow.id,
      width,
      height,
      steps,
      cfgScale,
      seed,
      samplerName,
      scheduler,
      output,
      syncTimeoutMs,
      metadata
    }
  };
}


export function generationRequestToApiPayload(request: NormalizedGenerationRequest, sourcePayload: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...cloneRecord(sourcePayload),
    prompt: request.prompt,
    negative_prompt: request.negativePrompt,
    model: request.model,
    workflow_id: request.workflowId,
    width: request.width,
    height: request.height,
    steps: request.steps,
    cfg_scale: request.cfgScale,
    seed: request.seed,
    sampler_name: request.samplerName,
    scheduler: request.scheduler,
    output: request.output,
    sync_timeout_ms: request.syncTimeoutMs,
    metadata: request.metadata
  };
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

export function normalizeResultDelivery(value: string | null, fallback: OutputDelivery): OutputDelivery | null {
  if (!value || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'metadata' || normalized === 'url' || normalized === 'base64' || normalized === 'binary') {
    return normalized;
  }
  return null;
}

function validateString(
  value: unknown,
  loc: Array<string | number>,
  minLength: number,
  maxLength: number,
  details: ValidationDetail[]
): string | null {
  if (typeof value !== 'string') {
    details.push({ loc, msg: 'Input should be a valid string', type: 'string_type', input: value, ctx: {} });
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length < minLength) {
    details.push({ loc, msg: `String should have at least ${minLength} character${minLength === 1 ? '' : 's'}`, type: 'string_too_short', input: value, ctx: { min_length: minLength } });
    return null;
  }

  if (trimmed.length > maxLength) {
    details.push({ loc, msg: `String should have at most ${maxLength} characters`, type: 'string_too_long', input: value, ctx: { max_length: maxLength } });
    return null;
  }

  return trimmed;
}

function validateWorkflowId(value: unknown, workflows: WorkflowPreset[], details: ValidationDetail[]): string {
  const workflowId = validateString(value, ['body', 'workflow_id'], 1, 128, details);
  if (!workflowId) return workflows[0]?.id ?? 'unknown';
  if (!workflows.some((item) => item.id === workflowId)) {
    details.push({
      loc: ['body', 'workflow_id'],
      msg: `Workflow preset ${workflowId} does not exist`,
      type: 'value_error',
      input: value,
      ctx: { available: workflows.map((item) => item.id) }
    });
  }
  return workflowId;
}

function validateOptionalModel(value: unknown, details: ValidationDetail[]): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    details.push({ loc: ['body', 'model'], msg: 'Input should be a valid string', type: 'string_type', input: value, ctx: {} });
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length > 255 || /[\u0000-\u001f]/u.test(trimmed)) {
    details.push({ loc: ['body', 'model'], msg: 'Model name/path should be 255 printable characters or fewer', type: 'string_pattern_mismatch', input: value, ctx: {} });
    return null;
  }
  return trimmed || null;
}

function validateInteger(
  value: unknown,
  loc: Array<string | number>,
  min: number,
  max: number,
  fallback: number,
  details: ValidationDetail[]
): number {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    details.push({ loc, msg: 'Input should be a valid integer', type: 'int_type', input: value, ctx: {} });
    return fallback;
  }
  if (value < min || value > max) {
    details.push({ loc, msg: `Input should be between ${min} and ${max}`, type: 'int_range', input: value, ctx: { ge: min, le: max } });
    return fallback;
  }
  return value;
}

function validateNumber(
  value: unknown,
  loc: Array<string | number>,
  min: number,
  max: number,
  fallback: number,
  details: ValidationDetail[]
): number {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    details.push({ loc, msg: 'Input should be a valid number', type: 'float_type', input: value, ctx: {} });
    return fallback;
  }
  if (value < min || value > max) {
    details.push({ loc, msg: `Input should be between ${min} and ${max}`, type: 'float_range', input: value, ctx: { ge: min, le: max } });
    return fallback;
  }
  return value;
}

function normalizeSeed(value: unknown, fallback: number, details: ValidationDetail[]): number {
  const candidate = value === undefined || value === null || value === '' ? fallback : value;
  if (typeof candidate !== 'number' || !Number.isInteger(candidate)) {
    details.push({ loc: ['body', 'seed'], msg: 'Input should be a valid integer', type: 'int_type', input: value, ctx: {} });
    return randomSeed();
  }
  if (candidate < -1 || candidate > MAX_SEED) {
    details.push({ loc: ['body', 'seed'], msg: `Seed should be -1 or between 0 and ${MAX_SEED}`, type: 'int_range', input: value, ctx: { ge: -1, le: MAX_SEED } });
    return randomSeed();
  }
  return candidate < 0 ? randomSeed() : candidate;
}

function validateOutputDelivery(value: unknown, details: ValidationDetail[]): OutputDelivery {
  if (value === undefined || value === null || value === '') return 'url';
  const raw = isRecord(value) ? value.delivery ?? value.format : value;
  if (typeof raw !== 'string') {
    details.push({ loc: ['body', 'output'], msg: 'Output delivery should be metadata, url, base64, or binary', type: 'enum_type', input: value, ctx: {} });
    return 'url';
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'metadata' || normalized === 'url' || normalized === 'base64' || normalized === 'binary') return normalized;
  details.push({ loc: ['body', 'output'], msg: 'Output delivery should be metadata, url, base64, or binary', type: 'enum', input: value, ctx: { allowed: ['metadata', 'url', 'base64', 'binary'] } });
  return 'url';
}

function validateSyncTimeout(value: unknown, runtimeConfig: RuntimeConfig, details: ValidationDetail[]): number {
  const fallback = runtimeConfig.imageDefaultSyncTimeoutMs;
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    details.push({ loc: ['body', 'sync_timeout_ms'], msg: 'Input should be a valid integer', type: 'int_type', input: value, ctx: {} });
    return fallback;
  }
  if (value < 0 || value > runtimeConfig.imageMaxSyncTimeoutMs) {
    details.push({ loc: ['body', 'sync_timeout_ms'], msg: `Input should be between 0 and ${runtimeConfig.imageMaxSyncTimeoutMs}`, type: 'int_range', input: value, ctx: { ge: 0, le: runtimeConfig.imageMaxSyncTimeoutMs } });
    return fallback;
  }
  return value;
}

function validateMetadata(value: unknown, details: ValidationDetail[]): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) {
    details.push({ loc: ['body', 'metadata'], msg: 'Input should be a valid object', type: 'model_attributes_type', input: value, ctx: {} });
    return {};
  }
  return value;
}

function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 32);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
