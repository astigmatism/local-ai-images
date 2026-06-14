import { createServer } from 'node:http';
import { createRequestHandler } from './app.ts';
import { loadRuntimeConfig } from './config/env.ts';
import { ConfigStore } from './config/store.ts';
import { createLogger } from './logger.ts';
import { NvidiaSmiGpuService } from './services/gpuService.ts';
import { OllamaClient } from './services/ollamaClient.ts';

const runtimeConfig = loadRuntimeConfig();
const logger = createLogger(runtimeConfig.logLevel);
const configStore = new ConfigStore(runtimeConfig.configPath, runtimeConfig.defaultModel);
const ollamaClient = new OllamaClient(runtimeConfig.ollamaBaseUrl, runtimeConfig.ollamaRequestTimeoutMs);
const gpuService = new NvidiaSmiGpuService(runtimeConfig.gpuQueryTimeoutMs);
const server = createServer(createRequestHandler({ runtimeConfig, configStore, ollamaClient, gpuService, logger }));

async function main(): Promise<void> {
  const config = await configStore.readConfig();

  await new Promise<void>((resolve) => {
    server.listen(runtimeConfig.port, runtimeConfig.host, () => resolve());
  });

  logger.info({ host: runtimeConfig.host, port: runtimeConfig.port }, 'Local AI LLM Monitor listening');

  if (runtimeConfig.prewarmDefaultModelOnStart) {
    void ollamaClient.prewarmModel(config.default_model, runtimeConfig.prewarmKeepAlive, runtimeConfig.prewarmTimeoutMs)
      .then(() => logger.info({ model: config.default_model }, 'Default model pre-warmed on startup'))
      .catch((error: unknown) => logger.warn({ err: error, model: config.default_model }, 'Default model startup pre-warm failed'));
  }
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
