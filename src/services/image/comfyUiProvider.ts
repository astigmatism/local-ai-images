import crypto from 'node:crypto';
import { AppError } from '../../errors.ts';
import type {
  ImageArtifactData,
  ImageGenerationProvider,
  ImageProviderHealth,
  ProviderCancellationResult,
  ProviderGenerationRequest,
  ProviderGenerationResult,
  WorkflowPreset
} from '../../types.ts';

interface ComfyUiImageReference {
  filename: string;
  subfolder?: string;
  type?: string;
}

export class ComfyUiProvider implements ImageGenerationProvider {
  readonly name = 'comfyui';
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(baseUrl: string, requestTimeoutMs: number, pollIntervalMs: number) {
    this.baseUrl = baseUrl.replace(/\/+$/u, '');
    this.requestTimeoutMs = requestTimeoutMs;
    this.pollIntervalMs = pollIntervalMs;
  }

  async health(): Promise<ImageProviderHealth> {
    try {
      const [systemStats, queue] = await Promise.allSettled([
        this.fetchJson('/system_stats', { method: 'GET' }, 5000),
        this.fetchJson('/queue', { method: 'GET' }, 5000)
      ]);

      if (systemStats.status === 'rejected' && queue.status === 'rejected') {
        throw systemStats.reason;
      }

      return {
        ok: true,
        provider: this.name,
        baseUrl: this.baseUrl,
        details: systemStats.status === 'fulfilled' ? systemStats.value : null,
        queue: queue.status === 'fulfilled' && isRecord(queue.value) ? queue.value : undefined
      };
    } catch (error: unknown) {
      return {
        ok: false,
        provider: this.name,
        baseUrl: this.baseUrl,
        error: {
          code: error instanceof AppError ? error.code : 'COMFYUI_UNAVAILABLE',
          message: error instanceof Error ? error.message : 'Unable to contact ComfyUI'
        }
      };
    }
  }

  async generate(request: ProviderGenerationRequest): Promise<ProviderGenerationResult> {
    const clientId = `local-ai-images-${crypto.randomUUID()}`;
    const prompt = materializeComfyPrompt(request.workflow, request);

    const submitResponse = await this.fetchJson('/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, prompt })
    }, this.requestTimeoutMs, request.signal);

    const providerJobId = readPromptId(submitResponse);
    if (!providerJobId) {
      throw new AppError('COMFYUI_SUBMIT_INVALID_RESPONSE', 'ComfyUI did not return a prompt_id for the submitted workflow.', 502, submitResponse);
    }
    request.onProviderJobId?.(providerJobId);

    const history = await this.waitForHistory(providerJobId, request.signal);
    const imageReferences = extractImageReferences(history, providerJobId);
    if (imageReferences.length === 0) {
      throw new AppError('COMFYUI_IMAGE_NOT_RETURNED', 'ComfyUI completed the prompt without image references in history output.', 502, {
        prompt_id: providerJobId,
        history
      });
    }

    const images: ImageArtifactData[] = [];
    for (const reference of imageReferences) {
      const downloaded = await this.downloadImage(reference, request.signal);
      images.push({
        mimeType: downloaded.mimeType,
        buffer: downloaded.buffer,
        providerMetadata: reference
      });
    }

    return {
      provider: this.name,
      providerJobId,
      images,
      metadata: {
        prompt_id: providerJobId,
        client_id: clientId,
        workflow_id: request.workflow.id,
        image_count: images.length
      }
    };
  }

  async cancel(providerJobId?: string): Promise<ProviderCancellationResult> {
    const promptId = providerJobId?.trim();
    if (!promptId) {
      return {
        requested: false,
        reason: 'No ComfyUI prompt_id was available for targeted cancellation.'
      };
    }

    const queue = await this.fetchJson('/queue', { method: 'GET' }, 5000);
    const isPending = queueContainsPromptId(queue, 'queue_pending', promptId);
    const isRunning = queueContainsPromptId(queue, 'queue_running', promptId);

    if (isPending) {
      await this.fetchJson('/queue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delete: [promptId] })
      }, 5000);
      return {
        requested: true,
        queueDeleteRequested: true,
        reason: `Requested deletion of queued ComfyUI prompt ${promptId}.`
      };
    }

    if (isRunning) {
      await this.fetchJson('/interrupt', { method: 'POST' }, 5000);
      return {
        requested: true,
        interruptRequested: true,
        reason: `Requested interruption of running ComfyUI prompt ${promptId}.`
      };
    }

    return {
      requested: false,
      reason: `ComfyUI prompt ${promptId} was not found in the pending or running queue.`
    };
  }

  private async waitForHistory(promptId: string, signal?: AbortSignal): Promise<unknown> {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= this.requestTimeoutMs) {
      if (signal?.aborted) {
        throw new AppError('IMAGE_JOB_CANCELED', 'Image generation was canceled.', 499);
      }

      const history = await this.fetchJson(`/history/${encodeURIComponent(promptId)}`, { method: 'GET' }, 15000, signal);
      if (historyContainsPrompt(history, promptId)) {
        return history;
      }

      await sleep(this.pollIntervalMs, signal);
    }

    throw new AppError('COMFYUI_GENERATION_TIMEOUT', `Timed out waiting for ComfyUI prompt ${promptId}.`, 504, {
      prompt_id: promptId,
      timeout_ms: this.requestTimeoutMs
    });
  }

  private async downloadImage(reference: ComfyUiImageReference, signal?: AbortSignal): Promise<{ mimeType: string; buffer: Buffer }> {
    const params = new URLSearchParams();
    params.set('filename', reference.filename);
    params.set('subfolder', reference.subfolder ?? '');
    params.set('type', reference.type ?? 'output');

    const response = await this.fetchRaw(`/view?${params.toString()}`, { method: 'GET' }, 60000, signal);
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || mimeTypeFromFileName(reference.filename);
    const buffer = Buffer.from(await response.arrayBuffer());
    return { mimeType: contentType, buffer };
  }

  private async fetchJson(path: string, init: RequestInit, timeoutMs: number, externalSignal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchRaw(path, init, timeoutMs, externalSignal);
    const text = await response.text();
    if (!text.trim()) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private async fetchRaw(path: string, init: RequestInit, timeoutMs: number, externalSignal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abortFromExternalSignal = () => controller.abort(externalSignal?.reason);

    if (externalSignal?.aborted) {
      abortFromExternalSignal();
    } else {
      externalSignal?.addEventListener('abort', abortFromExternalSignal, { once: true });
    }

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new AppError('COMFYUI_REQUEST_FAILED', `ComfyUI ${path} returned HTTP ${response.status}.`, response.status >= 500 ? 502 : response.status, {
          status: response.status,
          body: text.slice(0, 2000)
        });
      }

      return response;
    } catch (error: unknown) {
      if (isAbortError(error)) {
        if (!timedOut && externalSignal?.aborted) {
          throw new AppError('IMAGE_JOB_CANCELED', 'Image generation was canceled.', 499);
        }
        throw new AppError('COMFYUI_TIMEOUT', `Timed out talking to ComfyUI after ${timeoutMs}ms.`, 504, {
          base_url: this.baseUrl,
          path
        });
      }

      if (error instanceof AppError) throw error;
      throw new AppError('COMFYUI_UNAVAILABLE', 'Unable to connect to ComfyUI.', 503, {
        base_url: this.baseUrl,
        path,
        cause: error instanceof Error ? error.message : String(error)
      });
    } finally {
      externalSignal?.removeEventListener('abort', abortFromExternalSignal);
      clearTimeout(timeout);
    }
  }
}

export function materializeComfyPrompt(workflow: WorkflowPreset, request: ProviderGenerationRequest): Record<string, unknown> {
  const prompt = deepCloneRecord(workflow.comfyui.prompt);
  const mappings = workflow.comfyui.mappings;

  setInput(prompt, mappings.positivePromptNode ?? findNodeId(prompt, 'CLIPTextEncode', 0), 'text', request.prompt);
  setInput(prompt, mappings.negativePromptNode ?? findNodeId(prompt, 'CLIPTextEncode', 1), 'text', request.negativePrompt);

  const checkpointNode = mappings.checkpointNode ?? findNodeId(prompt, 'CheckpointLoaderSimple', 0);
  if (checkpointNode && request.model) {
    setInput(prompt, checkpointNode, 'ckpt_name', request.model);
  }

  const latentImageNode = mappings.latentImageNode ?? findNodeId(prompt, 'EmptyLatentImage', 0);
  if (latentImageNode) {
    setInput(prompt, latentImageNode, 'width', request.width);
    setInput(prompt, latentImageNode, 'height', request.height);
  }

  const samplerNode = mappings.samplerNode ?? findNodeId(prompt, 'KSampler', 0);
  if (samplerNode) {
    setInput(prompt, samplerNode, 'seed', request.seed);
    setInput(prompt, samplerNode, 'steps', request.steps);
    setInput(prompt, samplerNode, 'cfg', request.cfgScale);
    setInput(prompt, samplerNode, 'sampler_name', request.samplerName);
    setInput(prompt, samplerNode, 'scheduler', request.scheduler);
  }

  const saveImageNode = mappings.saveImageNode ?? findNodeId(prompt, 'SaveImage', 0);
  if (saveImageNode) {
    setInput(prompt, saveImageNode, 'filename_prefix', request.filenamePrefix);
  }

  return prompt;
}

function setInput(prompt: Record<string, unknown>, nodeId: string | undefined, key: string, value: unknown): void {
  if (!nodeId) return;
  const node = prompt[nodeId];
  if (!isRecord(node)) return;
  if (!isRecord(node.inputs)) node.inputs = {};
  node.inputs[key] = value;
}

function findNodeId(prompt: Record<string, unknown>, classType: string, occurrence: number): string | undefined {
  let seen = 0;
  for (const [nodeId, node] of Object.entries(prompt)) {
    if (!isRecord(node) || node.class_type !== classType) continue;
    if (seen === occurrence) return nodeId;
    seen += 1;
  }
  return undefined;
}

function readPromptId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const promptId = value.prompt_id;
  return typeof promptId === 'string' && promptId.trim() ? promptId.trim() : null;
}

function historyContainsPrompt(history: unknown, promptId: string): boolean {
  if (!isRecord(history)) return false;
  const root = isRecord(history[promptId]) ? history[promptId] : history;
  if (!isRecord(root)) return false;
  if (isRecord(root.outputs)) return true;
  if (isRecord(root.status) && root.status.completed === true) return true;
  return false;
}

function extractImageReferences(history: unknown, promptId: string): ComfyUiImageReference[] {
  if (!isRecord(history)) return [];
  const root = isRecord(history[promptId]) ? history[promptId] : history;
  if (!isRecord(root) || !isRecord(root.outputs)) return [];

  const references: ComfyUiImageReference[] = [];
  for (const output of Object.values(root.outputs)) {
    if (!isRecord(output) || !Array.isArray(output.images)) continue;
    for (const image of output.images) {
      if (!isRecord(image) || typeof image.filename !== 'string') continue;
      references.push({
        filename: image.filename,
        ...(typeof image.subfolder === 'string' ? { subfolder: image.subfolder } : {}),
        ...(typeof image.type === 'string' ? { type: image.type } : {})
      });
    }
  }
  return references;
}

function queueContainsPromptId(queue: unknown, sectionName: 'queue_pending' | 'queue_running', promptId: string): boolean {
  if (!isRecord(queue)) return false;
  return containsPromptId(queue[sectionName], promptId);
}

function containsPromptId(value: unknown, promptId: string): boolean {
  if (typeof value === 'string') return value === promptId;
  if (Array.isArray(value)) return value.some((item) => containsPromptId(item, promptId));
  if (isRecord(value)) return Object.values(value).some((item) => containsPromptId(item, promptId));
  return false;
}

function mimeTypeFromFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
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

function deepCloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
