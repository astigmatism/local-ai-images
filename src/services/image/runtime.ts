import type { Logger } from '../../logger.ts';
import type { ImageGenerationProvider, RuntimeConfig } from '../../types.ts';
import { ArtifactStore } from './artifactStore.ts';
import { ComfyUiProvider } from './comfyUiProvider.ts';
import { ImageJobQueue } from './jobQueue.ts';
import { MockImageProvider } from './mockProvider.ts';
import { ModelScanner } from './modelScanner.ts';
import { WorkflowStore } from './workflowStore.ts';

export interface ImageRuntime {
  provider: ImageGenerationProvider;
  modelScanner: ModelScanner;
  workflowStore: WorkflowStore;
  artifactStore: ArtifactStore;
  jobQueue: ImageJobQueue;
}

export function createImageRuntime(runtimeConfig: RuntimeConfig, logger: Logger): ImageRuntime {
  const provider = runtimeConfig.imageBackend === 'mock'
    ? new MockImageProvider(runtimeConfig.imageMockDelayMs)
    : new ComfyUiProvider(runtimeConfig.comfyUiBaseUrl, runtimeConfig.comfyUiRequestTimeoutMs, runtimeConfig.comfyUiPollIntervalMs);

  const artifactStore = new ArtifactStore(runtimeConfig.imageArtifactPath, runtimeConfig.imageArtifactPublicBaseUrl);

  return {
    provider,
    modelScanner: new ModelScanner(runtimeConfig.imageModelPaths),
    workflowStore: new WorkflowStore(runtimeConfig.imageWorkflowPath, runtimeConfig.imageDefaultWorkflowId),
    artifactStore,
    jobQueue: new ImageJobQueue({
      provider,
      artifactStore,
      concurrency: runtimeConfig.imageQueueConcurrency,
      maxQueuedJobs: runtimeConfig.imageMaxQueuedJobs,
      logger
    })
  };
}
