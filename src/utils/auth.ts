import type { IncomingMessage } from 'node:http';
import { AppError } from '../errors.ts';
import type { RuntimeConfig } from '../types.ts';

export interface AuthResult {
  enabled: boolean;
  authenticated: boolean;
  apiKeyId: string | null;
}

export function authenticateImageApiRequest(request: IncomingMessage, runtimeConfig: RuntimeConfig): AuthResult {
  const configuredKeys = runtimeConfig.imageApiKeys;
  const enabled = runtimeConfig.requireImageApiAuth || configuredKeys.length > 0;

  if (!enabled) {
    return { enabled: false, authenticated: true, apiKeyId: null };
  }

  if (configuredKeys.length === 0) {
    throw new AppError('AUTH_NOT_CONFIGURED', 'Image API authentication is required but IMAGE_API_KEYS is empty.', 503);
  }

  const supplied = readSuppliedApiKey(request);
  if (!supplied) {
    throw new AppError('AUTH_REQUIRED', 'Supply an API key with Authorization: Bearer <key> or X-API-Key.', 401);
  }

  const index = configuredKeys.findIndex((candidate) => timingSafeStringEqual(candidate, supplied));
  if (index < 0) {
    throw new AppError('AUTH_INVALID', 'The supplied image API credential is invalid.', 403);
  }

  return {
    enabled: true,
    authenticated: true,
    apiKeyId: `key-${index + 1}`
  };
}

function readSuppliedApiKey(request: IncomingMessage): string | null {
  const authorization = headerValue(request, 'authorization');
  if (authorization) {
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (bearerMatch?.[1]) {
      return bearerMatch[1].trim();
    }
  }

  const xApiKey = headerValue(request, 'x-api-key');
  if (xApiKey) return xApiKey.trim();

  return null;
}

function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' ? value : null;
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;

  let result = 0;
  for (let index = 0; index < leftBuffer.length; index += 1) {
    result |= leftBuffer[index]! ^ rightBuffer[index]!;
  }
  return result === 0;
}
