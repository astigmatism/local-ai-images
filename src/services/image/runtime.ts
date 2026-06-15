import type { ConfigStore } from '../../config/store.ts';
import type { Logger } from '../../logger.ts';
import type { ImageGenerationProvider, RuntimeConfig } from '../../types.ts';
import { ArtifactStore } from './artifactStore.ts';
import { ComfyUiProvider } from './comfyUiProvider.ts';
import { ImageJobQueue } from './jobQueue.ts';
import { MockImageProvider } from './mockProvider.ts';
import { ModelCatalog } from './modelCatalog.ts';
import { ModelInstaller } from './modelInstaller.ts';
import { ModelLifecycleManager } from './modelLifecycle.ts';
import { ModelScanner } from './modelScanner.ts';
import { WorkflowStore } from './workflowStore.ts';

export interface ImageRuntime {
  provider: ImageGenerationProvider;
  modelScanner: ModelScanner;
  workflowStore: WorkflowStore;
  artifactStore: ArtifactStore;
  jobQueue: ImageJobQueue;
  modelCatalog: ModelCatalog;
  modelLifecycle: ModelLifecycleManager;
  modelInstaller?: ModelInstaller;
}

export function createImageRuntime(runtimeConfig: RuntimeConfig, logger: Logger, configStore: ConfigStore): ImageRuntime {
  const provider = runtimeConfig.imageBackend === 'mock'
    ? new MockImageProvider(runtimeConfig.imageMockDelayMs)
    : new ComfyUiProvider(runtimeConfig.comfyUiBaseUrl, runtimeConfig.comfyUiRequestTimeoutMs, runtimeConfig.comfyUiPollIntervalMs);

  const artifactStore = new ArtifactStore(runtimeConfig.imageArtifactPath, runtimeConfig.imageArtifactPublicBaseUrl);
  const modelScanner = new ModelScanner(runtimeConfig.imageModelPaths);
  const workflowStore = new WorkflowStore(runtimeConfig.imageWorkflowPath, runtimeConfig.imageDefaultWorkflowId);
  const modelLifecycle = new ModelLifecycleManager({
    runtimeConfig,
    configStore,
    provider,
    modelScanner,
    workflowStore,
    artifactStore,
    logger
  });
  const runtime: ImageRuntime = {
    provider,
    modelScanner,
    workflowStore,
    artifactStore,
    jobQueue: new ImageJobQueue({
      provider,
      artifactStore,
      concurrency: runtimeConfig.imageQueueConcurrency,
      maxQueuedJobs: runtimeConfig.imageMaxQueuedJobs,
      logger,
      onJobCompleted: (job) => {
        if (job.status === 'succeeded') {
          modelLifecycle.recordConfirmedLoaded(job.model, 'generation');
        }
      }
    }),
    modelCatalog: new ModelCatalog(runtimeConfig.modelCatalogPath),
    modelLifecycle
  };

  runtime.modelInstaller = new ModelInstaller({ runtimeConfig, modelScanner, configStore, logger });

  return runtime;
}
