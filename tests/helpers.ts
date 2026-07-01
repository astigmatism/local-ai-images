import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequestHandler } from '../src/app.ts';
import { ConfigStore } from '../src/config/store.ts';
import { createLogger } from '../src/logger.ts';
import type {
  GeneratedImageData,
  GpuServiceLike,
  GpuTelemetry,
  OllamaClientLike,
  OllamaImageGenerateRequest,
  OllamaInstalledModel,
  OllamaModelInformation,
  OllamaRunningModel,
  RuntimeConfig
} from '../src/types.ts';
import type { ImageRuntime } from '../src/services/image/runtime.ts';

const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lzLZhwAAAABJRU5ErkJggg==';

export function testRuntimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    legacyOllamaEnabled: false,
    ollamaBaseUrl: '',
    ollamaRequestTimeoutMs: 1000,
    configPath: '/tmp/local-ai-images-test.json',
    defaultModel: '',
    prewarmDefaultModelOnStart: false,
    prewarmTimeoutMs: 1000,
    prewarmKeepAlive: -1,
    gpuQueryTimeoutMs: 1000,
    imageGenerationEnabled: false,
    imageGenerationTimeoutMs: 1000,
    imageGenerationMaxPromptChars: 4000,
    imageBackend: 'mock',
    imageApiKeys: [],
    requireImageApiAuth: false,
    comfyUiBaseUrl: 'http://127.0.0.1:8188',
    comfyUiRequestTimeoutMs: 1000,
    comfyUiPollIntervalMs: 10,
    imageModelPaths: ['/tmp/local-ai-images-models'],
    imageWorkflowPath: '/tmp/local-ai-images-workflows',
    imageArtifactPath: '/tmp/local-ai-images-artifacts',
    imageArtifactPublicBaseUrl: '/api/v1/artifacts',
    favoriteImagePromptsPath: '/tmp/local-ai-images-favorite-prompts.json',
    imageFavoritesPath: '/tmp/local-ai-images-favorites.json',
    imageDefaultModel: '',
    imageDefaultWorkflowId: 'sdxl-text-to-image',
    imagePreloadDefaultOnStartup: false,
    imagePreloadTimeoutMs: 1000,
    imagePreloadWorkflowId: 'sdxl-text-to-image',
    imagePreloadWidth: 512,
    imagePreloadHeight: 512,
    imagePreloadSteps: 1,
    imagePreloadKeepArtifact: false,
    imageQueueConcurrency: 1,
    imageMaxQueuedJobs: 8,
    imageDefaultSyncTimeoutMs: 0,
    imageMaxSyncTimeoutMs: 1000,
    imageMockDelayMs: 1,
    modelInstallsEnabled: false,
    modelInstallMaxBytes: 1024 * 1024 * 1024,
    modelInstallAllowCkpt: false,
    modelCatalogPath: '/tmp/local-ai-images-model-catalog.json',
    modelDownloadMetadataPath: '/tmp/local-ai-images-model-downloads.json',
    modelInstallDirectories: {
      checkpoint: '/tmp/local-ai-images-models/checkpoints',
      lora: '/tmp/local-ai-images-models/loras',
      vae: '/tmp/local-ai-images-models/vae',
      controlnet: '/tmp/local-ai-images-models/controlnet',
      upscaler: '/tmp/local-ai-images-models/upscale_models',
      other: '/tmp/local-ai-images-models'
    },
    llmImagePromptEnabled: false,
    llmImagePromptEndpointUrl: '',
    llmImagePromptHealthUrl: '',
    llmImagePromptRequestTimeoutMs: 1000,
    llmImagePromptRequestFormat: 'openai_chat',
    llmImagePromptInstruction: 'Return only a positive image prompt.',
    llmImagePromptTemperature: null,
    llmImagePromptMaxTokens: null,
    logLevel: 'silent',
    ...overrides
  };
}

export async function tempConfigStore(defaultModel = ''): Promise<ConfigStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-images-'));
  return new ConfigStore(path.join(directory, 'config.json'), defaultModel);
}

export function mockOllama(
  runningModels: OllamaRunningModel[] = [],
  installedModels: OllamaInstalledModel[] = [],
  generatedImage: GeneratedImageData = { mimeType: 'image/png', base64: tinyPngBase64, width: 1, height: 1 },
  onGenerateImage?: (request: OllamaImageGenerateRequest) => void,
  modelInfo: OllamaModelInformation = { capabilities: ['completion'] }
): OllamaClientLike {
  return {
    async getVersion() {
      return '0.99.0-test';
    },
    async listRunningModels() {
      return runningModels;
    },
    async listInstalledModels() {
      return installedModels;
    },
    async showModel() {
      return modelInfo;
    },
    async prewarmModel(model: string, keepAlive: string | number) {
      return { model, response: { done: true, done_reason: 'load', keep_alive: keepAlive } };
    },
    async generateImage(request: OllamaImageGenerateRequest) {
      onGenerateImage?.(request);
      return {
        model: request.model,
        images: [generatedImage],
        metadata: { done: true, done_reason: 'stop' }
      };
    }
  };
}


export function throwingOllama(message = 'Ollama should not be called in image-only mode'): OllamaClientLike {
  const fail = async () => {
    throw new Error(message);
  };
  return {
    getVersion: fail,
    listRunningModels: fail,
    listInstalledModels: fail,
    showModel: fail,
    prewarmModel: fail,
    generateImage: fail
  };
}

export function mockGpuService(gpus: GpuTelemetry[] = []): GpuServiceLike {
  return {
    async queryGpus() {
      return gpus;
    }
  };
}

export async function withTestServer(dependencies: {
  runtimeConfig?: RuntimeConfig;
  configStore?: ConfigStore;
  ollamaClient?: OllamaClientLike;
  gpuService?: GpuServiceLike;
  imageRuntime?: ImageRuntime;
}, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const runtimeConfig = dependencies.runtimeConfig ?? testRuntimeConfig();
  const configStore = await (dependencies.configStore ?? new ConfigStore(
    path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'local-ai-images-')), 'config.json'),
    runtimeConfig.defaultModel,
    runtimeConfig.imageDefaultModel,
    runtimeConfig.imagePreloadDefaultOnStartup
  ));
  const ollamaClient = dependencies.ollamaClient ?? mockOllama();
  const gpuService = dependencies.gpuService ?? mockGpuService();
  const logger = createLogger('silent');
  const server = createServer(createRequestHandler({ runtimeConfig, configStore, ollamaClient, gpuService, logger, imageRuntime: dependencies.imageRuntime }));

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await fn(baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

export const sampleGpu0: GpuTelemetry = {
  index: 0,
  uuid: 'GPU-3090',
  name: 'NVIDIA GeForce RTX 3090',
  driver_version: '595.71.05',
  memory_total_mib: 24576,
  memory_used_mib: 14168,
  memory_free_mib: 9958,
  utilization_gpu_percent: 0,
  temperature_c: 45,
  power_draw_w: 22.89,
  power_limit_w: 420
};

export const sampleGpu1: GpuTelemetry = {
  index: 1,
  uuid: 'GPU-4080',
  name: 'NVIDIA GeForce RTX 4080',
  driver_version: '595.71.05',
  memory_total_mib: 16384,
  memory_used_mib: 0,
  memory_free_mib: 16384,
  utilization_gpu_percent: 0,
  temperature_c: 40,
  power_draw_w: 20,
  power_limit_w: 320
};
