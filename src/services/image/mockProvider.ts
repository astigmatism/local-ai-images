import { AppError } from '../../errors.ts';
import type { ImageGenerationProvider, ImageProviderHealth, ProviderGenerationRequest, ProviderGenerationResult } from '../../types.ts';

const tinyPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lzLZhwAAAABJRU5ErkJggg==';

export class MockImageProvider implements ImageGenerationProvider {
  readonly name = 'mock';
  private readonly delayMs: number;

  constructor(delayMs: number) {
    this.delayMs = delayMs;
  }

  async health(): Promise<ImageProviderHealth> {
    return {
      ok: true,
      provider: this.name,
      details: {
        mode: 'mock',
        note: 'No GPU image backend is contacted in mock mode.'
      }
    };
  }

  async generate(request: ProviderGenerationRequest): Promise<ProviderGenerationResult> {
    const providerJobId = `mock-${request.jobId}`;
    request.onProviderJobId?.(providerJobId);
    await sleep(this.delayMs, request.signal);
    return {
      provider: this.name,
      providerJobId,
      images: [{
        mimeType: 'image/png',
        buffer: Buffer.from(tinyPngBase64, 'base64'),
        width: 1,
        height: 1,
        providerMetadata: {
          mock: true,
          prompt: request.prompt,
          workflow_id: request.workflow.id
        }
      }],
      metadata: {
        mock: true,
        workflow_id: request.workflow.id,
        seed: request.seed
      }
    };
  }
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError('IMAGE_JOB_CANCELED', 'Image generation was canceled.', 499));
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(new AppError('IMAGE_JOB_CANCELED', 'Image generation was canceled.', 499));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
