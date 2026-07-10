import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

type SourceMetadata = {
  sourceId: string;
  favorite: boolean;
  notes: string;
  rating: number;
  userCategory: string;
  categoryOverride?: string | null;
  colorOverride?: string | null;
  promptStyleOverride?: string | null;
  createdAt: string;
  updatedAt: string;
};

type GenerationSource = {
  id: string;
  type: 'checkpoint' | 'workflow';
  label: string;
  displayLabel: string;
  selectable: boolean;
  workflowId: string;
  constraints?: Record<string, unknown>;
  category?: Record<string, unknown>;
  promptStyle?: Record<string, unknown>;
  userMetadata?: SourceMetadata;
};

type SourceGroup = {
  key: string;
  label: string;
  uncategorized: boolean;
  sources: GenerationSource[];
};

type BrowserState = {
  generationSources: {
    sources: GenerationSource[];
    sourceGroups: { checkpoints: GenerationSource[]; workflows: GenerationSource[] };
    sourceMetadata?: SourceMetadata[];
  } | null;
  generationSourceMetadataById: Record<string, SourceMetadata>;
  generationSourceMetadataRecordCount: number;
  generationSourceFavoriteIds: Set<string>;
  generationSourceRatingDrafts: Record<string, number>;
  generationSourceRatingPendingValues: Record<string, number>;
  generationSourceRatingSavingIds: Set<string>;
  generationSourceCategoryDrafts: Record<string, string>;
  generationSourceCategoryPendingValues: Record<string, string>;
  generationSourceCategorySavingIds: Set<string>;
  generationSourceCategoryStatusById: Record<string, string>;
  generationSourceNotesOpenId: string | null;
  generationSourceCollapsedCategoryKeys: Set<string>;
  generationSourcePickerOpen: boolean;
};

type BrowserHarness = {
  state: BrowserState;
  generalGenerationSourceGroups(): SourceGroup[];
  favoriteGenerationSources(): GenerationSource[];
  generationSourceRowHtml(source: GenerationSource): string;
  generationSourceCategoryGroupHtml(group: SourceGroup, index: number): string;
  generationSourceCategoryGroupingKey(value: unknown): string;
  normalizeGenerationSourceMetadataRecord(value: unknown): SourceMetadata | null;
  hydrateGenerationSourceMetadata(value: unknown): void;
  sourceConstraintRecommendations(source: GenerationSource): Array<{ label: string; value: string }>;
  generationSourceSavedRating(sourceId: string): number;
  generationSourceDisplayedRating(sourceId: string): number;
  flushGenerationSourceRatingUpdates(sourceId: string): Promise<void>;
  flushGenerationSourceCategoryUpdates(sourceId: string): Promise<void>;
  handleGenerationSourcePickerClick(event: unknown): void;
  toggleGenerationSourceCategoryGroup(key: string): void;
};

type StorageMap = Map<string, string>;

type HarnessResult = {
  api: BrowserHarness;
  context: vm.Context & { fetch: typeof fetch };
  localStorage: StorageMap;
  sessionStorage: StorageMap;
  elements: Map<string, unknown>;
};

function storageFacade(values: StorageMap) {
  return {
    getItem(key: string): string | null {
      return values.has(key) ? values.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      values.set(key, String(value));
    },
    removeItem(key: string): void {
      values.delete(key);
    }
  };
}

async function loadBrowserHarness(options: { sessionStorage?: StorageMap } = {}): Promise<HarnessResult> {
  const raw = await fs.readFile(new URL('../public/image-generator.js', import.meta.url), 'utf8');
  const bootIndex = raw.lastIndexOf('\nwireEvents();');
  assert.notEqual(bootIndex, -1, 'browser script should have a recognizable boot boundary');
  const source = `${raw.slice(0, bootIndex)}\nglobalThis.__sourceBrowserTestApi = {\n    state,\n    generalGenerationSourceGroups,\n    favoriteGenerationSources,\n    generationSourceRowHtml,\n    generationSourceCategoryGroupHtml,\n    generationSourceCategoryGroupingKey,\n    normalizeGenerationSourceMetadataRecord,\n    hydrateGenerationSourceMetadata,\n    sourceConstraintRecommendations,\n    generationSourceSavedRating,\n    generationSourceDisplayedRating,\n    flushGenerationSourceRatingUpdates,\n    flushGenerationSourceCategoryUpdates,\n    handleGenerationSourcePickerClick,\n    toggleGenerationSourceCategoryGroup\n  };`;

  const localStorage = new Map<string, string>();
  const sessionStorage = options.sessionStorage ?? new Map<string, string>();
  const noOp = (): void => undefined;
  const elements = new Map<string, unknown>();
  const documentStub = {
    activeElement: null,
    querySelector: (selector: string) => elements.get(selector) ?? null,
    querySelectorAll: () => [],
    addEventListener: noOp,
    createElement: () => ({
      style: {},
      setAttribute: noOp,
      focus: noOp,
      select: noOp,
      remove: noOp
    }),
    execCommand: () => false,
    documentElement: { style: { setProperty: noOp } },
    body: {
      appendChild: noOp,
      classList: { add: noOp, remove: noOp }
    }
  };
  const contextRecord: Record<string, unknown> = {
    console,
    document: documentStub,
    navigator: {},
    fetch,
    setTimeout,
    clearTimeout,
    URL,
    Blob,
    FormData,
    Event,
    AbortController,
    structuredClone,
    window: {
      localStorage: storageFacade(localStorage),
      sessionStorage: storageFacade(sessionStorage),
      setTimeout,
      clearTimeout,
      innerWidth: 1024,
      innerHeight: 768,
      CSS: { escape: (value: string) => value },
      addEventListener: noOp
    }
  };
  const context = vm.createContext(contextRecord) as vm.Context & {
    fetch: typeof fetch;
    __sourceBrowserTestApi: BrowserHarness;
  };
  vm.runInContext(source, context, { filename: 'public/image-generator.js' });
  return { api: context.__sourceBrowserTestApi, context, localStorage, sessionStorage, elements };
}

function metadata(sourceId: string, values: Partial<SourceMetadata> = {}): SourceMetadata {
  return {
    sourceId,
    favorite: false,
    notes: '',
    rating: 0,
    userCategory: '',
    categoryOverride: null,
    colorOverride: null,
    promptStyleOverride: null,
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...values
  };
}

function source(id: string, title: string, values: Partial<GenerationSource> = {}): GenerationSource {
  return {
    id,
    type: 'checkpoint',
    label: title,
    displayLabel: title,
    selectable: true,
    workflowId: 'checkpoint-selection',
    ...values
  };
}

function hydrateHarness(api: BrowserHarness, sources: GenerationSource[], metadataRecords: SourceMetadata[]): void {
  api.state.generationSources = {
    sources,
    sourceGroups: {
      checkpoints: sources.filter((item) => item.type === 'checkpoint'),
      workflows: sources.filter((item) => item.type === 'workflow')
    },
    sourceMetadata: metadataRecords
  };
  api.state.generationSourceMetadataById = Object.fromEntries(metadataRecords.map((item) => [item.sourceId, item]));
  api.state.generationSourceMetadataRecordCount = metadataRecords.length;
  api.state.generationSourceFavoriteIds = new Set(metadataRecords.filter((item) => item.favorite).map((item) => item.sourceId));
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  } as Response;
}

test('source browser groups categories case-insensitively and applies the required deterministic ordering', async () => {
  const { api } = await loadBrowserHarness();
  const sources = [
    source('anime-zebra-5', 'Model Zebra'),
    source('anime-delta-5', 'Model Delta'),
    source('anime-alpha-4', 'Model Alpha'),
    source('anime-gamma-3', 'Model Gamma'),
    source('anime-beta-2', 'Model Beta'),
    source('anime-epsilon-1', 'Model Epsilon'),
    source('anime-omega-invalid', 'Model Omega'),
    source('realism-b', 'Realism Beta'),
    source('realism-a', 'Realism Alpha'),
    source('uncategorized-z', 'Zulu Unsorted'),
    source('uncategorized-a', 'Alpha Unsorted'),
    source('favorite-b', 'Favorite Beta'),
    source('favorite-a', 'Favorite Alpha')
  ];
  const records = [
    metadata('anime-zebra-5', { rating: 5, userCategory: 'ANIME' }),
    metadata('anime-delta-5', { rating: 5, userCategory: ' Anime ' }),
    metadata('anime-alpha-4', { rating: 4, userCategory: 'anime' }),
    metadata('anime-gamma-3', { rating: 3, userCategory: 'Anime' }),
    metadata('anime-beta-2', { rating: 2, userCategory: 'anime' }),
    metadata('anime-epsilon-1', { rating: 1, userCategory: 'ANIME' }),
    metadata('anime-omega-invalid', { rating: 99, userCategory: 'Anime' }),
    metadata('realism-b', { rating: 1, userCategory: 'Realism' }),
    metadata('realism-a', { rating: 5, userCategory: 'realism' }),
    metadata('uncategorized-z', { rating: 5 }),
    metadata('uncategorized-a', { rating: 0 }),
    metadata('favorite-b', { favorite: true, rating: 5, userCategory: 'Anime' }),
    metadata('favorite-a', { favorite: true, rating: 0, userCategory: 'Realism' })
  ].map((item) => api.normalizeGenerationSourceMetadataRecord(item)!);
  hydrateHarness(api, sources, records);

  const groups = api.generalGenerationSourceGroups();
  assert.deepEqual(Array.from(groups, (group) => group.label), ['Anime', 'Realism', 'Uncategorized']);
  assert.deepEqual(Array.from(groups[0]!.sources, (item) => item.id), [
    'anime-delta-5',
    'anime-zebra-5',
    'anime-alpha-4',
    'anime-gamma-3',
    'anime-beta-2',
    'anime-epsilon-1',
    'anime-omega-invalid'
  ]);
  assert.deepEqual(Array.from(groups[1]!.sources, (item) => item.id), ['realism-a', 'realism-b']);
  assert.deepEqual(Array.from(groups[2]!.sources, (item) => item.id), ['uncategorized-a', 'uncategorized-z']);
  assert.equal(api.generationSourceSavedRating('anime-omega-invalid'), 0);
  assert.deepEqual(Array.from(api.favoriteGenerationSources(), (item) => item.id), ['favorite-a', 'favorite-b']);
  assert.equal(Array.from(groups).flatMap((group) => Array.from(group.sources)).some((item) => item.id.startsWith('favorite-')), false);
  assert.equal(api.generationSourceCategoryGroupingKey(' Anime '), api.generationSourceCategoryGroupingKey('ANIME'));
});

test('source row output contains five stars, a user-category input, notes, and only the three recommendation badges', async () => {
  const { api } = await loadBrowserHarness();
  const item = source('checkpoint:folder/demo.safetensors', 'folder/demo.safetensors', {
    constraints: {
      steps: '20-30',
      cfgScale: '5-7',
      resolution: '1024x1024',
      notes: ['This capability note must not be a badge.'],
      origin: 'workflow'
    },
    category: { name: 'Discovered Folder', color: '#ff00ff' },
    promptStyle: { value: 'Cinematic', confidence: 'high' }
  });
  const record = metadata(item.id, { rating: 3, userCategory: 'Anime', notes: 'Saved source note' });
  hydrateHarness(api, [item], [record]);

  const html = api.generationSourceRowHtml(item);
  assert.equal((html.match(/data-source-rating-id=/g) ?? []).length, 5);
  assert.match(html, /data-source-category-input-id=/);
  assert.match(html, /value="Anime"/);
  assert.match(html, />★</);
  assert.match(html, />☆</);
  assert.match(html, /data-source-notes-toggle-id=/);
  assert.deepEqual(Array.from(api.sourceConstraintRecommendations(item), (entry) => entry.label), ['Steps', 'CFG', 'Resolution']);
  assert.equal((html.match(/image-lab-source-recommendation-badge/g) ?? []).length, 3);
  assert.doesNotMatch(html, /This capability note must not be a badge/);
  assert.doesNotMatch(html, /Cinematic/);
  assert.doesNotMatch(html, /Discovered Folder/);
  assert.doesNotMatch(html, /#ff00ff/);
  assert.doesNotMatch(html, /source-row-detail|source-subtitle|source-category-marker|source-type-badge/);
});

test('category groups are independently collapsible and preserve collapse state in session storage', async () => {
  const first = await loadBrowserHarness();
  first.api.toggleGenerationSourceCategoryGroup('category:anime');
  first.api.toggleGenerationSourceCategoryGroup('category:realism');
  first.api.toggleGenerationSourceCategoryGroup('uncategorized');
  assert.deepEqual([...first.api.state.generationSourceCollapsedCategoryKeys].sort(), ['category:anime', 'category:realism', 'uncategorized']);
  first.api.toggleGenerationSourceCategoryGroup('category:anime');
  assert.deepEqual([...first.api.state.generationSourceCollapsedCategoryKeys].sort(), ['category:realism', 'uncategorized']);
  assert.equal(first.localStorage.size, 0, 'collapse state should not become authoritative metadata in localStorage');

  const second = await loadBrowserHarness({ sessionStorage: first.sessionStorage });
  assert.deepEqual([...second.api.state.generationSourceCollapsedCategoryKeys].sort(), ['category:realism', 'uncategorized']);
  const group: SourceGroup = {
    key: 'category:realism',
    label: 'Realism',
    uncategorized: false,
    sources: [source('realism-a', 'Realism Alpha')]
  };
  const html = second.api.generationSourceCategoryGroupHtml(group, 0);
  assert.match(html, /<button type="button" class="image-lab-source-category-header"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="image-lab-source-category-group-0"/);
  assert.match(html, /class="image-lab-source-category-list" hidden/);
  assert.match(html, /1 source/);
});

test('successful rating saves reorder categorized sources and failed saves restore authoritative rating and order', async () => {
  const { api, context } = await loadBrowserHarness();
  const sources = [source('alpha', 'Alpha'), source('beta', 'Beta'), source('gamma', 'Gamma')];
  const records = [
    metadata('alpha', { rating: 1, userCategory: 'Anime' }),
    metadata('beta', { rating: 3, userCategory: 'Anime' }),
    metadata('gamma', { rating: 5, userCategory: 'Anime' })
  ];
  hydrateHarness(api, sources, records);

  context.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    assert.match(url, /\/api\/v1\/generation-sources\/metadata\/alpha$/);
    const patch = JSON.parse(String(init?.body ?? '{}')) as { rating?: number };
    const saved = metadata('alpha', { rating: patch.rating ?? 0, userCategory: 'Anime' });
    return response({ ok: true, metadata: saved });
  };
  api.state.generationSourceRatingDrafts.alpha = 5;
  api.state.generationSourceRatingPendingValues.alpha = 5;
  await api.flushGenerationSourceRatingUpdates('alpha');
  assert.equal(api.generationSourceDisplayedRating('alpha'), 5);
  assert.deepEqual(Array.from(api.generalGenerationSourceGroups()[0]!.sources, (item) => item.id), ['alpha', 'gamma', 'beta']);

  context.fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/metadata/alpha')) {
      return response({ ok: false, error: { code: 'SAVE_FAILED', message: 'Simulated save failure' } }, 500);
    }
    assert.ok(url.endsWith('/api/v1/generation-sources/metadata'));
    return response({ ok: true, metadata: [metadata('alpha', { rating: 5, userCategory: 'Anime' }), records[1], records[2]] });
  };
  api.state.generationSourceRatingDrafts.alpha = 0;
  api.state.generationSourceRatingPendingValues.alpha = 0;
  await api.flushGenerationSourceRatingUpdates('alpha');
  assert.equal(api.generationSourceSavedRating('alpha'), 5);
  assert.equal(api.generationSourceDisplayedRating('alpha'), 5);
  assert.equal(Object.prototype.hasOwnProperty.call(api.state.generationSourceRatingDrafts, 'alpha'), false);
  assert.deepEqual(Array.from(api.generalGenerationSourceGroups()[0]!.sources, (item) => item.id), ['alpha', 'gamma', 'beta']);
});

test('metadata controls and category headers do not select a source, while a row click preserves normal selection behavior', async () => {
  const { api, context, elements } = await loadBrowserHarness();
  const item = source('alpha', 'Alpha');
  hydrateHarness(api, [item], [metadata('alpha', { userCategory: 'Anime' })]);
  let dispatchCount = 0;
  const select = {
    value: '',
    dispatchEvent: (): boolean => {
      dispatchCount += 1;
      return true;
    }
  };
  elements.set('#image-lab-model', select);
  context.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const patch = JSON.parse(String(init?.body ?? '{}')) as { rating?: number };
    return response({ ok: true, metadata: metadata('alpha', { userCategory: 'Anime', rating: patch.rating ?? 0 }) });
  };

  const eventFor = (matches: Record<string, { dataset?: Record<string, string> } | null>) => {
    let prevented = false;
    let stopped = false;
    return {
      event: {
        target: {
          closest(selector: string) {
            return Object.prototype.hasOwnProperty.call(matches, selector) ? matches[selector] : null;
          }
        },
        preventDefault() { prevented = true; },
        stopPropagation() { stopped = true; }
      },
      wasPrevented: () => prevented,
      wasStopped: () => stopped
    };
  };

  api.state.generationSourcePickerOpen = true;
  const headerClick = eventFor({
    '[data-source-category-toggle-key]': { dataset: { sourceCategoryToggleKey: 'category:anime' } }
  });
  api.handleGenerationSourcePickerClick(headerClick.event);
  assert.equal(api.state.generationSourcePickerOpen, true);
  assert.equal(select.value, '');
  assert.equal(dispatchCount, 0);
  assert.equal(headerClick.wasPrevented(), true);
  assert.equal(headerClick.wasStopped(), true);

  const inputElement = { dataset: { sourceCategoryInputId: 'alpha' } };
  const inputClick = eventFor({ 'textarea, input, button': inputElement });
  api.handleGenerationSourcePickerClick(inputClick.event);
  assert.equal(api.state.generationSourcePickerOpen, true);
  assert.equal(select.value, '');
  assert.equal(dispatchCount, 0);

  const metadataRegionSelector = 'textarea, input, button, .image-lab-source-favorite-cell, .image-lab-source-rating-cell, .image-lab-source-category-field, .image-lab-source-row-actions, .image-lab-source-notes-panel';
  const categoryStatusClick = eventFor({ [metadataRegionSelector]: {} });
  api.handleGenerationSourcePickerClick(categoryStatusClick.event);
  assert.equal(categoryStatusClick.wasStopped(), true);
  assert.equal(api.state.generationSourcePickerOpen, true);
  assert.equal(select.value, '');
  assert.equal(dispatchCount, 0);

  const notesClick = eventFor({
    '[data-source-notes-toggle-id]': { dataset: { sourceNotesToggleId: 'alpha' } }
  });
  api.handleGenerationSourcePickerClick(notesClick.event);
  assert.equal(api.state.generationSourceNotesOpenId, 'alpha');
  assert.equal(api.state.generationSourcePickerOpen, true);
  assert.equal(select.value, '');
  assert.equal(dispatchCount, 0);

  const notesPanelClick = eventFor({ [metadataRegionSelector]: {} });
  api.handleGenerationSourcePickerClick(notesPanelClick.event);
  assert.equal(notesPanelClick.wasStopped(), true);
  assert.equal(api.state.generationSourcePickerOpen, true);
  assert.equal(select.value, '');
  assert.equal(dispatchCount, 0);

  const ratingClick = eventFor({
    '[data-source-rating-id]': { dataset: { sourceRatingId: 'alpha', sourceRatingValue: '3' } }
  });
  api.handleGenerationSourcePickerClick(ratingClick.event);
  while (api.state.generationSourceRatingSavingIds.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(api.generationSourceSavedRating('alpha'), 3);
  assert.equal(api.state.generationSourcePickerOpen, true);
  assert.equal(select.value, '');
  assert.equal(dispatchCount, 0);

  const firstStarClick = eventFor({
    '[data-source-rating-id]': { dataset: { sourceRatingId: 'alpha', sourceRatingValue: '1' } }
  });
  api.handleGenerationSourcePickerClick(firstStarClick.event);
  while (api.state.generationSourceRatingSavingIds.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(api.generationSourceSavedRating('alpha'), 1);
  api.handleGenerationSourcePickerClick(firstStarClick.event);
  while (api.state.generationSourceRatingSavingIds.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(api.generationSourceSavedRating('alpha'), 0, 'activating the selected first star again clears the rating');
  assert.equal(api.state.generationSourcePickerOpen, true);
  assert.equal(select.value, '');
  assert.equal(dispatchCount, 0);

  const rowClick = eventFor({ '[data-source-id]': { dataset: { sourceId: 'alpha' } } });
  api.handleGenerationSourcePickerClick(rowClick.event);
  assert.equal(select.value, 'alpha');
  assert.equal(dispatchCount, 1);
  assert.equal(api.state.generationSourcePickerOpen, false);
});

test('category saves move sources only after success and retain the unsaved draft when a later save fails', async () => {
  const { api, context } = await loadBrowserHarness();
  const sources = [source('alpha', 'Alpha'), source('beta', 'Beta')];
  const records = [
    metadata('alpha', { rating: 4, userCategory: 'Anime' }),
    metadata('beta', { rating: 5, userCategory: 'Realism' })
  ];
  hydrateHarness(api, sources, records);

  context.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    assert.ok(url.endsWith('/metadata/alpha'));
    const patch = JSON.parse(String(init?.body ?? '{}')) as { userCategory?: string };
    return response({ ok: true, metadata: metadata('alpha', { rating: 4, userCategory: patch.userCategory ?? '' }) });
  };
  api.state.generationSourceCategoryDrafts.alpha = 'Realism';
  api.state.generationSourceCategoryPendingValues.alpha = 'Realism';
  await api.flushGenerationSourceCategoryUpdates('alpha');
  const realism = api.generalGenerationSourceGroups().find((group) => group.label === 'Realism');
  assert.ok(realism);
  assert.deepEqual(Array.from(realism.sources, (item) => item.id), ['beta', 'alpha']);
  assert.equal(Object.prototype.hasOwnProperty.call(api.state.generationSourceCategoryDrafts, 'alpha'), false);

  context.fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/metadata/alpha')) {
      return response({ ok: false, error: { code: 'SAVE_FAILED', message: 'Simulated category failure' } }, 500);
    }
    assert.ok(url.endsWith('/api/v1/generation-sources/metadata'));
    return response({ ok: true, metadata: [
      metadata('alpha', { rating: 4, userCategory: 'Realism' }),
      metadata('beta', { rating: 5, userCategory: 'Realism' })
    ] });
  };
  api.state.generationSourceCategoryDrafts.alpha = 'Experimental';
  api.state.generationSourceCategoryPendingValues.alpha = 'Experimental';
  await api.flushGenerationSourceCategoryUpdates('alpha');
  assert.equal(api.state.generationSourceCategoryDrafts.alpha, 'Experimental');
  assert.equal(api.state.generationSourceCategoryStatusById.alpha, 'error');
  assert.equal(api.generalGenerationSourceGroups().some((group) => group.label === 'Experimental'), false);
  const authoritativeRealism = api.generalGenerationSourceGroups().find((group) => group.label === 'Realism');
  assert.ok(authoritativeRealism);
  assert.deepEqual(Array.from(authoritativeRealism.sources, (item) => item.id), ['beta', 'alpha']);
});

test('clearing a saved category moves the source to alphabetically sorted Uncategorized and removes an empty category', async () => {
  const { api, context } = await loadBrowserHarness();
  const sources = [source('zulu', 'Zulu'), source('alpha', 'Alpha'), source('middle', 'Middle')];
  hydrateHarness(api, sources, [
    metadata('zulu', { rating: 5 }),
    metadata('alpha', { rating: 1 }),
    metadata('middle', { rating: 4, userCategory: 'Experimental' })
  ]);

  context.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    assert.ok(String(input).endsWith('/metadata/middle'));
    const patch = JSON.parse(String(init?.body ?? '{}')) as { userCategory?: string };
    return response({ ok: true, metadata: metadata('middle', { rating: 4, userCategory: patch.userCategory ?? '' }) });
  };
  api.state.generationSourceCategoryDrafts.middle = '';
  api.state.generationSourceCategoryPendingValues.middle = '';
  await api.flushGenerationSourceCategoryUpdates('middle');

  const groups = api.generalGenerationSourceGroups();
  assert.deepEqual(Array.from(groups, (group) => group.label), ['Uncategorized']);
  assert.deepEqual(Array.from(groups[0]!.sources, (item) => item.id), ['alpha', 'middle', 'zulu']);
});

test('stale metadata refreshes do not overwrite a newer locally confirmed server record', async () => {
  const { api } = await loadBrowserHarness();
  const item = source('alpha', 'Alpha');
  const current = metadata('alpha', {
    rating: 5,
    userCategory: 'Anime',
    updatedAt: '2026-07-10T12:00:02.000Z'
  });
  hydrateHarness(api, [item], [current]);

  api.hydrateGenerationSourceMetadata({ metadata: [metadata('alpha', {
    rating: 1,
    userCategory: 'Old category',
    updatedAt: '2026-07-10T12:00:01.000Z'
  })] });
  assert.equal(api.generationSourceSavedRating('alpha'), 5);
  assert.equal(api.state.generationSourceMetadataById.alpha.userCategory, 'Anime');

  api.hydrateGenerationSourceMetadata({ metadata: [metadata('alpha', {
    rating: 4,
    userCategory: 'Realism',
    updatedAt: '2026-07-10T12:00:03.000Z'
  })] });
  assert.equal(api.generationSourceSavedRating('alpha'), 4);
  assert.equal(api.state.generationSourceMetadataById.alpha.userCategory, 'Realism');
});
