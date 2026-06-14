import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from '../errors.ts';
import type { GpuServiceLike, GpuTelemetry, LegacyGpuTelemetry } from '../types.ts';

const execFileAsync = promisify(execFile);

const GPU_QUERY_FIELDS = [
  'index',
  'uuid',
  'name',
  'driver_version',
  'memory.total',
  'memory.used',
  'memory.free',
  'utilization.gpu',
  'temperature.gpu',
  'power.draw',
  'power.limit'
] as const;

export class NvidiaSmiGpuService implements GpuServiceLike {
  private readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    this.timeoutMs = timeoutMs;
  }

  async queryGpus(): Promise<GpuTelemetry[]> {
    let stdout = '';
    let stderr = '';

    try {
      const result = await execFileAsync('nvidia-smi', [
        `--query-gpu=${GPU_QUERY_FIELDS.join(',')}`,
        '--format=csv,noheader,nounits'
      ], {
        timeout: this.timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error: unknown) {
      throw classifyNvidiaSmiError(error, this.timeoutMs);
    }

    try {
      const gpus = parseNvidiaSmiCsv(stdout);
      if (gpus.length === 0) {
        throw new AppError('NO_GPUS_DETECTED', 'nvidia-smi returned no GPU rows', 503, { stderr });
      }
      return gpus;
    } catch (error: unknown) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError('GPU_TELEMETRY_PARSE_FAILED', 'Unable to parse nvidia-smi GPU telemetry', 502, {
        stdout,
        stderr,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

export function parseNvidiaSmiCsv(stdout: string): GpuTelemetry[] {
  const rows = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return rows.map((line, rowIndex) => {
    const columns = parseCsvLine(line);
    if (columns.length < GPU_QUERY_FIELDS.length) {
      throw new Error(`Expected ${GPU_QUERY_FIELDS.length} columns, got ${columns.length} on row ${rowIndex}`);
    }

    const warnings: string[] = [];
    const parse = (value: string, field: string): number | null => parseNumeric(value, field, warnings);

    const index = parse(columns[0] ?? '', 'index');
    if (index === null) {
      throw new Error(`GPU row ${rowIndex} has invalid index`);
    }

    const gpu: GpuTelemetry = {
      index,
      uuid: normalizeText(columns[1] ?? ''),
      name: normalizeText(columns[2] ?? '') ?? `GPU ${index}`,
      driver_version: normalizeText(columns[3] ?? ''),
      memory_total_mib: parse(columns[4] ?? '', 'memory_total_mib'),
      memory_used_mib: parse(columns[5] ?? '', 'memory_used_mib'),
      memory_free_mib: parse(columns[6] ?? '', 'memory_free_mib'),
      utilization_gpu_percent: parse(columns[7] ?? '', 'utilization_gpu_percent'),
      temperature_c: parse(columns[8] ?? '', 'temperature_c'),
      power_draw_w: parse(columns[9] ?? '', 'power_draw_w'),
      power_limit_w: parse(columns[10] ?? '', 'power_limit_w')
    };

    if (warnings.length > 0) {
      gpu.warnings = warnings;
    }

    return gpu;
  }).sort((left, right) => left.index - right.index);
}

export function toLegacyGpu(gpu: GpuTelemetry): LegacyGpuTelemetry {
  return {
    name: gpu.name,
    driver_version: gpu.driver_version,
    memory_total_mib: gpu.memory_total_mib,
    memory_used_mib: gpu.memory_used_mib,
    memory_free_mib: gpu.memory_free_mib,
    utilization_gpu_percent: gpu.utilization_gpu_percent,
    temperature_c: gpu.temperature_c,
    power_draw_w: gpu.power_draw_w,
    power_limit_w: gpu.power_limit_w
  };
}

function parseCsvLine(line: string): string[] {
  const columns: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      columns.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  columns.push(current.trim());
  return columns;
}

function normalizeText(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'N/A' || trimmed === '[Not Supported]' || trimmed === 'Not Supported') {
    return null;
  }
  return trimmed;
}

function parseNumeric(value: string, field: string, warnings: string[]): number | null {
  const normalized = normalizeText(value);
  if (normalized === null) {
    warnings.push(`${field} unavailable`);
    return null;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    warnings.push(`${field} is not numeric: ${value}`);
    return null;
  }

  return parsed;
}

function classifyNvidiaSmiError(error: unknown, timeoutMs: number): AppError {
  if (isNodeError(error) && error.code === 'ENOENT') {
    return new AppError('NVIDIA_SMI_UNAVAILABLE', 'nvidia-smi is not installed or is not on PATH', 503);
  }

  if (isNodeError(error) && (error.killed || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT')) {
    return new AppError('GPU_QUERY_TIMEOUT', `nvidia-smi timed out after ${timeoutMs}ms`, 504);
  }

  const stdout = isExecError(error) ? error.stdout : undefined;
  const stderr = isExecError(error) ? error.stderr : undefined;
  const combined = `${stdout ?? ''}\n${stderr ?? ''}`.toLowerCase();

  if (combined.includes('couldn\'t communicate') || combined.includes('driver/library version mismatch') || combined.includes('failed to initialize nvml')) {
    return new AppError('NVIDIA_DRIVER_UNAVAILABLE', 'NVIDIA driver or NVML is unavailable', 503, {
      stdout,
      stderr
    });
  }

  return new AppError('GPU_TELEMETRY_FAILED', 'Unable to query NVIDIA GPU telemetry', 502, {
    stdout,
    stderr,
    cause: error instanceof Error ? error.message : String(error)
  });
}

interface ExecError extends NodeJS.ErrnoException {
  stdout?: string;
  stderr?: string;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isExecError(error: unknown): error is ExecError {
  return error instanceof Error;
}
