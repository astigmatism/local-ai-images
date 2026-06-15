import type { ModelInventoryItem } from '../../types.ts';

export function normalizeModelLookup(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().replace(/\\/gu, '/').toLowerCase()
    : '';
}

export function modelMatchesIdentifier(model: ModelInventoryItem, identifier: string): boolean {
  const normalized = normalizeModelLookup(identifier);
  if (!normalized) return false;
  return [model.id, model.comfyName, model.fileName, model.relativePath, model.path, model.name, model.displayName]
    .filter(Boolean)
    .some((candidate) => normalizeModelLookup(candidate) === normalized);
}

export function modelMatchesDefault(model: ModelInventoryItem, defaultModel: string): boolean {
  if (!defaultModel) return false;
  const normalizedDefault = normalizeModelLookup(defaultModel);
  return [model.comfyName, model.fileName, model.relativePath, model.path, model.name, model.displayName]
    .filter(Boolean)
    .some((candidate) => normalizeModelLookup(candidate) === normalizedDefault);
}

export function findInventoryModel(models: ModelInventoryItem[], requestedModel: string): ModelInventoryItem | null {
  return models.find((model) => modelMatchesIdentifier(model, requestedModel)) ?? null;
}

export function displayModelName(model: ModelInventoryItem): string {
  return model.comfyName || model.fileName || model.relativePath || model.displayName || model.id;
}
