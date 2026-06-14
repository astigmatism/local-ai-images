import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../types.ts';
import { AppError } from '../errors.ts';

export class ConfigStore {
  private readonly filePath: string;
  private readonly fallbackDefaultModel: string;

  constructor(filePath: string, fallbackDefaultModel: string) {
    this.filePath = filePath;
    this.fallbackDefaultModel = fallbackDefaultModel;
  }

  get path(): string {
    return this.filePath;
  }

  async readConfig(): Promise<AppConfig> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      const defaultModel = typeof parsed.default_model === 'string' && parsed.default_model.trim() !== ''
        ? parsed.default_model.trim()
        : this.fallbackDefaultModel;
      return { default_model: defaultModel };
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        const config = { default_model: this.fallbackDefaultModel };
        await this.writeConfig(config);
        return config;
      }
      if (error instanceof SyntaxError) {
        throw new AppError('CONFIG_READ_FAILED', `Config file is not valid JSON: ${this.filePath}`, 500, {
          path: this.filePath
        });
      }
      throw new AppError('CONFIG_READ_FAILED', `Unable to read config file: ${this.filePath}`, 500, {
        path: this.filePath,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async writeConfig(config: AppConfig): Promise<void> {
    if (typeof config.default_model !== 'string' || config.default_model.trim() === '') {
      throw new AppError('CONFIG_WRITE_FAILED', 'default_model must be a non-empty string', 500);
    }

    const normalized: AppConfig = { default_model: config.default_model.trim() };
    const directory = path.dirname(this.filePath);
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;

    try {
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
      await fs.rename(tempPath, this.filePath);
    } catch (error: unknown) {
      try {
        await fs.rm(tempPath, { force: true });
      } catch {
        // Best-effort cleanup only.
      }
      throw new AppError('CONFIG_WRITE_FAILED', `Unable to write config file: ${this.filePath}`, 500, {
        path: this.filePath,
        cause: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async updateDefaultModel(model: string): Promise<AppConfig> {
    const config = { default_model: model.trim() };
    await this.writeConfig(config);
    return config;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
