import type { ImageGenerationOptions } from '../types.ts';

export interface ValidationDetail {
  loc: Array<string | number>;
  msg: string;
  type: string;
  input?: unknown;
  ctx: Record<string, unknown>;
}

export interface ValidationErrorResponse {
  detail: ValidationDetail[];
}

export interface ModelLoadRequest {
  model: string;
  make_default: boolean;
}

export interface ImageGenerateRequest {
  prompt: string;
  model?: string;
  options?: ImageGenerationOptions;
}

const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MIN_IMAGE_DIMENSION = 64;
const MAX_IMAGE_DIMENSION = 4096;
const MIN_IMAGE_STEPS = 1;
const MAX_IMAGE_STEPS = 150;

export function isValidModelName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 128 && MODEL_NAME_PATTERN.test(value.trim());
}

export function validateModelName(value: unknown, loc: Array<string | number>): ValidationDetail[] {
  if (typeof value !== 'string') {
    return [{
      loc,
      msg: 'Input should be a valid string',
      type: 'string_type',
      input: value,
      ctx: {}
    }];
  }

  const trimmed = value.trim();
  if (trimmed.length < 1) {
    return [{
      loc,
      msg: 'String should have at least 1 character',
      type: 'string_too_short',
      input: value,
      ctx: { min_length: 1 }
    }];
  }

  if (trimmed.length > 128) {
    return [{
      loc,
      msg: 'String should have at most 128 characters',
      type: 'string_too_long',
      input: value,
      ctx: { max_length: 128 }
    }];
  }

  if (!MODEL_NAME_PATTERN.test(trimmed)) {
    return [{
      loc,
      msg: 'Model name may contain letters, numbers, dot, dash, underscore, slash, and colon only, and must start with a letter or number',
      type: 'string_pattern_mismatch',
      input: value,
      ctx: { pattern: MODEL_NAME_PATTERN.source }
    }];
  }

  return [];
}

export function validateModelLoadRequest(body: unknown): { ok: true; value: ModelLoadRequest } | { ok: false; response: ValidationErrorResponse } {
  const details: ValidationDetail[] = [];

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
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

  const record = body as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'model')) {
    details.push({
      loc: ['body', 'model'],
      msg: 'Field required',
      type: 'missing',
      input: body,
      ctx: {}
    });
  } else {
    details.push(...validateModelName(record.model, ['body', 'model']));
  }

  if (record.make_default !== undefined && typeof record.make_default !== 'boolean') {
    details.push({
      loc: ['body', 'make_default'],
      msg: 'Input should be a valid boolean',
      type: 'bool_type',
      input: record.make_default,
      ctx: {}
    });
  }

  if (details.length > 0) {
    return { ok: false, response: { detail: details } };
  }

  return {
    ok: true,
    value: {
      model: String(record.model).trim(),
      make_default: typeof record.make_default === 'boolean' ? record.make_default : false
    }
  };
}

export function validateImageGenerateRequest(
  body: unknown,
  maxPromptChars: number
): { ok: true; value: ImageGenerateRequest } | { ok: false; response: ValidationErrorResponse } {
  const details: ValidationDetail[] = [];

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
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

  const record = body as Record<string, unknown>;
  if (typeof record.prompt !== 'string') {
    details.push({
      loc: ['body', 'prompt'],
      msg: 'Input should be a valid string',
      type: 'string_type',
      input: record.prompt,
      ctx: {}
    });
  } else {
    const prompt = record.prompt.trim();
    if (prompt.length < 1) {
      details.push({
        loc: ['body', 'prompt'],
        msg: 'String should have at least 1 character',
        type: 'string_too_short',
        input: record.prompt,
        ctx: { min_length: 1 }
      });
    }
    if (prompt.length > maxPromptChars) {
      details.push({
        loc: ['body', 'prompt'],
        msg: `String should have at most ${maxPromptChars} characters`,
        type: 'string_too_long',
        input: record.prompt,
        ctx: { max_length: maxPromptChars }
      });
    }
  }

  if (record.model !== undefined) {
    details.push(...validateModelName(record.model, ['body', 'model']));
  }

  const optionsResult = validateImageOptions(record.options, ['body', 'options']);
  details.push(...optionsResult.details);

  if (details.length > 0) {
    return { ok: false, response: { detail: details } };
  }

  return {
    ok: true,
    value: {
      prompt: String(record.prompt).trim(),
      model: record.model === undefined ? undefined : String(record.model).trim(),
      options: optionsResult.value
    }
  };
}

function validateImageOptions(
  value: unknown,
  loc: Array<string | number>
): { value: ImageGenerationOptions | undefined; details: ValidationDetail[] } {
  if (value === undefined) return { value: undefined, details: [] };

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      value: undefined,
      details: [{
        loc,
        msg: 'Input should be a valid object',
        type: 'model_attributes_type',
        input: value,
        ctx: {}
      }]
    };
  }

  const record = value as Record<string, unknown>;
  const details: ValidationDetail[] = [];
  const options: ImageGenerationOptions = {};

  for (const key of ['width', 'height'] as const) {
    const parsed = validateOptionalInteger(record[key], [...loc, key], MIN_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION);
    details.push(...parsed.details);
    if (parsed.value !== undefined) options[key] = parsed.value;
  }

  const steps = validateOptionalInteger(record.steps, [...loc, 'steps'], MIN_IMAGE_STEPS, MAX_IMAGE_STEPS);
  details.push(...steps.details);
  if (steps.value !== undefined) options.steps = steps.value;

  return { value: Object.keys(options).length > 0 ? options : undefined, details };
}

function validateOptionalInteger(
  value: unknown,
  loc: Array<string | number>,
  minimum: number,
  maximum: number
): { value: number | undefined; details: ValidationDetail[] } {
  if (value === undefined) return { value: undefined, details: [] };

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return {
      value: undefined,
      details: [{
        loc,
        msg: 'Input should be a valid integer',
        type: 'int_type',
        input: value,
        ctx: {}
      }]
    };
  }

  if (value < minimum || value > maximum) {
    return {
      value: undefined,
      details: [{
        loc,
        msg: `Input should be between ${minimum} and ${maximum}`,
        type: 'int_range',
        input: value,
        ctx: { ge: minimum, le: maximum }
      }]
    };
  }

  return { value, details: [] };
}
