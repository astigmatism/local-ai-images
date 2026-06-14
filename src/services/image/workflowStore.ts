import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../errors.ts';
import type { WorkflowPreset } from '../../types.ts';

export class WorkflowStore {
  private readonly workflowPath: string;
  private readonly defaultWorkflowId: string;
  private cache: WorkflowPreset[] | null = null;

  constructor(workflowPath: string, defaultWorkflowId: string) {
    this.workflowPath = workflowPath;
    this.defaultWorkflowId = defaultWorkflowId;
  }

  async list(): Promise<WorkflowPreset[]> {
    return this.cache ?? this.refresh();
  }

  async refresh(): Promise<WorkflowPreset[]> {
    const workflows = new Map<string, WorkflowPreset>();
    for (const preset of builtinWorkflows()) {
      workflows.set(preset.id, preset);
    }

    let entries;
    try {
      entries = await fs.readdir(this.workflowPath, { withFileTypes: true });
    } catch {
      this.cache = orderWorkflows([...workflows.values()], this.defaultWorkflowId);
      return this.cache;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const filePath = path.join(this.workflowPath, entry.name);
      try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
        const preset = normalizeWorkflowPreset(parsed, filePath);
        workflows.set(preset.id, preset);
      } catch (error: unknown) {
        throw new AppError('WORKFLOW_PRESET_INVALID', `Unable to load workflow preset ${filePath}`, 500, {
          cause: error instanceof Error ? error.message : String(error)
        });
      }
    }

    this.cache = orderWorkflows([...workflows.values()], this.defaultWorkflowId);
    return this.cache;
  }

  async get(workflowId: string): Promise<WorkflowPreset> {
    const workflows = await this.list();
    const workflow = workflows.find((item) => item.id === workflowId);
    if (!workflow) {
      throw new AppError('WORKFLOW_NOT_FOUND', `Workflow preset ${workflowId} was not found.`, 404);
    }
    return workflow;
  }
}

export function builtinWorkflows(): WorkflowPreset[] {
  return [{
    id: 'sdxl-text-to-image',
    name: 'SDXL text to image',
    description: 'Default ComfyUI API workflow for a single checkpoint, text prompts, KSampler, VAE decode, and image save.',
    engine: 'comfyui',
    defaults: {
      width: 1024,
      height: 1024,
      steps: 28,
      cfgScale: 7,
      seed: -1,
      samplerName: 'euler',
      scheduler: 'normal',
      checkpoint: 'sd_xl_base_1.0.safetensors'
    },
    parameters: ['prompt', 'negative_prompt', 'model', 'width', 'height', 'steps', 'cfg_scale', 'seed', 'sampler_name', 'scheduler'],
    source: 'builtin',
    comfyui: {
      mappings: {
        checkpointNode: '4',
        latentImageNode: '5',
        positivePromptNode: '6',
        negativePromptNode: '7',
        samplerNode: '3',
        saveImageNode: '9'
      },
      prompt: {
        '3': {
          class_type: 'KSampler',
          inputs: {
            seed: 1,
            steps: 28,
            cfg: 7,
            sampler_name: 'euler',
            scheduler: 'normal',
            denoise: 1,
            model: ['4', 0],
            positive: ['6', 0],
            negative: ['7', 0],
            latent_image: ['5', 0]
          }
        },
        '4': {
          class_type: 'CheckpointLoaderSimple',
          inputs: {
            ckpt_name: 'sd_xl_base_1.0.safetensors'
          }
        },
        '5': {
          class_type: 'EmptyLatentImage',
          inputs: {
            width: 1024,
            height: 1024,
            batch_size: 1
          }
        },
        '6': {
          class_type: 'CLIPTextEncode',
          inputs: {
            text: '',
            clip: ['4', 1]
          }
        },
        '7': {
          class_type: 'CLIPTextEncode',
          inputs: {
            text: '',
            clip: ['4', 1]
          }
        },
        '8': {
          class_type: 'VAEDecode',
          inputs: {
            samples: ['3', 0],
            vae: ['4', 2]
          }
        },
        '9': {
          class_type: 'SaveImage',
          inputs: {
            filename_prefix: 'local-ai-image',
            images: ['8', 0]
          }
        }
      }
    }
  }];
}

function orderWorkflows(workflows: WorkflowPreset[], defaultWorkflowId: string): WorkflowPreset[] {
  return workflows.sort((left, right) => {
    if (left.id === defaultWorkflowId && right.id !== defaultWorkflowId) return -1;
    if (right.id === defaultWorkflowId && left.id !== defaultWorkflowId) return 1;
    return left.name.localeCompare(right.name);
  });
}

function normalizeWorkflowPreset(value: unknown, filePath: string): WorkflowPreset {
  if (!isRecord(value)) {
    throw new Error('workflow preset must be an object');
  }

  const id = readRequiredString(value, 'id');
  const name = readOptionalString(value, 'name', id);
  const description = readOptionalString(value, 'description', 'Operator-supplied workflow preset.');
  const engine = readOptionalString(value, 'engine', 'comfyui');
  if (engine !== 'comfyui') {
    throw new Error('only ComfyUI workflow presets are supported by this adapter');
  }

  const comfyui = value.comfyui;
  if (!isRecord(comfyui) || !isRecord(comfyui.prompt)) {
    throw new Error('workflow preset requires comfyui.prompt');
  }

  const mappings = isRecord(comfyui.mappings) ? normalizeMappings(comfyui.mappings) : {};
  const defaults = isRecord(value.defaults) ? normalizeDefaults(value.defaults) : {};
  const parameters = Array.isArray(value.parameters)
    ? value.parameters.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
    : ['prompt'];

  return {
    id,
    name,
    description,
    engine: 'comfyui',
    defaults,
    parameters,
    source: 'file',
    filePath,
    comfyui: {
      prompt: deepCloneRecord(comfyui.prompt),
      mappings
    }
  };
}

function normalizeDefaults(value: Record<string, unknown>): WorkflowPreset['defaults'] {
  return {
    ...(readOptionalNumber(value, 'width') !== undefined ? { width: readOptionalNumber(value, 'width') } : {}),
    ...(readOptionalNumber(value, 'height') !== undefined ? { height: readOptionalNumber(value, 'height') } : {}),
    ...(readOptionalNumber(value, 'steps') !== undefined ? { steps: readOptionalNumber(value, 'steps') } : {}),
    ...(readOptionalNumber(value, 'cfgScale') !== undefined ? { cfgScale: readOptionalNumber(value, 'cfgScale') } : {}),
    ...(readOptionalNumber(value, 'cfg_scale') !== undefined ? { cfgScale: readOptionalNumber(value, 'cfg_scale') } : {}),
    ...(readOptionalNumber(value, 'seed') !== undefined ? { seed: readOptionalNumber(value, 'seed') } : {}),
    ...(readOptionalString(value, 'samplerName') ? { samplerName: readOptionalString(value, 'samplerName') } : {}),
    ...(readOptionalString(value, 'sampler_name') ? { samplerName: readOptionalString(value, 'sampler_name') } : {}),
    ...(readOptionalString(value, 'scheduler') ? { scheduler: readOptionalString(value, 'scheduler') } : {}),
    ...(readOptionalString(value, 'checkpoint') ? { checkpoint: readOptionalString(value, 'checkpoint') } : {})
  };
}

function normalizeMappings(value: Record<string, unknown>): WorkflowPreset['comfyui']['mappings'] {
  return {
    ...(readOptionalString(value, 'positivePromptNode') ? { positivePromptNode: readOptionalString(value, 'positivePromptNode') } : {}),
    ...(readOptionalString(value, 'negativePromptNode') ? { negativePromptNode: readOptionalString(value, 'negativePromptNode') } : {}),
    ...(readOptionalString(value, 'checkpointNode') ? { checkpointNode: readOptionalString(value, 'checkpointNode') } : {}),
    ...(readOptionalString(value, 'latentImageNode') ? { latentImageNode: readOptionalString(value, 'latentImageNode') } : {}),
    ...(readOptionalString(value, 'samplerNode') ? { samplerNode: readOptionalString(value, 'samplerNode') } : {}),
    ...(readOptionalString(value, 'saveImageNode') ? { saveImageNode: readOptionalString(value, 'saveImageNode') } : {})
  };
}

function readRequiredString(value: Record<string, unknown>, key: string): string {
  const raw = value[key];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`${key} must be a non-empty string`);
  }
  return raw.trim();
}

function readOptionalString(value: Record<string, unknown>, key: string, fallback = ''): string {
  const raw = value[key];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback;
}

function readOptionalNumber(value: Record<string, unknown>, key: string): number | undefined {
  const raw = value[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function deepCloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
