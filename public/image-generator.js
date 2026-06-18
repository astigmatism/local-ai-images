const $ = (selector) => document.querySelector(selector);

const DEFAULT_GALLERY_LIMIT = 48;
const MAX_GALLERY_LIMIT = 250;
const GALLERY_LIMIT_STEP = 48;
const DEFAULT_TILE_SIZE = 300;
const GALLERY_SIZE_STORAGE_KEY = 'local-ai-images-gallery-size';
const CONTROLS_HEIGHT_STORAGE_KEY = 'local-ai-images-controls-height';
const CONTROLS_MIN_HEIGHT = 220;
const CONTROLS_DEFAULT_HEIGHT = 320;
const CONTROLS_MAX_VIEWPORT_RATIO = 0.58;
const GENERATION_POLL_INTERVAL_MS = 1500;
const GENERATION_POLL_ATTEMPTS = 1200;
const GENERATION_POLL_FAILURE_LIMIT = 5;

const state = {
  imageHealth: null,
  imageModels: null,
  imageWorkflows: null,
  selectedWorkflowId: null,
  imageJobs: null,
  imageFavorites: null,
  imageError: null,
  activeJobId: null,
  pendingJobs: [],
  nextClientJobSequence: 0,
  prewarmingModel: null,
  loadedFavoritePayloadBase: null,
  galleryLimit: DEFAULT_GALLERY_LIMIT,
  galleryTileSize: readStoredGallerySize(),
  controlsHeight: readStoredControlsHeight(),
  lastResult: null
};

const thumbnailObjectUrls = new Map();

function readStoredGallerySize() {
  const raw = window.localStorage.getItem(GALLERY_SIZE_STORAGE_KEY);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 160 && parsed <= 620 ? parsed : DEFAULT_TILE_SIZE;
}

function readStoredControlsHeight() {
  const raw = window.localStorage.getItem(CONTROLS_HEIGHT_STORAGE_KEY);
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function controlsHeightBounds() {
  const viewportHeight = Math.max(window.innerHeight || 800, 320);
  const min = Math.min(CONTROLS_MIN_HEIGHT, Math.max(190, viewportHeight - 260));
  const max = Math.max(min, Math.floor(viewportHeight * CONTROLS_MAX_VIEWPORT_RATIO));
  const defaultHeight = clampNumber(Math.min(CONTROLS_DEFAULT_HEIGHT, Math.floor(viewportHeight * 0.38)), min, max);
  return { min, max, defaultHeight };
}

function normalizedControlsHeight(height = state.controlsHeight) {
  const { min, max, defaultHeight } = controlsHeightBounds();
  const candidate = Number.isFinite(Number(height)) ? Number(height) : defaultHeight;
  return clampNumber(candidate, min, max);
}

function applyControlsHeight(height = state.controlsHeight, persist = false) {
  const controls = $('.image-lab-controls');
  const handle = $('#image-lab-controls-resize');
  const { min, max } = controlsHeightBounds();
  const nextHeight = normalizedControlsHeight(height);
  state.controlsHeight = nextHeight;
  if (controls) controls.style.setProperty('--image-lab-controls-height', `${nextHeight}px`);
  if (handle) {
    handle.setAttribute('aria-valuemin', String(min));
    handle.setAttribute('aria-valuemax', String(max));
    handle.setAttribute('aria-valuenow', String(nextHeight));
  }
  if (persist) window.localStorage.setItem(CONTROLS_HEIGHT_STORAGE_KEY, String(nextHeight));
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
    generateButton.disabled = Boolean(state.prewarmingModel);
    generateButton.textContent = 'Generate!';
  }
  applyControlsHeight();
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

function makeClientJobId() {
  const random = window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `pending-${random}`;
}

function requestFromPayload(payload) {
  return {
    prompt: payloadString(payload, ['prompt', 'positive_prompt', 'positivePrompt']),
    negativePrompt: payloadString(payload, ['negative_prompt', 'negativePrompt']),
    model: payloadString(payload, ['model', 'checkpoint', 'checkpoint_name', 'checkpointName']) || null,
    workflowId: payloadString(payload, ['workflow_id', 'workflowId']),
    width: payloadNumber(payload, ['width']),
    height: payloadNumber(payload, ['height']),
    steps: payloadNumber(payload, ['steps']),
    cfgScale: payloadNumber(payload, ['cfg_scale', 'cfgScale', 'guidance_scale', 'guidanceScale']),
    seed: payloadSeed(payload),
    samplerName: payloadString(payload, ['sampler_name', 'samplerName', 'sampler']),
    scheduler: payloadString(payload, ['scheduler']),
    output: payloadString(payload, ['output', 'output_delivery', 'outputDelivery']) || 'url',
    syncTimeoutMs: payloadNumber(payload, ['sync_timeout_ms', 'syncTimeoutMs']),
    metadata: isPlainObject(payload?.metadata) ? clonePayload(payload.metadata) : {}
  };
}

function createPendingJob(payload) {
  const requestPayload = clonePayload(payload);
  const request = requestFromPayload(requestPayload);
  const now = new Date().toISOString();
  const clientId = makeClientJobId();
  state.nextClientJobSequence += 1;
  return {
    id: clientId,
    clientId,
    clientSequence: state.nextClientJobSequence,
    isClientPending: true,
    clientStatus: 'Submitting...',
    status: 'queued',
    createdAt: now,
    queuedAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    provider: 'pending',
    providerJobId: null,
    workflowId: request.workflowId || requestPayload.workflow_id || requestPayload.workflowId || '',
    model: request.model,
    prompt: request.prompt,
    negativePrompt: request.negativePrompt,
    seed: request.seed,
    width: request.width,
    height: request.height,
    steps: request.steps,
    cfgScale: request.cfgScale,
    samplerName: request.samplerName,
    scheduler: request.scheduler,
    output: request.output,
    artifacts: [],
    thumbnailUrl: null,
    request,
    requestPayload,
    metadata: { clientStatus: 'Submitting...' },
    timings: {},
    error: null
  };
}

function addPendingJob(job) {
  state.pendingJobs = [job, ...state.pendingJobs.filter((item) => item.clientId !== job.clientId && item.id !== job.id)];
  renderGallery();
}

function mergeJobUpdate(localJob, jobUpdate, extras = {}) {
  const update = isPlainObject(jobUpdate) ? jobUpdate : {};
  const nextMetadata = {
    ...(isPlainObject(localJob.metadata) ? localJob.metadata : {}),
    ...(isPlainObject(update.metadata) ? update.metadata : {}),
    ...(isPlainObject(extras.metadata) ? extras.metadata : {})
  };
  return {
    ...localJob,
    ...update,
    ...extras,
    id: update.id || localJob.id,
    clientId: localJob.clientId,
    clientSequence: localJob.clientSequence,
    isClientPending: localJob.isClientPending && !['succeeded', 'failed', 'canceled'].includes(update.status || extras.status || ''),
    requestPayload: localJob.requestPayload || update.requestPayload || update.request_payload || {},
    request: update.request || localJob.request || {},
    metadata: nextMetadata,
    updatedAt: update.updatedAt || extras.updatedAt || new Date().toISOString()
  };
}

function updatePendingJob(clientId, jobUpdate, extras = {}) {
  let didUpdate = false;
  const updateId = jobUpdate?.id ? String(jobUpdate.id) : '';
  state.pendingJobs = state.pendingJobs.map((job) => {
    const matchesClient = job.clientId === clientId || job.id === clientId;
    const matchesBackendId = updateId && String(job.id || '') === updateId;
    if (!matchesClient && !matchesBackendId) return job;
    didUpdate = true;
    return mergeJobUpdate(job, jobUpdate, extras);
  });
  if (!didUpdate && isPlainObject(jobUpdate)) {
    state.pendingJobs = [mergeJobUpdate(createPendingJob(jobRequestPayload(jobUpdate)), jobUpdate, extras), ...state.pendingJobs];
  }
  renderGallery();
}

function markPendingJobFailed(clientId, error, jobUpdate = null) {
  const bodyError = error?.body?.error;
  const message = bodyError?.message || error?.message || 'Generation failed.';
  const code = bodyError?.code || (error?.status === 429 ? 'IMAGE_QUEUE_LIMIT_REACHED' : 'IMAGE_GENERATION_FAILED');
  updatePendingJob(clientId, jobUpdate || {}, {
    status: 'failed',
    isClientPending: false,
    completedAt: new Date().toISOString(),
    error: { code, message, ...(bodyError?.details === undefined ? {} : { details: bodyError.details }) },
    metadata: { clientStatus: 'Failed' }
  });
  return message;
}

function pendingJobsById() {
  const jobs = state.pendingJobs || [];
  const byId = new Map();
  for (const job of jobs) {
    const key = String(job.id || job.clientId || '');
    if (key && !byId.has(key)) byId.set(key, job);
  }
  return byId;
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
  const remoteJobs = state.imageJobs?.jobs || state.imageJobs?.items || [];
  const jobsById = new Map();
  for (const job of state.pendingJobs || []) {
    const key = String(job.id || job.clientId || '');
    if (key) jobsById.set(key, job);
  }
  for (const job of remoteJobs) {
    const key = String(job?.id || '');
    if (!key || jobsById.has(key)) continue;
    jobsById.set(key, job);
  }
  return [...jobsById.values()].sort((a, b) => {
    const bDate = gallerySortTimestamp(b);
    const aDate = gallerySortTimestamp(a);
    if (bDate !== aDate) return bDate - aDate;
    return Number(b.clientSequence || 0) - Number(a.clientSequence || 0);
  });
}

function gallerySortTimestamp(job) {
  const timestamp = job?.clientId
    ? job.createdAt || job.queuedAt || job.updatedAt
    : job.completedAt || job.updatedAt || job.createdAt || job.queuedAt;
  const parsed = new Date(timestamp || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function renderGallery() {
  const target = $('#image-lab-gallery');
  const count = $('#image-lab-gallery-count');
  const loadMore = $('#image-lab-load-more');
  if (!target) return;
  document.documentElement.style.setProperty('--image-lab-gallery-size', `${state.galleryTileSize}px`);
  const jobs = currentJobs();
  if (count) {
    const remoteJobs = state.imageJobs?.jobs || state.imageJobs?.items || [];
    const remoteIds = new Set(remoteJobs.map((job) => String(job?.id || '')).filter(Boolean));
    const localOnlyCount = (state.pendingJobs || []).filter((job) => !remoteIds.has(String(job.id || ''))).length;
    const total = state.imageJobs?.totalItems;
    const adjustedTotal = total === undefined ? undefined : Math.max(Number(total) + localOnlyCount, jobs.length);
    count.textContent = adjustedTotal === undefined ? `${jobs.length} shown` : `${jobs.length} of ${adjustedTotal} shown`;
  }
  if (loadMore) {
    const hasNext = Boolean(state.imageJobs?.hasNextPage) && state.galleryLimit < MAX_GALLERY_LIMIT;
    loadMore.disabled = !hasNext;
    loadMore.hidden = jobs.length === 0;
  }
  if (!state.imageJobs && jobs.length === 0) {
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

function statusTone(status) {
  if (status === 'succeeded') return 'ok';
  if (status === 'failed' || status === 'canceled') return 'bad';
  if (status === 'queued' || status === 'running') return 'warn';
  return 'warn';
}

function numericDimension(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function galleryFrameStyle(job, payload) {
  const width = numericDimension(job.width ?? job.request?.width ?? payload.width);
  const height = numericDimension(job.height ?? job.request?.height ?? payload.height);
  return width && height ? ` style="aspect-ratio: ${width} / ${height}"` : '';
}

function pendingMessage(job) {
  const clientStatus = job.clientStatus || job.metadata?.clientStatus || '';
  if (job.status === 'running') return 'Generating...';
  if (job.status === 'queued') return clientStatus === 'Submitting...' ? 'Submitting...' : 'Queued...';
  if (job.status === 'failed') return 'Generation failed';
  if (job.status === 'canceled') return 'Generation canceled';
  return clientStatus || 'Image loading...';
}

function renderGalleryImageContent(job, imageUrl, prompt, jobId, dimensions) {
  const status = job.status || 'unknown';
  if (imageUrl) {
    return `<a class="gallery-image-link" href="${escapeHtml(imageUrl)}" target="_blank" rel="noopener"><img class="gallery-image" data-artifact-url="${escapeHtml(imageUrl)}" alt="Generated image: ${escapeHtml(previewText(prompt, 90) || jobId)}" loading="lazy" hidden><div class="thumb-placeholder">Image loading...</div></a>`;
  }
  if (status === 'queued' || status === 'running' || job.isClientPending) {
    return `<div class="thumb-placeholder image-lab-pending-placeholder"><span class="image-lab-placeholder-title">${escapeHtml(pendingMessage(job))}</span><span>${statusPill(status, statusTone(status))}</span><span class="image-lab-placeholder-subtitle">${escapeHtml(dimensions)} preview space reserved for this request.</span></div>`;
  }
  if (status === 'failed' || status === 'canceled') {
    const message = job.error?.message || `Job finished with status ${status}.`;
    return `<div class="thumb-placeholder image-lab-error-placeholder"><span class="image-lab-placeholder-title">${escapeHtml(pendingMessage(job))}</span><span class="image-lab-placeholder-subtitle">${escapeHtml(message)}</span></div>`;
  }
  return '<div class="thumb-placeholder">No image artifact available</div>';
}

function renderGalleryCard(job, index) {
  const artifact = firstArtifact(job);
  const imageUrl = firstImageUrl(job);
  const prompt = jobPrompt(job);
  const negative = jobNegativePrompt(job);
  const payload = jobRequestPayload(job);
  const favorite = favoriteForJob(job);
  const jobId = job?.id || `job-${index + 1}`;
  const status = job.status || 'unknown';
  const tone = statusTone(status);
  const dimensions = `${job.width ?? job.request?.width ?? payload.width ?? 'n/a'} x ${job.height ?? job.request?.height ?? payload.height ?? 'n/a'}`;
  const seed = job.seed ?? job.request?.seed ?? payload.seed ?? 'n/a';
  const model = job.model || payload.model || 'model n/a';
  const canSaveFavorite = Boolean(imageUrl) && status === 'succeeded';
  const saveFavoriteDisabled = favorite || !canSaveFavorite;
  const favoriteTitle = canSaveFavorite ? '' : ' title="A completed image artifact is required before saving a favorite."';
  const cardClasses = ['image-lab-gallery-card'];
  if (status === 'queued' || status === 'running' || job.isClientPending) cardClasses.push('is-pending');
  if (status === 'failed' || status === 'canceled') cardClasses.push('is-failed');
  const requestDetails = {
    jobId,
    clientId: job.clientId || undefined,
    resultUrl: job.resultUrl || job.result_url || undefined,
    statusUrl: job.statusUrl || job.status_url || undefined,
    requestPayload: payload,
    request: job.request || {},
    metadata: job.metadata || {},
    artifacts: jobArtifacts(job)
  };
  return `<article class="${cardClasses.join(' ')}" data-job-index="${escapeHtml(index)}" data-job-id="${escapeHtml(jobId)}" data-job-state="${escapeHtml(status)}">
    <div class="image-lab-image-frame"${galleryFrameStyle(job, payload)}>
      ${renderGalleryImageContent(job, imageUrl, prompt, jobId, dimensions)}
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
          <button type="button" class="secondary" data-gallery-action="save-favorite" data-job-index="${escapeHtml(index)}" ${saveFavoriteDisabled ? 'disabled' : ''}${favoriteTitle}>${favorite ? 'Saved favorite' : 'Save Favorite'}</button>
        </div>
        <div class="compact-meta job-meta">
          <p class="compact-meta-line"><span><strong>Status:</strong> ${statusPill(status, tone)}</span><span><strong>Job:</strong> <code>${escapeHtml(jobId)}</code></span>${job.clientId && job.clientId !== jobId ? `<span><strong>Client:</strong> <code>${escapeHtml(job.clientId)}</code></span>` : ''}</p>
          <p class="compact-meta-line"><span><strong>Workflow:</strong> ${escapeHtml(job.workflowId || payload.workflow_id || 'n/a')}</span><span><strong>Provider:</strong> ${escapeHtml(job.provider || 'n/a')}</span><span><strong>Created:</strong> ${escapeHtml(formatDate(job.createdAt))}</span><span><strong>Completed:</strong> ${escapeHtml(formatDate(job.completedAt))}</span></p>
          <p class="compact-meta-line"><span><strong>Steps:</strong> ${escapeHtml(job.steps ?? payload.steps ?? 'n/a')}</span><span><strong>CFG:</strong> ${escapeHtml(job.cfgScale ?? payload.cfg_scale ?? 'n/a')}</span><span><strong>Sampler:</strong> ${escapeHtml(job.samplerName ?? payload.sampler_name ?? 'n/a')}</span><span><strong>Scheduler:</strong> ${escapeHtml(job.scheduler ?? payload.scheduler ?? 'n/a')}</span></p>
          <p class="compact-meta-line"><span><strong>Queue wait:</strong> ${escapeHtml(formatDurationMs(job.queueWaitMs ?? job.timings?.queueWaitMs))}</span><span><strong>Total:</strong> ${escapeHtml(formatDurationMs(job.totalMs ?? job.timings?.totalMs))}</span><span><strong>Execution:</strong> ${escapeHtml(formatDurationMs(job.executionMs ?? job.timings?.executionMs))}</span><span><strong>Artifact:</strong> ${escapeHtml(artifact?.id || 'n/a')}</span></p>
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

function statusLabelForJob(job) {
  if (!job?.status) return 'Submitted';
  if (job.status === 'queued') return 'Queued...';
  if (job.status === 'running') return 'Generating...';
  if (job.status === 'succeeded') return 'Completed';
  if (job.status === 'failed') return 'Failed';
  if (job.status === 'canceled') return 'Canceled';
  return String(job.status);
}

function resultExtras(result, job) {
  const clientStatus = statusLabelForJob(job);
  return {
    clientStatus,
    resultUrl: result?.result_url || result?.resultUrl || undefined,
    statusUrl: result?.status_url || result?.statusUrl || undefined,
    metadata: {
      clientStatus,
      resultUrl: result?.result_url || result?.resultUrl || undefined,
      statusUrl: result?.status_url || result?.statusUrl || undefined
    }
  };
}

function errorJob(error) {
  return isPlainObject(error?.body?.job) ? error.body.job : null;
}

function generationSettingsStillMatch(submittedPayload) {
  const currentPayload = buildGenerationPayload();
  const keys = ['prompt', 'negative_prompt', 'workflow_id', 'model', 'width', 'height', 'steps', 'cfg_scale', 'seed', 'sampler_name', 'scheduler'];
  return keys.every((key) => String(submittedPayload[key] ?? '') === String(currentPayload[key] ?? ''));
}

function maybeApplyCompletedSeed(submittedPayload, job) {
  const seed = job?.seed ?? job?.request?.seed;
  if (seed === null || seed === undefined || Number(seed) < 0) return;
  if (!generationSettingsStillMatch(submittedPayload)) return;
  const seedInput = $('#image-lab-seed');
  if (seedInput) seedInput.value = String(seed);
  updatePayloadPreview();
}

async function finalizeGenerationResult(clientId, submittedPayload, result) {
  const job = result?.job || null;
  if (!job) throw new Error('The generation response did not include a job record.');
  updatePendingJob(clientId, job, resultExtras(result, job));

  if (job.status && job.status !== 'succeeded') {
    const error = new Error(job.error?.message || `Generation finished with status ${job.status}.`);
    error.body = { job, error: job.error };
    throw error;
  }

  state.lastResult = result;
  renderLastResult();
  maybeApplyCompletedSeed(submittedPayload, job);
  await Promise.allSettled([refreshGalleryOnly(), refreshModelsOnly()]);
  const seed = job.seed ?? job.request?.seed ?? 'n/a';
  setStatus(`Generation complete for job ${job.id || 'n/a'}. Actual seed: ${seed}.`);
}

async function submitGenerationJob(clientId, payload) {
  try {
    let result = await fetchJson('/api/v1/generate', { method: 'POST', body: JSON.stringify(payload) });
    let job = result.job || null;
    if (job) {
      state.activeJobId = job.id || state.activeJobId;
      updatePendingJob(clientId, job, resultExtras(result, job));
    }

    if (job?.id && ['queued', 'running'].includes(job.status)) {
      setStatus(`Generation ${job.status}; job ${job.id} is being tracked in the gallery.`);
      result = await pollGenerationResult(job.id, clientId);
      job = result.job || job;
    }

    await finalizeGenerationResult(clientId, payload, result);
  } catch (error) {
    const job = errorJob(error);
    const message = markPendingJobFailed(clientId, error, job);
    const target = $('#image-lab-last-result');
    if (target) target.innerHTML = `<p class="danger-text">${escapeHtml(message)}</p>`;
    const prefix = error?.status === 429 ? 'Generation queue limit reached' : 'Generation failed';
    setStatus(`${prefix}: ${message}`, false);
  } finally {
    renderControls();
  }
}

async function handleGenerate(event) {
  event.preventDefault();
  if (state.prewarmingModel) {
    setStatus('Model prewarming is still running. Submit again once the checkpoint is ready.', false);
    return;
  }
  const payload = buildGenerationPayload();
  if (!payload.model) {
    setStatus('Choose a checkpoint before generating.', false);
    return;
  }
  if (!payload.prompt) {
    setStatus('Positive prompt is required.', false);
    return;
  }

  const pendingJob = createPendingJob(payload);
  addPendingJob(pendingJob);
  setStatus(`Queued generation request ${pendingJob.clientSequence}. A pending gallery card was added.`);
  void submitGenerationJob(pendingJob.clientId, payload);
  renderControls();
}

async function pollGenerationResult(jobId, clientId) {
  let last = null;
  let consecutiveFailures = 0;
  for (let attempt = 0; attempt < GENERATION_POLL_ATTEMPTS; attempt += 1) {
    await sleep(GENERATION_POLL_INTERVAL_MS);
    try {
      const result = await fetchJson(`/api/v1/jobs/${encodeURIComponent(jobId)}/result?format=url`);
      consecutiveFailures = 0;
      last = result;
      const job = result.job || null;
      if (job) updatePendingJob(clientId, job, resultExtras(result, job));
      const status = job?.status;
      if (status !== 'queued' && status !== 'running') return result;
      setStatus(`Generation ${status}; polling job ${jobId}...`);
    } catch (error) {
      const job = errorJob(error);
      if (job) {
        updatePendingJob(clientId, job, resultExtras(error.body || {}, job));
        throw error;
      }
      consecutiveFailures += 1;
      updatePendingJob(clientId, {}, {
        metadata: { clientStatus: `Status refresh failed; retry ${consecutiveFailures}/${GENERATION_POLL_FAILURE_LIMIT}` }
      });
      setStatus(`Status refresh failed for job ${jobId}; retrying...`, false);
      if (consecutiveFailures >= GENERATION_POLL_FAILURE_LIMIT) throw error;
    }
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
  if (!artifact?.url && !firstImageUrl(job)) {
    setStatus('Wait until the generated image artifact is available before saving a favorite.', false);
    return;
  }
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

function initResizableControls() {
  const handle = $('#image-lab-controls-resize');
  const controls = $('.image-lab-controls');
  if (!handle || !controls) return;
  applyControlsHeight();

  let dragStartY = 0;
  let dragStartHeight = 0;
  let isDragging = false;

  const finishDrag = (event) => {
    if (!isDragging) return;
    isDragging = false;
    document.body.classList.remove('image-lab-resizing');
    try {
      handle.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be released if the drag ended outside the handle.
    }
    applyControlsHeight(state.controlsHeight, true);
  };

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    isDragging = true;
    dragStartY = event.clientY;
    dragStartHeight = normalizedControlsHeight();
    document.body.classList.add('image-lab-resizing');
    handle.setPointerCapture(event.pointerId);
  });

  handle.addEventListener('pointermove', (event) => {
    if (!isDragging) return;
    event.preventDefault();
    applyControlsHeight(dragStartHeight + event.clientY - dragStartY);
  });

  handle.addEventListener('pointerup', finishDrag);
  handle.addEventListener('pointercancel', finishDrag);
  handle.addEventListener('lostpointercapture', () => {
    if (!isDragging) return;
    isDragging = false;
    document.body.classList.remove('image-lab-resizing');
    applyControlsHeight(state.controlsHeight, true);
  });

  handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 40 : 16;
    let nextHeight = null;
    if (event.key === 'ArrowUp') nextHeight = normalizedControlsHeight() - step;
    if (event.key === 'ArrowDown') nextHeight = normalizedControlsHeight() + step;
    if (event.key === 'PageUp') nextHeight = normalizedControlsHeight() - 80;
    if (event.key === 'PageDown') nextHeight = normalizedControlsHeight() + 80;
    if (event.key === 'Home') nextHeight = controlsHeightBounds().min;
    if (event.key === 'End') nextHeight = controlsHeightBounds().max;
    if (nextHeight === null) return;
    event.preventDefault();
    applyControlsHeight(nextHeight, true);
  });

  window.addEventListener('resize', () => applyControlsHeight());
}

function wireEvents() {
  initResizableControls();
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
    window.localStorage.setItem(GALLERY_SIZE_STORAGE_KEY, String(state.galleryTileSize));
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
