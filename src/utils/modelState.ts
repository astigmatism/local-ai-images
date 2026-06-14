import type { OllamaRunningModel } from '../types.ts';

function candidatesFor(modelName: string): Set<string> {
  const trimmed = modelName.trim();
  const candidates = new Set<string>([trimmed]);
  if (trimmed.endsWith(':latest')) {
    candidates.add(trimmed.slice(0, -':latest'.length));
  } else if (!trimmed.includes(':')) {
    candidates.add(`${trimmed}:latest`);
  }
  return candidates;
}

export function isDefaultModelLoaded(defaultModel: string, runningModels: OllamaRunningModel[]): boolean {
  if (defaultModel.trim() === '') {
    return false;
  }

  const expected = candidatesFor(defaultModel);
  return runningModels.some((entry) => {
    const names = [entry.name, entry.model]
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .flatMap((value) => Array.from(candidatesFor(value)));

    return names.some((value) => expected.has(value));
  });
}
