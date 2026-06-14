type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

const LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 999
};

export interface Logger {
  trace(data: Record<string, unknown> | string, message?: string): void;
  debug(data: Record<string, unknown> | string, message?: string): void;
  info(data: Record<string, unknown> | string, message?: string): void;
  warn(data: Record<string, unknown> | string, message?: string): void;
  error(data: Record<string, unknown> | string, message?: string): void;
  fatal(data: Record<string, unknown> | string, message?: string): void;
}

export function createLogger(levelName: string): Logger {
  const threshold = LEVELS[(levelName as LogLevel) in LEVELS ? (levelName as LogLevel) : 'info'];

  const write = (level: LogLevel, data: Record<string, unknown> | string, message?: string): void => {
    if (LEVELS[level] < threshold) {
      return;
    }

    const payload: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      msg: typeof data === 'string' ? data : message ?? ''
    };

    if (typeof data !== 'string') {
      Object.assign(payload, sanitizeForLog(data));
    }

    const line = JSON.stringify(payload, jsonErrorReplacer);
    if (LEVELS[level] >= LEVELS.error) {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  };

  return {
    trace: (data, message) => write('trace', data, message),
    debug: (data, message) => write('debug', data, message),
    info: (data, message) => write('info', data, message),
    warn: (data, message) => write('warn', data, message),
    error: (data, message) => write('error', data, message),
    fatal: (data, message) => write('fatal', data, message)
  };
}

function sanitizeForLog(data: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...data };
  if (clone.headers && typeof clone.headers === 'object') {
    const headers = { ...(clone.headers as Record<string, unknown>) };
    for (const key of Object.keys(headers)) {
      if (['authorization', 'cookie', 'set-cookie'].includes(key.toLowerCase())) {
        headers[key] = '[redacted]';
      }
    }
    clone.headers = headers;
  }
  return clone;
}

function jsonErrorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }
  return value;
}
