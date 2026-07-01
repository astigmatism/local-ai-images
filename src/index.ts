import { createServer } from 'node:http';
import { createRequestHandler } from './app.ts';
import { loadRuntimeConfig } from './config/env.ts';
import { ConfigStore } from './config/store.ts';
import { AppError } from './errors.ts';
import { createLogger } from './logger.ts';
import { NvidiaSmiGpuService } from './services/gpuService.ts';
import { createImageRuntime } from './services/image/runtime.ts';
import { OllamaClient } from './services/ollamaClient.ts';
import { imagePromptLlmSettingsFromRuntime } from './services/llmPromptBuilder.ts';
import type { OllamaClientLike } from './types.ts';

const runtimeConfig = loadRuntimeConfig();
const logger = createLogger(runtimeConfig.logLevel);
const configStore = new ConfigStore(
  runtimeConfig.configPath,
  runtimeConfig.defaultModel,
  runtimeConfig.imageDefaultModel,
  runtimeConfig.imagePreloadDefaultOnStartup,
  imagePromptLlmSettingsFromRuntime(runtimeConfig)
);
const ollamaClient: OllamaClientLike = runtimeConfig.legacyOllamaEnabled
  ? new OllamaClient(runtimeConfig.ollamaBaseUrl, runtimeConfig.ollamaRequestTimeoutMs)
  : createDisabledOllamaClient();
const gpuService = new NvidiaSmiGpuService(runtimeConfig.gpuQueryTimeoutMs);
const imageRuntime = createImageRuntime(runtimeConfig, logger, configStore);
const server = createServer(createRequestHandler({ runtimeConfig, configStore, ollamaClient, gpuService, logger, imageRuntime }));

async function main(): Promise<void> {
  await new Promise<void>((resolve) => {
    server.listen(runtimeConfig.port, runtimeConfig.host, () => resolve());
  });

  logger.info({ host: runtimeConfig.host, port: runtimeConfig.port, backend: runtimeConfig.imageBackend }, 'Local AI Images listening');

  if (runtimeConfig.legacyOllamaEnabled) {
    logger.info({ base_url: runtimeConfig.ollamaBaseUrl }, 'Legacy Ollama compatibility mode enabled');
    await maybePrewarmLegacyDefaultModel();
  }

  imageRuntime.generationSources.startStartupProbe();
  void imageRuntime.modelLifecycle.startStartupPreload();
}

async function maybePrewarmLegacyDefaultModel(): Promise<void> {
  if (!runtimeConfig.prewarmDefaultModelOnStart) {
    return;
  }

  const config = await configStore.readConfig();
  const model = config.default_model.trim();
  if (!model) {
    logger.warn('Legacy Ollama startup pre-warm skipped because no DEFAULT_MODEL/default_model is configured');
    return;
  }

  void ollamaClient.prewarmModel(model, runtimeConfig.prewarmKeepAlive, runtimeConfig.prewarmTimeoutMs)
    .then(() => logger.info({ model }, 'Legacy Ollama default model pre-warmed on startup'))
    .catch((error: unknown) => logger.warn({ err: error, model }, 'Legacy Ollama default model startup pre-warm failed'));
}

function createDisabledOllamaClient(): OllamaClientLike {
  const reject = async (): Promise<never> => {
    throw new AppError(
      'LEGACY_OLLAMA_DISABLED',
      'Legacy Ollama compatibility is disabled. Set LEGACY_OLLAMA_ENABLED=true to enable retained Ollama routes.',
      410
    );
  };

  return {
    getVersion: reject,
    listRunningModels: reject,
    listInstalledModels: reject,
    showModel: reject,
    prewarmModel: reject,
    generateImage: reject
  };
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Application startup failed');
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'Shutting down');
    server.close((error) => {
      if (error) {
        logger.error({ err: error }, 'Shutdown failed');
        process.exit(1);
      }
      process.exit(0);
    });
  });
}
