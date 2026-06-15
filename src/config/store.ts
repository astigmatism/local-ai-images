import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../types.ts';
import { AppError } from '../errors.ts';

export class ConfigStore {
  private readonly filePath: string;
  private readonly fallbackDefaultModel: string;
  private readonly fallbackImageDefaultModel: string;
  private readonly fallbackImagePreloadDefaultOnStartup: boolean;

  constructor(filePath: string, fallbackDefaultModel: string, fallbackImageDefaultModel = '', fallbackImagePreloadDefaultOnStartup = false) {
    this.filePath = filePath;
    this.fallbackDefaultModel = fallbackDefaultModel;
    this.fallbackImageDefaultModel = fallbackImageDefaultModel;
    this.fallbackImagePreloadDefaultOnStartup = fallbackImagePreloadDefaultOnStartup;
  }

  get path(): string {
    return this.filePath;
  }

  async readConfig(): Promise<AppConfig> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      const defaultModel = typeof parsed.default_model === 'string'
        ? parsed.default_model.trim()
        : this.fallbackDefaultModel;
      const config: AppConfig = { default_model: defaultModel };
      if (typeof parsed.image_default_model === 'string') {
        config.image_default_model = parsed.image_default_model.trim();
      } else if (this.fallbackImageDefaultModel.trim()) {
        config.image_default_model = this.fallbackImageDefaultModel.trim();
      }
      if (typeof parsed.image_preload_default_on_startup === 'boolean') {
        config.image_preload_default_on_startup = parsed.image_preload_default_on_startup;
      } else if (this.fallbackImagePreloadDefaultOnStartup) {
        config.image_preload_default_on_startup = true;
      }
      return config;
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        const config: AppConfig = { default_model: this.fallbackDefaultModel };
        if (this.fallbackImageDefaultModel.trim()) {
          config.image_default_model = this.fallbackImageDefaultModel.trim();
        }
        if (this.fallbackImagePreloadDefaultOnStartup) {
          config.image_preload_default_on_startup = true;
        }
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
    if (typeof config.default_model !== 'string') {
      throw new AppError('CONFIG_WRITE_FAILED', 'default_model must be a string', 500);
    }
    if (config.image_default_model !== undefined && typeof config.image_default_model !== 'string') {
      throw new AppError('CONFIG_WRITE_FAILED', 'image_default_model must be a string when provided', 500);
    }
    if (config.image_preload_default_on_startup !== undefined && typeof config.image_preload_default_on_startup !== 'boolean') {
      throw new AppError('CONFIG_WRITE_FAILED', 'image_preload_default_on_startup must be a boolean when provided', 500);
    }

    const normalized: AppConfig = { default_model: config.default_model.trim() };
    if (config.image_default_model !== undefined) {
      normalized.image_default_model = config.image_default_model.trim();
    }
    if (config.image_preload_default_on_startup !== undefined) {
      normalized.image_preload_default_on_startup = config.image_preload_default_on_startup;
    }

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
    const existing = await this.readConfig().catch(() => ({ default_model: this.fallbackDefaultModel }));
    const config: AppConfig = { ...existing, default_model: model.trim() };
    await this.writeConfig(config);
    return config;
  }

  async updateImageDefaultModel(model: string): Promise<AppConfig> {
    const existing = await this.readConfig();
    const config: AppConfig = { ...existing, image_default_model: model.trim() };
    await this.writeConfig(config);
    return config;
  }

  async clearImageDefaultModel(): Promise<AppConfig> {
    const existing = await this.readConfig();
    const config: AppConfig = { ...existing, image_default_model: '' };
    await this.writeConfig(config);
    return config;
  }

  async updateImagePreloadDefaultOnStartup(enabled: boolean): Promise<AppConfig> {
    const existing = await this.readConfig();
    const config: AppConfig = { ...existing, image_preload_default_on_startup: enabled };
    await this.writeConfig(config);
    return config;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
