export interface ErrorPayload {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(code: string, message: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function toErrorPayload(error: unknown, fallbackCode = 'INTERNAL_ERROR'): ErrorPayload {
  if (error instanceof AppError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details })
      }
    };
  }

  if (error instanceof Error) {
    return {
      ok: false,
      error: {
        code: fallbackCode,
        message: error.message
      }
    };
  }

  return {
    ok: false,
    error: {
      code: fallbackCode,
      message: 'Unknown error'
    }
  };
}

export function statusCodeForError(error: unknown, fallback = 500): number {
  return error instanceof AppError ? error.statusCode : fallback;
}
