const $ = (selector) => document.querySelector(selector);

const DEFAULT_GALLERY_LIMIT = 48;
const MAX_GALLERY_LIMIT = 250;
const GALLERY_LIMIT_STEP = 48;
const DEFAULT_TILE_SIZE = 300;

const state = {
  imageHealth: null,
  imageModels: null,
  imageWorkflows: null,
  selectedWorkflowId: null,
  imageJobs: null,
  imageFavorites: null,
  imageError: null,
  activeJobId: null,
  isGenerating: false,
  prewarmingModel: null,
  loadedFavoritePayloadBase: null,
  galleryLimit: DEFAULT_GALLERY_LIMIT,
  galleryTileSize: readStoredGallerySize(),
  lastResult: null
};

const thumbnailObjectUrls = new Map();

function readStoredGallerySize() {
  const raw = window.localStorage.getItem('local-ai-images-gallery-size');
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 160 && parsed <= 620 ? parsed : DEFAULT_TILE_SIZE;
}

async function fetchJson(url, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = body?.error?.message || body?.detail?.[0]?.msg || `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clonePayload(value) {
  return isPlainObject(value) ? JSON.parse(JSON.stringify(value)) : {};
}

function formatDate(value) {
  if (!value) return 'n/a';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatDurationMs(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  const ms = Number(value);
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} s`;
}

function previewText(value, max = 140) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, Math.max(0, max - 1)).trimEnd()}...` : compact;
}

function statusPill(label, tone = 'ok') {
  return `<span class="status-pill ${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

function payloadString(payload, keys) {
  if (!isPlainObject(payload)) return '';
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function payloadNumber(payload, keys) {
  if (!isPlainObject(payload)) return null;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function payloadSeed(payload) {
  if (!isPlainObject(payload)) return null;
  const value = payload.seed;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return null;
}

function setStatus(message, ok = true) {
  const target = $('#image-lab-status');
  if (!target) return;
  target.className = `feedback ${ok ? 'ok' : 'error'}`;
  target.textContent = message || '';
}

function modelIdentifier(model) {
  return model?.comfyName || model?.fileName || model?.relativePath || model?.id || '';
}

function normalizeModel(value) {
  return String(value || '').trim().replace(/\\/g, '/').toLowerCase();
}

function modelMatches(model, value) {
  const normalized = normalizeModel(value);
  if (!normalized || !model) return false;
  return [model.id, model.comfyName, model.fileName, model.relativePath, model.path, model.name, model.displayName]
    .filter(Boolean)
    .some((candidate) => normalizeModel(candidate) === normalized);
}

function checkpointModels() {
  return (state.imageModels?.models || []).filter((model) => model.type === 'checkpoint');
}

function selectedModel() {
  return $('#image-lab-model')?.value || '';
}

function defaultWorkflowId() {
  return state.imageWorkflows?.default_workflow_id
    || state.imageWorkflows?.defaultWorkflowId
    || state.imageModels?.defaultWorkflowId
    || state.imageModels?.default_workflow_id
    || state.imageWorkflows?.workflows?.[0]?.id
    || '';
}

function selectedWorkflowId() {
  const workflows = state.imageWorkflows?.workflows || [];
  if (state.selectedWorkflowId && workflows.some((workflow) => workflow.id === state.selectedWorkflowId)) {
    return state.selectedWorkflowId;
  }
  const fallback = defaultWorkflowId();
  state.selectedWorkflowId = fallback || null;
  return fallback;
}

function selectedWorkflow() {
  const id = selectedWorkflowId();
  return (state.imageWorkflows?.workflows || []).find((workflow) => workflow.id === id) || state.imageWorkflows?.workflows?.[0] || null;
}


function renderModelOptions() {
  const select = $('#image-lab-model');
  if (!select) return;
  const previous = select.value;
  const checkpoints = checkpointModels();
  const lastLoaded = checkpoints.find((model) => model.isLastConfirmedLoaded) || null;
  const selected = checkpoints.some((model) => modelMatches(model, previous))
    ? previous
    : lastLoaded
      ? modelIdentifier(lastLoaded)
      : checkpoints[0]
        ? modelIdentifier(checkpoints[0])
        : '';
  const placeholder = checkpoints.length > 0 ? 'Choose a checkpoint' : 'No checkpoint models found';
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` + checkpoints.map((model) => {
    const labels = [];
    if (model.isLastConfirmedLoaded) labels.push('last loaded/prewarmed');
    if (model.loadedStatus === 'default_not_confirmed_loaded') labels.push('available');
    const label = `${model.comfyName || model.fileName}${labels.length ? ` (${labels.join(', ')})` : ''}`;
    return `<option value="${escapeHtml(modelIdentifier(model))}">${escapeHtml(label)}</option>`;
  }).join('');
  select.value = selected;
}

function applyWorkflowDefaults(overwrite = false) {
  const workflow = selectedWorkflow();
  if (!workflow) return;
  const defaults = workflow.defaults || {};
  const pairs = [
    ['#image-lab-width', defaults.width],
    ['#image-lab-height', defaults.height],
    ['#image-lab-steps', defaults.steps],
    ['#image-lab-cfg', defaults.cfgScale],
    ['#image-lab-sampler', defaults.samplerName],
    ['#image-lab-scheduler', defaults.scheduler]
  ];
  for (const [selector, value] of pairs) {
    const input = $(selector);
    if (!input || value === undefined || value === null) continue;
    if (overwrite || input.value === '') input.value = value;
  }
}

function renderControls() {
  renderModelOptions();
  applyWorkflowDefaults(false);
  const slider = $('#image-lab-gallery-size');
  const sliderValue = $('#image-lab-gallery-size-value');
  if (slider) slider.value = String(state.galleryTileSize);
  if (sliderValue) sliderValue.textContent = `${state.galleryTileSize}px`;
  const generateButton = $('#image-lab-generate');
  if (generateButton) {
    generateButton.disabled = Boolean(state.isGenerating || state.prewarmingModel);
    generateButton.textContent = state.isGenerating ? 'Generating...' : state.prewarmingModel ? 'Prewarming...' : 'Generate';
  }
  updatePayloadPreview();
}

function buildGenerationPayload() {
  const basePayload = isPlainObject(state.loadedFavoritePayloadBase) ? clonePayload(state.loadedFavoritePayloadBase) : {};
  const baseMetadata = isPlainObject(basePayload.metadata) ? basePayload.metadata : {};
  const workflow = selectedWorkflow();
  const seedRaw = $('#image-lab-seed')?.value.trim() || '';
  const parsedSeed = seedRaw === '' ? -1 : Number(seedRaw);
  const payload = {
    ...basePayload,
    prompt: $('#image-lab-prompt')?.value.trim() || '',
    negative_prompt: $('#image-lab-negative')?.value.trim() || '',
    workflow_id: workflow?.id || basePayload.workflow_id || basePayload.workflowId || undefined,
    model: selectedModel() || undefined,
    width: Number($('#image-lab-width')?.value || 0) || undefined,
    height: Number($('#image-lab-height')?.value || 0) || undefined,
    steps: Number($('#image-lab-steps')?.value || 0) || undefined,
    cfg_scale: Number($('#image-lab-cfg')?.value || 0),
    seed: Number.isFinite(parsedSeed) ? parsedSeed : -1,
    sampler_name: $('#image-lab-sampler')?.value.trim() || undefined,
    scheduler: $('#image-lab-scheduler')?.value.trim() || undefined,
    output: 'url',
    sync_timeout_ms: Number($('#image-lab-sync-timeout')?.value || 0) || 1000,
    metadata: { ...baseMetadata, source: 'image-generator-portal' }
  };
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === '') delete payload[key];
  }
  return payload;
}

function updatePayloadPreview() {
  const preview = $('#image-lab-request-preview');
  if (preview) preview.textContent = JSON.stringify(buildGenerationPayload(), null, 2);
}

function setInputValue(selector, value) {
  const input = $(selector);
  if (!input || value === null || value === undefined || value === '') return;
  input.value = String(value);
}

function selectModelByPayload(model) {
  if (!model) return true;
  const select = $('#image-lab-model');
  if (!select) return false;
  const direct = [...select.options].find((option) => option.value === model);
  if (direct) {
    select.value = direct.value;
    return true;
  }
  const matched = checkpointModels().find((candidate) => modelMatches(candidate, model));
  if (matched) {
    select.value = modelIdentifier(matched);
    return true;
  }
  return false;
}

function selectedWorkflowMatches(_workflowId) {
  return true;
}

function applyGenerationPayloadToControls(payload) {
  const requestPayload = clonePayload(payload);
  const warnings = [];
  state.loadedFavoritePayloadBase = requestPayload;

  const prompt = payloadString(requestPayload, ['prompt', 'positive_prompt', 'positivePrompt']);
  const negative = payloadString(requestPayload, ['negative_prompt', 'negativePrompt']);
  const promptInput = $('#image-lab-prompt');
  const negativeInput = $('#image-lab-negative');
  if (promptInput) promptInput.value = prompt;
  if (negativeInput) negativeInput.value = negative;

  const model = payloadString(requestPayload, ['model', 'checkpoint', 'checkpoint_name', 'checkpointName']);
  if (model && !selectModelByPayload(model)) warnings.push(`model ${model}`);

  setInputValue('#image-lab-width', payloadNumber(requestPayload, ['width']));
  setInputValue('#image-lab-height', payloadNumber(requestPayload, ['height']));
  setInputValue('#image-lab-steps', payloadNumber(requestPayload, ['steps']));
  setInputValue('#image-lab-cfg', payloadNumber(requestPayload, ['cfg_scale', 'cfgScale', 'guidance_scale', 'guidanceScale']));
  setInputValue('#image-lab-sampler', payloadString(requestPayload, ['sampler_name', 'samplerName', 'sampler']));
  setInputValue('#image-lab-scheduler', payloadString(requestPayload, ['scheduler']));
  setInputValue('#image-lab-sync-timeout', payloadNumber(requestPayload, ['sync_timeout_ms', 'syncTimeoutMs']));

  const seed = payloadSeed(requestPayload);
  const seedInput = $('#image-lab-seed');
  if (seed === null) {
    warnings.push('seed missing; seed input left random');
    if (seedInput) seedInput.value = '';
  } else if (Number(seed) < 0) {
    if (seedInput) seedInput.value = '';
  } else if (seedInput) {
    seedInput.value = String(seed);
  }

  updatePayloadPreview();
  return warnings;
}

function jobArtifacts(job) {
  return Array.isArray(job?.artifacts) ? job.artifacts : [];
}

function firstArtifact(job) {
  return jobArtifacts(job).find((artifact) => artifact?.url) || jobArtifacts(job)[0] || null;
}

function firstImageUrl(job) {
  return job?.thumbnailUrl || firstArtifact(job)?.url || '';
}

function jobPrompt(job) {
  return job?.prompt || job?.request?.prompt || '';
}

function jobNegativePrompt(job) {
  return job?.negativePrompt || job?.request?.negativePrompt || job?.request?.negative_prompt || '';
}

function jobRequestPayload(job) {
  if (isPlainObject(job?.requestPayload)) return clonePayload(job.requestPayload);
  if (isPlainObject(job?.request_payload)) return clonePayload(job.request_payload);
  const request = isPlainObject(job?.request) ? job.request : {};
  const payload = {
    prompt: jobPrompt(job),
    negative_prompt: jobNegativePrompt(job),
    model: job?.model || request.model || undefined,
    workflow_id: job?.workflowId || request.workflowId || request.workflow_id || undefined,
    width: job?.width ?? request.width ?? undefined,
    height: job?.height ?? request.height ?? undefined,
    steps: job?.steps ?? request.steps ?? undefined,
    cfg_scale: job?.cfgScale ?? request.cfgScale ?? request.cfg_scale ?? undefined,
    seed: job?.seed ?? request.seed ?? undefined,
    sampler_name: job?.samplerName || request.samplerName || request.sampler_name || undefined,
    scheduler: job?.scheduler || request.scheduler || undefined,
    output: job?.output || request.output || undefined,
    sync_timeout_ms: request.syncTimeoutMs ?? request.sync_timeout_ms ?? undefined,
    metadata: isPlainObject(request.metadata) ? request.metadata : undefined
  };
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === '') delete payload[key];
  }
  return payload;
}

function favoriteForJob(job) {
  const artifact = firstArtifact(job);
  const artifactId = artifact?.id ? String(artifact.id) : '';
  const jobId = job?.id ? String(job.id) : '';
  return (state.imageFavorites?.favorites || []).find((favorite) => {
    return (artifactId && favorite.artifactId === artifactId) || (jobId && favorite.jobId === jobId);
  }) || null;
}

function hydrateImages() {
  for (const image of document.querySelectorAll('img[data-artifact-url]')) {
    const url = image.dataset.artifactUrl;
    if (!url || image.dataset.loaded === '1') continue;
    if (thumbnailObjectUrls.has(url)) {
      image.src = thumbnailObjectUrls.get(url);
      image.hidden = false;
      image.dataset.loaded = '1';
      image.nextElementSibling?.remove();
      continue;
    }
    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        const objectUrl = URL.createObjectURL(blob);
        thumbnailObjectUrls.set(url, objectUrl);
        image.src = objectUrl;
        const anchor = image.closest('a');
        if (anchor) anchor.href = objectUrl;
        image.hidden = false;
        image.dataset.loaded = '1';
        image.nextElementSibling?.remove();
      })
      .catch(() => {
        image.hidden = true;
        image.nextElementSibling?.replaceWith(Object.assign(document.createElement('div'), { className: 'thumb-placeholder', textContent: 'Image unavailable' }));
      });
  }
}

function renderLastResult() {
  const target = $('#image-lab-last-result');
  if (!target) return;
  const result = state.lastResult;
  if (!result) {
    target.innerHTML = '<p class="muted">No image generated yet.</p>';
    return;
  }
  const job = result.job || {};
  const artifact = firstArtifact(job) || (result.artifacts || []).find((item) => item?.url) || null;
  const imageUrl = artifact?.url || '';
  const tone = job.status === 'succeeded' ? 'ok' : job.status === 'failed' ? 'bad' : 'warn';
  target.innerHTML = `<div class="generation-result image-lab-result">
    <p>${statusPill(job.status || 'submitted', tone)} Job <code>${escapeHtml(job.id || 'n/a')}</code></p>
    ${imageUrl ? `<a href="${escapeHtml(imageUrl)}" target="_blank" rel="noopener"><img class="result-image" data-artifact-url="${escapeHtml(imageUrl)}" alt="Last generated image" loading="lazy" hidden><div class="thumb-placeholder">Loading result image...</div></a>` : '<div class="thumb-placeholder">No image artifact available</div>'}
    <p class="compact-meta-line"><span><strong>Seed:</strong> ${escapeHtml(job.seed ?? job.request?.seed ?? 'n/a')}</span><span><strong>Total:</strong> ${escapeHtml(formatDurationMs(job.totalMs ?? job.timings?.totalMs))}</span></p>
  </div>`;
  hydrateImages();
}

function currentJobs() {
  const jobs = state.imageJobs?.jobs || state.imageJobs?.items || [];
  return [...jobs].sort((a, b) => {
    const bDate = new Date(b.completedAt || b.updatedAt || b.createdAt || 0).getTime();
    const aDate = new Date(a.completedAt || a.updatedAt || a.createdAt || 0).getTime();
    return bDate - aDate;
  });
}

function renderGallery() {
  const target = $('#image-lab-gallery');
  const count = $('#image-lab-gallery-count');
  const loadMore = $('#image-lab-load-more');
  if (!target) return;
  document.documentElement.style.setProperty('--image-lab-gallery-size', `${state.galleryTileSize}px`);
  const jobs = currentJobs();
  if (count) {
    const total = state.imageJobs?.totalItems;
    count.textContent = total === undefined ? `${jobs.length} shown` : `${jobs.length} of ${total} shown`;
  }
  if (loadMore) {
    const hasNext = Boolean(state.imageJobs?.hasNextPage) && state.galleryLimit < MAX_GALLERY_LIMIT;
    loadMore.disabled = !hasNext;
    loadMore.hidden = jobs.length === 0;
  }
  if (!state.imageJobs) {
    target.innerHTML = '<p class="muted">Loading recent image jobs...</p>';
    return;
  }
  if (jobs.length === 0) {
    target.innerHTML = '<p class="muted">No generated images found yet. Submit a generation to start the gallery.</p>';
    return;
  }
  target.classList.remove('placeholder');
  target.innerHTML = jobs.map(renderGalleryCard).join('');
  hydrateImages();
}

function renderGalleryCard(job, index) {
  const artifact = firstArtifact(job);
  const imageUrl = firstImageUrl(job);
  const prompt = jobPrompt(job);
  const negative = jobNegativePrompt(job);
  const payload = jobRequestPayload(job);
  const favorite = favoriteForJob(job);
  const jobId = job?.id || `job-${index + 1}`;
  const tone = job.status === 'succeeded' ? 'ok' : job.status === 'failed' ? 'bad' : 'warn';
  const dimensions = `${job.width ?? job.request?.width ?? payload.width ?? 'n/a'} x ${job.height ?? job.request?.height ?? payload.height ?? 'n/a'}`;
  const seed = job.seed ?? job.request?.seed ?? payload.seed ?? 'n/a';
  const model = job.model || payload.model || 'model n/a';
  const requestDetails = { requestPayload: payload, request: job.request || {}, metadata: job.metadata || {}, artifacts: jobArtifacts(job) };
  return `<article class="image-lab-gallery-card" data-job-index="${escapeHtml(index)}" data-job-id="${escapeHtml(jobId)}">
    <div class="image-lab-image-frame">
      ${imageUrl ? `<a class="gallery-image-link" href="${escapeHtml(imageUrl)}" target="_blank" rel="noopener"><img class="gallery-image" data-artifact-url="${escapeHtml(imageUrl)}" alt="Generated image: ${escapeHtml(previewText(prompt, 90) || jobId)}" loading="lazy" hidden><div class="thumb-placeholder">Loading image...</div></a>` : '<div class="thumb-placeholder">No image artifact available</div>'}
    </div>
    <details class="image-lab-card-details">
      <summary>
        <span class="image-lab-caption-title">${escapeHtml(previewText(prompt, 100) || jobId)}</span>
        <span class="image-lab-caption-meta"><code>${escapeHtml(model)}</code> - ${escapeHtml(dimensions)} - seed ${escapeHtml(seed)} - ${escapeHtml(formatDate(job.completedAt || job.updatedAt || job.createdAt))}</span>
      </summary>
      <div class="image-lab-card-detail-body">
        <div class="button-row image-lab-card-actions">
          <button type="button" class="secondary" data-gallery-action="load-settings" data-job-index="${escapeHtml(index)}">Load settings</button>
          <button type="button" class="secondary" data-gallery-action="copy-payload" data-job-index="${escapeHtml(index)}">Copy payload</button>
          <button type="button" class="secondary" data-gallery-action="save-favorite" data-job-index="${escapeHtml(index)}" ${favorite ? 'disabled' : ''}>${favorite ? 'Saved favorite' : 'Save Favorite'}</button>
        </div>
        <div class="compact-meta job-meta">
          <p class="compact-meta-line"><span><strong>Status:</strong> ${statusPill(job.status || 'unknown', tone)}</span><span><strong>Workflow:</strong> ${escapeHtml(job.workflowId || payload.workflow_id || 'n/a')}</span><span><strong>Provider:</strong> ${escapeHtml(job.provider || 'n/a')}</span></p>
          <p class="compact-meta-line"><span><strong>Steps:</strong> ${escapeHtml(job.steps ?? payload.steps ?? 'n/a')}</span><span><strong>CFG:</strong> ${escapeHtml(job.cfgScale ?? payload.cfg_scale ?? 'n/a')}</span><span><strong>Sampler:</strong> ${escapeHtml(job.samplerName ?? payload.sampler_name ?? 'n/a')}</span><span><strong>Scheduler:</strong> ${escapeHtml(job.scheduler ?? payload.scheduler ?? 'n/a')}</span></p>
          <p class="compact-meta-line"><span><strong>Total:</strong> ${escapeHtml(formatDurationMs(job.totalMs ?? job.timings?.totalMs))}</span><span><strong>Execution:</strong> ${escapeHtml(formatDurationMs(job.executionMs ?? job.timings?.executionMs))}</span><span><strong>Artifact:</strong> ${escapeHtml(artifact?.id || 'n/a')}</span></p>
        </div>
        <div class="job-prompt-grid">
          ${renderPromptBlock('Positive prompt', prompt, 'No prompt recorded')}
          ${renderPromptBlock('Negative prompt', negative, 'No negative prompt recorded')}
        </div>
        ${job.error ? `<p class="danger-text">${escapeHtml(job.error.code)}: ${escapeHtml(job.error.message)}</p>` : ''}
        <h3>Full request payload</h3>
        <pre><code>${escapeHtml(JSON.stringify(payload, null, 2))}</code></pre>
        <h3>Job, artifact, and provider metadata</h3>
        <pre><code>${escapeHtml(JSON.stringify(requestDetails, null, 2))}</code></pre>
      </div>
    </details>
  </article>`;
}

function renderPromptBlock(label, text, emptyText) {
  return `<div class="prompt-block">
    <p class="prompt-label">${escapeHtml(label)}</p>
    <div class="prompt-text bounded-prompt">${text ? escapeHtml(text) : `<span class="muted">${escapeHtml(emptyText)}</span>`}</div>
  </div>`;
}

function renderFavorites() {
  const target = $('#image-lab-favorites');
  if (!target) return;
  const favorites = state.imageFavorites?.favorites || [];
  if (!state.imageFavorites) {
    target.innerHTML = '<p class="muted">Loading saved image favorites...</p>';
    return;
  }
  if (favorites.length === 0) {
    target.innerHTML = '<p class="muted">No image favorites yet. Save a generated gallery item to pin it here.</p>';
    return;
  }
  target.classList.remove('placeholder');
  target.innerHTML = favorites.map((favorite) => {
    const imageUrl = favorite.imageUrl || favorite.artifact?.url || '';
    const caption = favorite.title || favorite.promptPreview || favorite.jobId || 'Image favorite';
    return `<article class="image-lab-favorite-card" data-favorite-id="${escapeHtml(favorite.id)}">
      <button type="button" class="image-lab-favorite-thumb" data-favorite-action="load" aria-label="Load favorite ${escapeHtml(caption)}">
        ${imageUrl ? `<img data-artifact-url="${escapeHtml(imageUrl)}" alt="Favorite image: ${escapeHtml(previewText(caption, 80))}" loading="lazy" hidden><div class="thumb-placeholder">Loading favorite...</div>` : '<div class="thumb-placeholder">No image</div>'}
      </button>
      <div class="image-lab-favorite-body">
        <strong>${escapeHtml(previewText(caption, 72))}</strong>
        <span class="hint"><code>${escapeHtml(favorite.model || 'model n/a')}</code> - seed ${escapeHtml(favorite.seed ?? 'n/a')}</span>
        <div class="button-row favorite-actions">
          <button type="button" data-favorite-action="load">Load</button>
          <button type="button" class="secondary danger" data-favorite-action="delete">Delete</button>
        </div>
      </div>
    </article>`;
  }).join('');
  hydrateImages();
}

function renderAll() {
  renderControls();
  renderFavorites();
  renderGallery();
  renderLastResult();
}

async function refreshAll(message = '') {
  state.imageError = null;
  const publicHealth = await fetchJson('/health').catch((error) => {
    state.imageError = error;
    return null;
  });
  if (publicHealth) state.imageHealth = publicHealth;

  const [models, workflows, jobs, favorites] = await Promise.allSettled([
    fetchJson('/api/v1/models'),
    fetchJson('/api/v1/workflows'),
    loadGalleryData(),
    fetchJson('/api/v1/image-favorites?limit=50')
  ]);

  if (models.status === 'fulfilled') state.imageModels = models.value;
  if (workflows.status === 'fulfilled') state.imageWorkflows = workflows.value;
  if (jobs.status === 'fulfilled') state.imageJobs = jobs.value;
  if (favorites.status === 'fulfilled') state.imageFavorites = favorites.value;

  const rejected = [models, workflows, jobs, favorites].find((result) => result.status === 'rejected');
  if (rejected) {
    state.imageError = rejected.reason;
    setStatus(rejected.reason?.message || 'Unable to refresh image generator data.', false);
  } else if (message) {
    setStatus(message);
  }
  renderAll();
}

async function loadGalleryData() {
  const params = new URLSearchParams({ page: '1', pageSize: String(Math.min(state.galleryLimit, MAX_GALLERY_LIMIT)) });
  return fetchJson(`/api/v1/jobs?${params.toString()}`);
}

async function refreshGalleryOnly(message = '') {
  state.imageJobs = await loadGalleryData();
  renderGallery();
  if (message) setStatus(message);
}

async function refreshFavoritesOnly(message = '') {
  state.imageFavorites = await fetchJson('/api/v1/image-favorites?limit=50');
  renderFavorites();
  renderGallery();
  if (message) setStatus(message);
}

async function refreshModelsOnly(message = '') {
  state.imageModels = await fetchJson('/api/v1/models/refresh', { method: 'POST' });
  renderControls();
  if (message) setStatus(message);
}

async function prewarmSelectedModel() {
  const model = selectedModel();
  if (!model) {
    setStatus('Choose a checkpoint before prewarming.', false);
    return false;
  }
  state.prewarmingModel = model;
  renderControls();
  setStatus(`Prewarming ${model} for this generation workflow...`);
  try {
    await fetchJson('/api/v1/models/preload', { method: 'POST', body: JSON.stringify({ model }) });
    await refreshModelsOnly(`Prewarmed ${model} for this portal.`);
    return true;
  } catch (error) {
    setStatus(`Prewarm failed: ${error.message}`, false);
    return false;
  } finally {
    state.prewarmingModel = null;
    renderControls();
  }
}

async function handleGenerate(event) {
  event.preventDefault();
  if (state.isGenerating || state.prewarmingModel) return;
  const payload = buildGenerationPayload();
  if (!payload.model) {
    setStatus('Choose a checkpoint before generating.', false);
    return;
  }
  if (!payload.prompt) {
    setStatus('Positive prompt is required.', false);
    return;
  }
  state.isGenerating = true;
  renderControls();
  setStatus('Submitting generation request...');
  try {
    let result = await fetchJson('/api/v1/generate', { method: 'POST', body: JSON.stringify(payload) });
    if (result.job?.id && ['queued', 'running'].includes(result.job.status)) {
      state.activeJobId = result.job.id;
      result = await pollGenerationResult(result.job.id);
    }
    state.lastResult = result;
    const job = result.job || null;
    if (job?.status && job.status !== 'succeeded') {
      throw new Error(job.error?.message || `Generation finished with status ${job.status}.`);
    }
    if (job) addJobToTop(job);
    renderLastResult();
    await refreshGalleryOnly();
    await refreshModelsOnly();
    const seed = job?.seed ?? job?.request?.seed ?? 'n/a';
    if (seed !== 'n/a' && seed !== null && seed !== undefined && Number(seed) >= 0) {
      const seedInput = $('#image-lab-seed');
      if (seedInput) seedInput.value = String(seed);
      updatePayloadPreview();
    }
    setStatus(`Generation complete. Actual seed: ${seed}.`);
  } catch (error) {
    setStatus(`Generation failed: ${error.message}`, false);
    const target = $('#image-lab-last-result');
    if (target) target.innerHTML = `<p class="danger-text">${escapeHtml(error.message)}</p>`;
  } finally {
    state.isGenerating = false;
    renderControls();
  }
}

async function pollGenerationResult(jobId) {
  let last = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await sleep(1500);
    const result = await fetchJson(`/api/v1/jobs/${encodeURIComponent(jobId)}/result?format=url`);
    last = result;
    const status = result.job?.status;
    if (status !== 'queued' && status !== 'running') return result;
    setStatus(`Generation ${status}; polling job ${jobId}...`);
  }
  return last || fetchJson(`/api/v1/jobs/${encodeURIComponent(jobId)}/result?format=url`);
}

function addJobToTop(job) {
  if (!job) return;
  const current = state.imageJobs?.jobs || state.imageJobs?.items || [];
  const deduped = current.filter((item) => item.id !== job.id);
  const nextJobs = [job, ...deduped].slice(0, state.galleryLimit);
  state.imageJobs = {
    ...(state.imageJobs || {}),
    ok: true,
    jobs: nextJobs,
    items: nextJobs,
    totalItems: Math.max(Number(state.imageJobs?.totalItems || 0), nextJobs.length),
    page: 1,
    pageSize: state.galleryLimit
  };
  renderGallery();
}

function defaultFavoriteTitle(job) {
  return previewText(jobPrompt(job), 90) || `Image job ${job?.id || 'favorite'}`;
}

async function saveFavoriteFromJob(job) {
  const artifact = firstArtifact(job);
  const payload = jobRequestPayload(job);
  if (!isPlainObject(payload) || !payload.prompt) {
    setStatus('This job does not have a usable prompt payload to save.', false);
    return;
  }
  const title = window.prompt('Save image favorite as:', defaultFavoriteTitle(job));
  if (title === null) {
    setStatus('Save favorite canceled.', false);
    return;
  }
  const body = {
    title: title.trim() || defaultFavoriteTitle(job),
    request_payload: payload,
    image_url: artifact?.url || firstImageUrl(job) || undefined,
    artifact_id: artifact?.id || undefined,
    job_id: job?.id || undefined,
    artifact: artifact || undefined,
    job
  };
  await fetchJson('/api/v1/image-favorites', { method: 'POST', body: JSON.stringify(body) });
  await refreshFavoritesOnly('Saved image favorite with artifact reference and full request payload.');
}

function findGalleryJob(button) {
  const jobs = currentJobs();
  const index = Number(button.dataset.jobIndex);
  if (Number.isInteger(index) && jobs[index]) return jobs[index];
  const card = button.closest('[data-job-id]');
  const jobId = card?.dataset.jobId;
  return jobs.find((job) => String(job.id || '') === jobId) || null;
}

async function handleGalleryClick(event) {
  const button = event.target.closest('[data-gallery-action]');
  if (!button || button.disabled) return;
  const job = findGalleryJob(button);
  if (!job) {
    setStatus('Unable to find that gallery job in the current list.', false);
    return;
  }
  const action = button.dataset.galleryAction;
  try {
    if (action === 'save-favorite') {
      await saveFavoriteFromJob(job);
      return;
    }
    if (action === 'load-settings') {
      const warnings = applyGenerationPayloadToControls(jobRequestPayload(job));
      const warningText = warnings.length ? ` Some fields need attention: ${warnings.join(', ')}.` : '';
      setStatus(`Loaded job settings into the controls.${warningText}`, warnings.length === 0);
      return;
    }
    if (action === 'copy-payload') {
      await navigator.clipboard.writeText(JSON.stringify(jobRequestPayload(job), null, 2));
      setStatus('Copied full request payload to clipboard.');
    }
  } catch (error) {
    setStatus(error.message, false);
  }
}

function favoriteById(id) {
  return (state.imageFavorites?.favorites || []).find((favorite) => String(favorite.id || '') === id) || null;
}

async function handleFavoriteClick(event) {
  const button = event.target.closest('[data-favorite-action]');
  if (!button || button.disabled) return;
  const card = button.closest('[data-favorite-id]');
  const favoriteId = card?.dataset.favoriteId;
  if (!favoriteId) return;
  const summary = favoriteById(favoriteId);
  const action = button.dataset.favoriteAction;
  try {
    if (action === 'load') {
      const response = await fetchJson(`/api/v1/image-favorites/${encodeURIComponent(favoriteId)}`);
      const favorite = response.favorite;
      const warnings = applyGenerationPayloadToControls(favorite?.requestPayload || {});
      const model = selectedModel();
      if (model && warnings.every((warning) => !warning.startsWith('model '))) {
        await prewarmSelectedModel();
      }
      const warningText = warnings.length ? ` Restored what I could; check: ${warnings.join(', ')}.` : '';
      setStatus(`Loaded favorite "${favorite?.title || summary?.title || favoriteId}" into controls. It was not submitted.${warningText}`, warnings.length === 0);
      return;
    }
    if (action === 'delete') {
      const ok = window.confirm(`Delete image favorite "${summary?.title || favoriteId}"?`);
      if (!ok) return;
      await fetchJson(`/api/v1/image-favorites/${encodeURIComponent(favoriteId)}`, { method: 'DELETE' });
      await refreshFavoritesOnly('Deleted image favorite.');
    }
  } catch (error) {
    setStatus(error.message, false);
  }
}

function wireEvents() {
  $('#image-lab-refresh')?.addEventListener('click', () => refreshAll('Image generator refreshed.'));
  $('#image-lab-form')?.addEventListener('submit', handleGenerate);
  $('#image-lab-refresh-favorites')?.addEventListener('click', () => refreshFavoritesOnly('Image favorites refreshed.'));
  $('#image-lab-gallery')?.addEventListener('click', handleGalleryClick);
  $('#image-lab-favorites')?.addEventListener('click', handleFavoriteClick);
  $('#image-lab-load-more')?.addEventListener('click', async () => {
    state.galleryLimit = Math.min(MAX_GALLERY_LIMIT, state.galleryLimit + GALLERY_LIMIT_STEP);
    await refreshGalleryOnly(`Showing up to ${state.galleryLimit} newest history items.`);
  });
  $('#image-lab-model')?.addEventListener('change', async () => {
    updatePayloadPreview();
    if (selectedModel()) await prewarmSelectedModel();
  });
  $('#image-lab-gallery-size')?.addEventListener('input', (event) => {
    state.galleryTileSize = Number(event.target.value) || DEFAULT_TILE_SIZE;
    window.localStorage.setItem('local-ai-images-gallery-size', String(state.galleryTileSize));
    const label = $('#image-lab-gallery-size-value');
    if (label) label.textContent = `${state.galleryTileSize}px`;
    document.documentElement.style.setProperty('--image-lab-gallery-size', `${state.galleryTileSize}px`);
  });
  for (const selector of ['#image-lab-prompt', '#image-lab-negative', '#image-lab-width', '#image-lab-height', '#image-lab-steps', '#image-lab-cfg', '#image-lab-seed', '#image-lab-sampler', '#image-lab-scheduler', '#image-lab-sync-timeout']) {
    const element = $(selector);
    element?.addEventListener('input', updatePayloadPreview);
    element?.addEventListener('change', updatePayloadPreview);
  }
}

wireEvents();
refreshAll();
