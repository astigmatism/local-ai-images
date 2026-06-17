const $ = (selector) => document.querySelector(selector);

const API_KEY_STORAGE_KEY = 'local-ai-images-api-key';
const GALLERY_SIZE_STORAGE_KEY = 'local-ai-images-generator-gallery-size';
const DEFAULT_GALLERY_TILE_SIZE = 360;
const MAX_GALLERY_JOBS = 80;

const state = {
  imageApiKey: window.localStorage.getItem(API_KEY_STORAGE_KEY) || '',
  imageHealth: null,
  imageModels: null,
  imageWorkflows: null,
  imageJobs: null,
  imageFavorites: null,
  imageError: null,
  activeJobId: null,
  generating: false,
  prewarming: false,
  loadedPayloadBase: null,
  renderedJobs: [],
  gallerySize: Number(window.localStorage.getItem(GALLERY_SIZE_STORAGE_KEY)) || DEFAULT_GALLERY_TILE_SIZE,
  lastMessage: null
};

const thumbnailObjectUrls = new Map();
const observedImages = new WeakSet();
const thumbnailObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          thumbnailObserver.unobserve(entry.target);
          hydrateOneImage(entry.target);
        }
      }
    }, { rootMargin: '600px 0px' })
  : null;

async function fetchJson(url, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (url.startsWith('/api/v1') && state.imageApiKey) {
    headers.authorization = `Bearer ${state.imageApiKey}`;
  }
  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (error) {
      const message = `Expected JSON from ${url}, but received ${response.headers.get('content-type') || 'unknown content type'}.`;
      const parseError = new Error(message);
      parseError.status = response.status;
      parseError.bodyText = text.slice(0, 2000);
      throw parseError;
    }
  }
  if (!response.ok) {
    const message = body?.error?.message || body?.detail?.[0]?.msg || `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function fetchPossiblyJson(url, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (url.startsWith('/api/v1') && state.imageApiKey) {
    headers.authorization = `Bearer ${state.imageApiKey}`;
  }
  const response = await fetch(url, { ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const body = await response.json();
    if (!response.ok) {
      const message = body?.error?.message || body?.detail?.[0]?.msg || `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return { ok: true, binary: true, contentType };
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
  if (!isPlainObject(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function compactText(value, maxChars = 140) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function formatDate(value) {
  if (!value) return 'n/a';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatDurationMs(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  const ms = Number(value);
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} s`;
}

function readNumericInput(id, fallback = null) {
  const element = $(`#${id}`);
  if (!element || String(element.value).trim() === '') return fallback;
  const parsed = Number(element.value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readTextInput(id) {
  const element = $(`#${id}`);
  return element ? String(element.value || '').trim() : '';
}

function setControlValue(id, value) {
  const element = $(`#${id}`);
  if (!element || value === undefined || value === null) return;
  element.value = String(value);
}

function setFeedback(message, tone = '') {
  state.lastMessage = { message, tone };
  const target = $('#studio-feedback');
  if (!target) return;
  target.className = `feedback ${tone}`.trim();
  target.textContent = message || '';
}

function setGalleryStatus(message) {
  const target = $('#studio-gallery-status');
  if (target) target.textContent = message || '';
}

function statusPill(label, tone = '') {
  return `<span class="status-pill ${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

function imageApiAuthRequiredWithoutKey() {
  const auth = state.imageHealth?.auth;
  return Boolean(auth?.enabled && !state.imageApiKey);
}

function modelIdentifier(model) {
  return model?.comfyName || model?.fileName || model?.relativePath || model?.id || model?.name || '';
}

function normalizeModel(value) {
  return String(value || '').trim().replace(/\\/g, '/').toLowerCase();
}

function modelMatches(model, value) {
  const normalized = normalizeModel(value);
  if (!model || !normalized) return false;
  return [model.id, model.comfyName, model.fileName, model.relativePath, model.path, model.name, model.displayName]
    .filter(Boolean)
    .some((candidate) => normalizeModel(candidate) === normalized);
}

function checkpointModels() {
  return (state.imageModels?.models || []).filter((model) => model.type === 'checkpoint');
}

function selectedModelValue() {
  return $('#studio-model')?.value || '';
}

function selectedWorkflow() {
  const workflowId = $('#studio-workflow')?.value || state.imageWorkflows?.default_workflow_id || '';
  return (state.imageWorkflows?.workflows || []).find((workflow) => workflow.id === workflowId) || null;
}

function selectModelIfAvailable(value) {
  const select = $('#studio-model');
  if (!select || !value) return false;
  const model = checkpointModels().find((candidate) => modelMatches(candidate, value));
  if (!model) return false;
  select.value = modelIdentifier(model);
  return true;
}

function removeAliases(payload, keys) {
  for (const key of keys) delete payload[key];
}

function buildGenerationPayload() {
  const payload = clonePayload(state.loadedPayloadBase);
  const prompt = readTextInput('studio-prompt');
  const negative = readTextInput('studio-negative');
  const workflowId = $('#studio-workflow')?.value || state.imageWorkflows?.default_workflow_id || 'sdxl-text-to-image';
  const model = selectedModelValue();

  payload.prompt = prompt;
  if (negative) {
    payload.negative_prompt = negative;
  } else {
    removeAliases(payload, ['negative_prompt', 'negativePrompt']);
  }

  payload.workflow_id = workflowId;
  if (model) {
    payload.model = model;
  } else {
    delete payload.model;
  }

  const width = readNumericInput('studio-width');
  const height = readNumericInput('studio-height');
  const steps = readNumericInput('studio-steps');
  const cfgScale = readNumericInput('studio-cfg-scale');
  if (width !== null) payload.width = width;
  if (height !== null) payload.height = height;
  if (steps !== null) payload.steps = steps;
  if (cfgScale !== null) payload.cfg_scale = cfgScale;

  const randomSeed = $('#studio-random-seed')?.checked ?? true;
  const seedValue = readTextInput('studio-seed');
  if (randomSeed || seedValue === '') {
    payload.seed = -1;
  } else {
    const parsedSeed = Number(seedValue);
    payload.seed = Number.isFinite(parsedSeed) ? parsedSeed : seedValue;
  }

  const sampler = readTextInput('studio-sampler');
  const scheduler = readTextInput('studio-scheduler');
  if (sampler) payload.sampler_name = sampler;
  else removeAliases(payload, ['sampler_name', 'samplerName', 'sampler']);
  if (scheduler) payload.scheduler = scheduler;
  else delete payload.scheduler;

  payload.output = $('#studio-output')?.value || 'url';
  const syncTimeout = readNumericInput('studio-sync-timeout', 0);
  payload.sync_timeout_ms = syncTimeout ?? 0;

  const metadata = isPlainObject(payload.metadata) ? clonePayload(payload.metadata) : {};
  metadata.source = 'image-generator-portal';
  payload.metadata = metadata;

  return payload;
}

function payloadString(payload, keys) {
  if (!isPlainObject(payload)) return '';
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
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

function apiPayloadFromNormalizedRequest(request) {
  if (!isPlainObject(request)) return {};
  const payload = {};
  if (request.prompt) payload.prompt = request.prompt;
  if (request.negativePrompt) payload.negative_prompt = request.negativePrompt;
  if (request.model) payload.model = request.model;
  if (request.workflowId) payload.workflow_id = request.workflowId;
  if (Number.isFinite(Number(request.width))) payload.width = Number(request.width);
  if (Number.isFinite(Number(request.height))) payload.height = Number(request.height);
  if (Number.isFinite(Number(request.steps))) payload.steps = Number(request.steps);
  if (Number.isFinite(Number(request.cfgScale))) payload.cfg_scale = Number(request.cfgScale);
  if (Number.isFinite(Number(request.seed))) payload.seed = Number(request.seed);
  if (request.samplerName) payload.sampler_name = request.samplerName;
  if (request.scheduler) payload.scheduler = request.scheduler;
  if (request.output) payload.output = request.output;
  if (Number.isFinite(Number(request.syncTimeoutMs))) payload.sync_timeout_ms = Number(request.syncTimeoutMs);
  if (isPlainObject(request.metadata)) payload.metadata = clonePayload(request.metadata);
  return payload;
}

function jobPayload(job) {
  const payload = clonePayload(job?.requestPayload || job?.request_payload || apiPayloadFromNormalizedRequest(job?.request));
  if (!payload.prompt && job?.prompt) payload.prompt = job.prompt;
  const negative = job?.negativePrompt || job?.negative_prompt;
  if (!payload.negative_prompt && negative) payload.negative_prompt = negative;
  if (!payload.model && job?.model) payload.model = job.model;
  if (!payload.workflow_id && job?.workflowId) payload.workflow_id = job.workflowId;
  if (!payload.width && Number.isFinite(Number(job?.width))) payload.width = Number(job.width);
  if (!payload.height && Number.isFinite(Number(job?.height))) payload.height = Number(job.height);
  if (!payload.steps && Number.isFinite(Number(job?.steps))) payload.steps = Number(job.steps);
  if (!payload.cfg_scale && Number.isFinite(Number(job?.cfgScale))) payload.cfg_scale = Number(job.cfgScale);
  if (Number.isFinite(Number(job?.seed))) payload.seed = Number(job.seed);
  if (!payload.sampler_name && job?.samplerName) payload.sampler_name = job.samplerName;
  if (!payload.scheduler && job?.scheduler) payload.scheduler = job.scheduler;
  if (!payload.output && job?.output) payload.output = job.output;
  return payload;
}

function favoritePayload(favorite) {
  return clonePayload(favorite?.requestPayload || favorite?.request_payload || favorite?.payload || favorite?.request);
}

function defaultFavoriteTitleFromPayload(payload, fallback = 'Image favorite') {
  const prompt = payloadString(payload, ['prompt', 'positive_prompt', 'positivePrompt']);
  const compact = compactText(prompt, 90);
  return compact || fallback;
}

function updateRequestPreview() {
  const preview = $('#studio-request-preview');
  if (!preview) return;
  try {
    preview.textContent = JSON.stringify(buildGenerationPayload(), null, 2);
  } catch (error) {
    preview.textContent = `Unable to build preview: ${error.message}`;
  }
}

function applyWorkflowDefaults(force = false) {
  const workflow = selectedWorkflow();
  const defaults = workflow?.defaults || {};
  const setIfEmpty = (id, value) => {
    const element = $(`#${id}`);
    if (!element || value === undefined || value === null) return;
    if (force || String(element.value || '').trim() === '') element.value = String(value);
  };
  setIfEmpty('studio-width', defaults.width);
  setIfEmpty('studio-height', defaults.height);
  setIfEmpty('studio-steps', defaults.steps);
  setIfEmpty('studio-cfg-scale', defaults.cfgScale);
  setIfEmpty('studio-sampler', defaults.samplerName);
  setIfEmpty('studio-scheduler', defaults.scheduler);
  if (force && defaults.seed !== undefined) {
    setControlValue('studio-seed', defaults.seed);
    const randomSeed = $('#studio-random-seed');
    if (randomSeed) randomSeed.checked = Number(defaults.seed) === -1;
  }
}

function applyPayloadToControls(payload, options = {}) {
  if (!isPlainObject(payload)) {
    setFeedback('Favorite load failed: stored request payload is missing or invalid.', 'error');
    return;
  }
  state.loadedPayloadBase = clonePayload(payload);
  setControlValue('studio-prompt', payloadString(payload, ['prompt', 'positive_prompt', 'positivePrompt']));
  setControlValue('studio-negative', payloadString(payload, ['negative_prompt', 'negativePrompt']));

  const workflowId = payloadString(payload, ['workflow_id', 'workflowId', 'workflow']);
  if (workflowId && $('#studio-workflow')) {
    $('#studio-workflow').value = workflowId;
  }

  const model = payloadString(payload, ['model', 'checkpoint', 'checkpoint_name', 'checkpointName']);
  const modelFound = model ? selectModelIfAvailable(model) : true;
  if (model && !modelFound && $('#studio-model')) {
    const select = $('#studio-model');
    const option = document.createElement('option');
    option.value = model;
    option.textContent = `${model} (missing locally)`;
    option.dataset.missing = '1';
    select.appendChild(option);
    select.value = model;
  }

  const width = payloadNumber(payload, ['width']);
  const height = payloadNumber(payload, ['height']);
  const steps = payloadNumber(payload, ['steps']);
  const cfgScale = payloadNumber(payload, ['cfg_scale', 'cfgScale', 'guidance_scale', 'guidanceScale']);
  const syncTimeout = payloadNumber(payload, ['sync_timeout_ms', 'syncTimeoutMs']);
  if (width !== null) setControlValue('studio-width', width);
  if (height !== null) setControlValue('studio-height', height);
  if (steps !== null) setControlValue('studio-steps', steps);
  if (cfgScale !== null) setControlValue('studio-cfg-scale', cfgScale);
  if (syncTimeout !== null) setControlValue('studio-sync-timeout', syncTimeout);

  const seed = payloadSeed(payload);
  if (seed !== null) {
    setControlValue('studio-seed', seed);
    const randomSeed = $('#studio-random-seed');
    if (randomSeed) randomSeed.checked = Number(seed) === -1;
  } else {
    const randomSeed = $('#studio-random-seed');
    if (randomSeed) randomSeed.checked = true;
    setControlValue('studio-seed', '-1');
  }

  const sampler = payloadString(payload, ['sampler_name', 'samplerName', 'sampler']);
  const scheduler = payloadString(payload, ['scheduler']);
  const output = payloadString(payload, ['output']);
  if (sampler) setControlValue('studio-sampler', sampler);
  if (scheduler) setControlValue('studio-scheduler', scheduler);
  if (output && $('#studio-output')) $('#studio-output').value = output;

  updateRequestPreview();

  if (model && !modelFound) {
    setFeedback(`Loaded settings, but checkpoint "${model}" is not in the current local model list. Restore what you can or install/rescan that model.`, 'error');
    return;
  }
  if (options.silent !== true) {
    setFeedback(seed === null ? 'Loaded favorite settings. Seed was missing, so random seed is enabled.' : 'Loaded favorite settings. Click Generate when ready.', seed === null ? 'error' : 'ok');
  }
}

function renderAuth() {
  const input = $('#studio-api-key');
  if (input) input.value = state.imageApiKey;
  const auth = state.imageHealth?.auth;
  const target = $('#studio-auth-status');
  if (!target) return;
  if (!auth) {
    target.textContent = state.imageApiKey ? 'Browser key saved; auth status loading.' : 'Checking auth...';
    return;
  }
  if (!auth.enabled) {
    target.innerHTML = '<span class="status-pill ok">No API key needed</span>';
    return;
  }
  if (auth.configured_key_count === 0) {
    target.innerHTML = '<span class="status-pill bad">Auth misconfigured</span>';
    return;
  }
  target.innerHTML = state.imageApiKey
    ? '<span class="status-pill ok">Browser key saved</span>'
    : '<span class="status-pill warn">API key required</span>';
}

function renderModelControls() {
  const modelSelect = $('#studio-model');
  const workflowSelect = $('#studio-workflow');
  if (!modelSelect || !workflowSelect) return;

  const currentModel = modelSelect.value;
  const models = checkpointModels();
  if (!state.imageModels) {
    modelSelect.innerHTML = '<option value="">Loading checkpoints...</option>';
    modelSelect.disabled = true;
  } else if (!models.length) {
    modelSelect.innerHTML = '<option value="">No checkpoint models found</option>';
    modelSelect.disabled = true;
  } else {
    modelSelect.disabled = false;
    modelSelect.innerHTML = models.map((model) => {
      const value = modelIdentifier(model);
      const size = model.sizeBytes ? ` - ${(model.sizeBytes / 1024 / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 2 })} GiB` : '';
      return `<option value="${escapeHtml(value)}">${escapeHtml(model.displayName || model.fileName || value)}${escapeHtml(size)}</option>`;
    }).join('');
    if (currentModel && models.some((model) => modelMatches(model, currentModel))) modelSelect.value = currentModel;
    if (!modelSelect.value && models[0]) modelSelect.value = modelIdentifier(models[0]);
  }

  const currentWorkflow = workflowSelect.value;
  const workflows = state.imageWorkflows?.workflows || [];
  workflowSelect.innerHTML = workflows.length
    ? workflows.map((workflow) => `<option value="${escapeHtml(workflow.id)}">${escapeHtml(workflow.name || workflow.id)}</option>`).join('')
    : '<option value="sdxl-text-to-image">sdxl-text-to-image</option>';
  if (currentWorkflow && workflows.some((workflow) => workflow.id === currentWorkflow)) {
    workflowSelect.value = currentWorkflow;
  } else if (state.imageWorkflows?.default_workflow_id) {
    workflowSelect.value = state.imageWorkflows.default_workflow_id;
  }
  applyWorkflowDefaults(false);
  renderModelStatus();
}

function renderModelStatus() {
  const target = $('#studio-model-status');
  if (!target) return;
  if (imageApiAuthRequiredWithoutKey()) {
    target.textContent = 'Enter the dashboard API key to load checkpoint inventory.';
    return;
  }
  if (!state.imageModels) {
    target.textContent = state.imageError ? `Checkpoint list unavailable: ${state.imageError.message}` : 'Loading checkpoint list...';
    return;
  }
  const models = checkpointModels();
  const preload = state.imageModels?.preload || state.imageModels?.defaultStatus || state.imageHealth?.models?.preload;
  const loaded = preload?.lastConfirmedLoadedModel || preload?.lastPreloadModel || null;
  target.innerHTML = `${escapeHtml(models.length)} checkpoint model${models.length === 1 ? '' : 's'} available.${loaded ? ` Last confirmed loaded: <code>${escapeHtml(loaded)}</code>.` : ''}`;
}

function favoriteIdentitySet() {
  const identities = new Set();
  for (const favorite of state.imageFavorites?.favorites || []) {
    if (favorite.jobId) identities.add(`job:${favorite.jobId}`);
    if (favorite.artifactId) identities.add(`artifact:${favorite.artifactId}`);
    for (const artifact of favorite.artifacts || []) {
      if (artifact?.id) identities.add(`artifact:${artifact.id}`);
      if (artifact?.jobId) identities.add(`job:${artifact.jobId}`);
    }
  }
  return identities;
}

function jobArtifacts(job) {
  return Array.isArray(job?.artifacts) ? job.artifacts : [];
}

function firstArtifact(job) {
  return jobArtifacts(job).find((artifact) => artifact?.url) || null;
}

function firstArtifactUrl(job) {
  return job?.thumbnailUrl || firstArtifact(job)?.url || '';
}

function jobSavedAsFavorite(job, identities) {
  if (!job) return false;
  if (job.id && identities.has(`job:${job.id}`)) return true;
  return jobArtifacts(job).some((artifact) => artifact?.id && identities.has(`artifact:${artifact.id}`));
}

function renderCompactMetaLine(values) {
  const parts = values
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `<span><strong>${escapeHtml(key)}:</strong> ${escapeHtml(value)}</span>`);
  return parts.length ? `<p class="compact-meta-line">${parts.join('')}</p>` : '';
}

function renderGallery() {
  const gallery = $('#studio-gallery');
  if (!gallery) return;
  const jobs = (state.imageJobs?.jobs || state.imageJobs?.items || [])
    .slice()
    .sort((left, right) => String(right.completedAt || right.updatedAt || right.createdAt || '').localeCompare(String(left.completedAt || left.updatedAt || left.createdAt || '')))
    .slice(0, MAX_GALLERY_JOBS);

  if (imageApiAuthRequiredWithoutKey()) {
    gallery.className = 'studio-gallery placeholder';
    gallery.textContent = 'Enter the dashboard API key to load the gallery.';
    setGalleryStatus('API key required');
    return;
  }

  if (!state.imageJobs) {
    gallery.className = 'studio-gallery placeholder';
    gallery.textContent = state.imageError ? `Gallery failed to load: ${state.imageError.message}` : 'Loading generated images...';
    setGalleryStatus('Loading history...');
    return;
  }

  if (!jobs.length) {
    state.renderedJobs = [];
    gallery.className = 'studio-gallery placeholder';
    gallery.textContent = 'No generated images yet. Submit a generation to start the gallery.';
    setGalleryStatus('0 images');
    return;
  }

  state.renderedJobs = jobs;
  gallery.className = 'studio-gallery';
  gallery.style.setProperty('--studio-tile-size', `${state.gallerySize}px`);
  const identities = favoriteIdentitySet();
  gallery.innerHTML = jobs.map((job, index) => renderGalleryCard(job, index, identities)).join('');
  setGalleryStatus(`${jobs.length} newest image job${jobs.length === 1 ? '' : 's'} shown`);
  hydrateImages(gallery);
}

function renderGalleryCard(job, index, identities) {
  const payload = jobPayload(job);
  const artifact = firstArtifact(job);
  const imageUrl = firstArtifactUrl(job);
  const prompt = payloadString(payload, ['prompt', 'positive_prompt', 'positivePrompt']) || job?.prompt || '';
  const negative = payloadString(payload, ['negative_prompt', 'negativePrompt']) || job?.negativePrompt || '';
  const model = payloadString(payload, ['model']) || job?.model || 'model n/a';
  const seed = payloadSeed(payload) ?? job?.seed ?? 'n/a';
  const dimensions = `${payloadNumber(payload, ['width']) ?? job?.width ?? 'n/a'} x ${payloadNumber(payload, ['height']) ?? job?.height ?? 'n/a'}`;
  const status = job?.status || 'unknown';
  const statusTone = status === 'succeeded' ? 'ok' : status === 'failed' ? 'bad' : 'warn';
  const saved = jobSavedAsFavorite(job, identities);
  const jobId = job?.id || `job-${index + 1}`;
  const detailJson = {
    requestPayload: payload,
    request: job?.request || null,
    metadata: job?.metadata || null,
    artifacts: jobArtifacts(job),
    timings: job?.timings || {
      queueWaitMs: job?.queueWaitMs ?? null,
      executionMs: job?.executionMs ?? null,
      totalMs: job?.totalMs ?? null,
      secondsPerStep: job?.secondsPerStep ?? null,
      stepsPerSecond: job?.stepsPerSecond ?? null
    },
    job
  };
  return `<article class="studio-gallery-card" data-job-index="${escapeHtml(index)}" data-job-id="${escapeHtml(jobId)}">
    <div class="studio-card-image-frame">
      ${imageUrl ? `<a href="${escapeHtml(imageUrl)}" target="_blank" rel="noopener"><img class="studio-card-image" data-artifact-url="${escapeHtml(imageUrl)}" alt="Generated image: ${escapeHtml(compactText(prompt, 120))}" loading="lazy" hidden><div class="thumb-placeholder">Loading image...</div></a>` : '<div class="thumb-placeholder">No image artifact recorded</div>'}
    </div>
    <div class="studio-card-actions">
      <button type="button" class="secondary" data-gallery-action="load-settings" data-job-index="${escapeHtml(index)}">Reuse Settings</button>
      <button type="button" class="secondary" data-gallery-action="save-favorite" data-job-index="${escapeHtml(index)}" ${saved ? 'disabled' : ''}>${saved ? 'Saved Favorite' : 'Save Favorite'}</button>
    </div>
    <details class="studio-card-details">
      <summary>
        <span>${statusPill(status, statusTone)}</span>
        <strong>${escapeHtml(compactText(prompt, 96) || jobId)}</strong>
        ${renderCompactMetaLine([
          ['Model', compactText(model, 42)],
          ['Size', dimensions],
          ['Seed', seed],
          ['Done', formatDate(job?.completedAt || job?.updatedAt || job?.createdAt)]
        ])}
      </summary>
      <div class="studio-card-expanded">
        <h3>Generation details</h3>
        <dl class="kv">
          <dt>Job</dt><dd><code>${escapeHtml(jobId)}</code></dd>
          <dt>Model</dt><dd><code>${escapeHtml(model)}</code></dd>
          <dt>Workflow</dt><dd><code>${escapeHtml(payloadString(payload, ['workflow_id', 'workflowId']) || job?.workflowId || 'n/a')}</code></dd>
          <dt>Dimensions</dt><dd>${escapeHtml(dimensions)}</dd>
          <dt>Steps</dt><dd>${escapeHtml(payloadNumber(payload, ['steps']) ?? job?.steps ?? 'n/a')}</dd>
          <dt>CFG scale</dt><dd>${escapeHtml(payloadNumber(payload, ['cfg_scale', 'cfgScale']) ?? job?.cfgScale ?? 'n/a')}</dd>
          <dt>Sampler</dt><dd>${escapeHtml(payloadString(payload, ['sampler_name', 'samplerName', 'sampler']) || job?.samplerName || 'n/a')}</dd>
          <dt>Scheduler</dt><dd>${escapeHtml(payloadString(payload, ['scheduler']) || job?.scheduler || 'n/a')}</dd>
          <dt>Seed</dt><dd>${escapeHtml(seed)}</dd>
          <dt>Total time</dt><dd>${escapeHtml(formatDurationMs(job?.totalMs ?? job?.timings?.totalMs))}</dd>
          <dt>Artifact</dt><dd>${artifact?.id ? `<code>${escapeHtml(artifact.id)}</code>` : '<span class="muted">n/a</span>'}</dd>
        </dl>
        <h3>Positive prompt</h3>
        <p class="prompt-text bounded-prompt">${prompt ? escapeHtml(prompt) : '<span class="muted">No prompt recorded</span>'}</p>
        <h3>Negative prompt</h3>
        <p class="prompt-text bounded-prompt">${negative ? escapeHtml(negative) : '<span class="muted">No negative prompt recorded</span>'}</p>
        ${job?.error ? `<p class="danger-text">${escapeHtml(job.error.code || 'GENERATION_ERROR')}: ${escapeHtml(job.error.message || 'Generation failed')}</p>` : ''}
        <h3>Full request payload and job metadata</h3>
        <pre><code>${escapeHtml(JSON.stringify(detailJson, null, 2))}</code></pre>
      </div>
    </details>
  </article>`;
}

function renderFavorites() {
  const target = $('#studio-favorites');
  if (!target) return;
  if (imageApiAuthRequiredWithoutKey()) {
    target.className = 'studio-favorite-strip placeholder';
    target.textContent = 'Enter the dashboard API key to load favorites.';
    return;
  }
  if (!state.imageFavorites) {
    target.className = 'studio-favorite-strip placeholder';
    target.textContent = state.imageError ? `Favorites failed to load: ${state.imageError.message}` : 'Loading favorites...';
    return;
  }
  const favorites = state.imageFavorites.favorites || [];
  if (!favorites.length) {
    target.className = 'studio-favorite-strip placeholder';
    target.textContent = 'No saved image favorites yet. Save one from a generated gallery card.';
    return;
  }
  target.className = 'studio-favorite-strip';
  target.innerHTML = favorites.map((favorite) => renderFavoriteCard(favorite)).join('');
  hydrateImages(target);
}

function renderFavoriteCard(favorite) {
  const imageUrl = favorite.imageUrl || favorite.artifactUrl || favorite.artifact?.url || favorite.artifacts?.find((artifact) => artifact?.url)?.url || '';
  const title = favorite.title || favorite.promptPreview || 'Image favorite';
  const model = favorite.model || 'model n/a';
  const seed = favorite.seed ?? 'seed n/a';
  return `<article class="studio-favorite-card" data-favorite-id="${escapeHtml(favorite.id)}">
    <div class="studio-favorite-thumb">
      ${imageUrl ? `<img data-artifact-url="${escapeHtml(imageUrl)}" alt="Favorite image: ${escapeHtml(compactText(title, 90))}" loading="lazy" hidden><div class="thumb-placeholder small">Loading...</div>` : '<div class="thumb-placeholder small">No image</div>'}
    </div>
    <div class="studio-favorite-body">
      <h3>${escapeHtml(compactText(title, 68))}</h3>
      <p class="muted">${escapeHtml(compactText(model, 44))} | seed ${escapeHtml(seed)}</p>
      <div class="favorite-actions">
        <button type="button" class="secondary" data-favorite-action="load" data-favorite-id="${escapeHtml(favorite.id)}">Load</button>
        <button type="button" class="secondary danger" data-favorite-action="delete" data-favorite-id="${escapeHtml(favorite.id)}">Delete</button>
      </div>
    </div>
  </article>`;
}

function renderAll() {
  renderAuth();
  renderModelControls();
  renderFavorites();
  renderGallery();
  updateRequestPreview();
}

function hydrateImages(root = document) {
  for (const image of root.querySelectorAll('img[data-artifact-url]')) {
    if (image.dataset.loaded === '1' || observedImages.has(image)) continue;
    observedImages.add(image);
    if (thumbnailObserver) thumbnailObserver.observe(image);
    else hydrateOneImage(image);
  }
}

function hydrateOneImage(image) {
  const url = image.dataset.artifactUrl;
  if (!url || image.dataset.loaded === '1') return;
  if (thumbnailObjectUrls.has(url)) {
    image.src = thumbnailObjectUrls.get(url);
    image.hidden = false;
    image.dataset.loaded = '1';
    image.nextElementSibling?.remove();
    return;
  }
  const headers = {};
  if (url.startsWith('/api/v1') && state.imageApiKey) {
    headers.authorization = `Bearer ${state.imageApiKey}`;
  }
  fetch(url, { headers })
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
      const placeholder = Object.assign(document.createElement('div'), { className: 'thumb-placeholder', textContent: 'Image unavailable' });
      image.nextElementSibling?.replaceWith(placeholder);
    });
}

async function refreshData(options = {}) {
  if (!options.quiet) setFeedback('Refreshing image-generator data...', '');
  state.imageError = null;
  try {
    const health = await fetchJson('/health');
    state.imageHealth = health;
  } catch (error) {
    state.imageError = error;
    setFeedback(`Health check failed: ${error.message}`, 'error');
  }

  renderAuth();
  if (imageApiAuthRequiredWithoutKey()) {
    state.imageModels = null;
    state.imageWorkflows = null;
    state.imageJobs = null;
    state.imageFavorites = null;
    state.imageError = new Error('Dashboard API key required for protected /api/v1 calls.');
    renderAll();
    return;
  }

  const [models, workflows, jobs, favorites] = await Promise.allSettled([
    fetchJson('/api/v1/models'),
    fetchJson('/api/v1/workflows'),
    fetchJson(`/api/v1/jobs?page=1&pageSize=${MAX_GALLERY_JOBS}`),
    fetchJson('/api/v1/image-favorites?limit=80')
  ]);

  if (models.status === 'fulfilled') state.imageModels = models.value;
  if (workflows.status === 'fulfilled') state.imageWorkflows = workflows.value;
  if (jobs.status === 'fulfilled') state.imageJobs = jobs.value;
  if (favorites.status === 'fulfilled') state.imageFavorites = favorites.value;

  const failed = [models, workflows, jobs, favorites].find((result) => result.status === 'rejected');
  if (failed) {
    state.imageError = failed.reason;
    setFeedback(`Some generator data failed to load: ${failed.reason.message}`, 'error');
  } else if (!options.quiet) {
    setFeedback('Image-generator data refreshed.', 'ok');
  }
  renderAll();
}

async function prewarmSelectedModel(options = {}) {
  const model = selectedModelValue();
  if (!model) {
    setFeedback('Choose an installed checkpoint before prewarming.', 'error');
    return false;
  }
  if (checkpointModels().length && !checkpointModels().some((candidate) => modelMatches(candidate, model))) {
    setFeedback(`Checkpoint "${model}" is not available locally, so it cannot be prewarmed.`, 'error');
    return false;
  }
  state.prewarming = true;
  const button = $('#studio-prewarm');
  if (button) button.disabled = true;
  renderModelStatus();
  try {
    setFeedback(`Loading checkpoint "${model}" for this session...`, '');
    const result = await fetchJson('/api/v1/models/preload', {
      method: 'POST',
      body: JSON.stringify({ model })
    });
    if (result.inventory) state.imageModels = result.inventory;
    setFeedback(`Checkpoint "${model}" loaded/prewarmed. This did not change the global default model.`, 'ok');
    renderModelControls();
    return true;
  } catch (error) {
    setFeedback(`Checkpoint prewarm failed: ${error.message}`, 'error');
    return false;
  } finally {
    state.prewarming = false;
    if (button) button.disabled = false;
  }
}

async function submitGeneration(event) {
  event?.preventDefault();
  if (state.generating) return;
  const payload = buildGenerationPayload();
  if (!payload.prompt) {
    setFeedback('Enter a positive prompt before generating.', 'error');
    return;
  }
  if (!payload.model) {
    setFeedback('Choose a checkpoint/model before generating.', 'error');
    return;
  }
  state.generating = true;
  const generateButton = $('#studio-generate');
  if (generateButton) generateButton.disabled = true;
  try {
    setFeedback('Submitting generation request...', '');
    const result = await fetchPossiblyJson('/api/v1/generate', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (result.binary) {
      setFeedback('Generation returned binary image data. Refreshing gallery from persisted job history.', 'ok');
      await refreshData({ quiet: true });
      return;
    }
    const job = result.job;
    if (job?.id) state.activeJobId = job.id;
    if (job?.status === 'queued' || job?.status === 'running') {
      await pollJobUntilDone(job.id, result.status_url);
    }
    await refreshData({ quiet: true });
    const refreshedJob = findJobById(job?.id) || job;
    const seed = refreshedJob?.seed ?? refreshedJob?.request?.seed;
    setFeedback(`Generation ${refreshedJob?.status || 'completed'}${seed !== undefined ? ` with seed ${seed}` : ''}. Added newest result to the gallery.`, refreshedJob?.status === 'failed' ? 'error' : 'ok');
  } catch (error) {
    setFeedback(`Generation failed: ${error.message}`, 'error');
  } finally {
    state.generating = false;
    state.activeJobId = null;
    if (generateButton) generateButton.disabled = false;
    renderAll();
  }
}

async function pollJobUntilDone(jobId, statusUrl) {
  if (!jobId) return null;
  const url = statusUrl || `/api/v1/jobs/${encodeURIComponent(jobId)}`;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt < 10 ? 700 : 1500));
    const status = await fetchJson(url);
    const job = status.job || status;
    const label = job.status || 'running';
    setFeedback(`Generation job ${jobId} is ${label}...`, '');
    if (!['queued', 'running'].includes(label)) return job;
  }
  setFeedback(`Generation job ${jobId} is still running. Use Refresh gallery to check again.`, '');
  return null;
}

function findJobById(jobId) {
  if (!jobId) return null;
  return (state.imageJobs?.jobs || state.imageJobs?.items || []).find((job) => job.id === jobId) || null;
}

async function saveGalleryFavorite(index) {
  const jobs = state.renderedJobs || (state.imageJobs?.jobs || state.imageJobs?.items || []);
  const job = jobs[Number(index)];
  if (!job) {
    setFeedback('Favorite save failed: gallery job was not found.', 'error');
    return;
  }
  const payload = jobPayload(job);
  const artifacts = jobArtifacts(job);
  const artifact = firstArtifact(job) || artifacts[0] || null;
  const body = {
    title: defaultFavoriteTitleFromPayload(payload),
    request_payload: payload,
    artifact_id: artifact?.id,
    artifact_url: artifact?.url,
    image_url: artifact?.url,
    artifact,
    artifacts,
    job_id: job.id,
    job,
    metadata: isPlainObject(job.metadata) ? job.metadata : {}
  };
  try {
    setFeedback('Saving image favorite...', '');
    await fetchJson('/api/v1/image-favorites', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    await loadFavorites();
    renderFavorites();
    renderGallery();
    setFeedback('Image favorite saved with full request payload and artifact reference.', 'ok');
  } catch (error) {
    setFeedback(`Favorite save failed: ${error.message}`, 'error');
  }
}

function reuseGallerySettings(index) {
  const jobs = state.renderedJobs || (state.imageJobs?.jobs || state.imageJobs?.items || []);
  const job = jobs[Number(index)];
  if (!job) {
    setFeedback('Unable to load settings: gallery job was not found.', 'error');
    return;
  }
  applyPayloadToControls(jobPayload(job));
}

async function loadFavorites() {
  state.imageFavorites = await fetchJson('/api/v1/image-favorites?limit=80');
}

async function loadFavorite(favoriteId) {
  try {
    setFeedback('Loading favorite settings...', '');
    const result = await fetchJson(`/api/v1/image-favorites/${encodeURIComponent(favoriteId)}`);
    const favorite = result.favorite;
    const payload = favoritePayload(favorite);
    applyPayloadToControls(payload, { silent: true });
    const model = payloadString(payload, ['model', 'checkpoint', 'checkpoint_name', 'checkpointName']);
    if (model) {
      const exists = checkpointModels().some((candidate) => modelMatches(candidate, model));
      if (exists) {
        await prewarmSelectedModel({ quiet: true });
      } else {
        setFeedback(`Loaded favorite settings, but checkpoint "${model}" is missing locally. Generation may fail until the model is available.`, 'error');
        return;
      }
    }
    const seed = payloadSeed(payload);
    setFeedback(seed === null ? 'Loaded favorite settings, but the saved request had no seed. Random seed is enabled.' : 'Loaded favorite settings. Click Generate when ready.', seed === null ? 'error' : 'ok');
  } catch (error) {
    setFeedback(`Favorite load failed: ${error.message}`, 'error');
  }
}

async function deleteFavorite(favoriteId) {
  if (!window.confirm('Delete this saved image favorite?')) return;
  try {
    setFeedback('Deleting image favorite...', '');
    await fetchJson(`/api/v1/image-favorites/${encodeURIComponent(favoriteId)}`, { method: 'DELETE' });
    await loadFavorites();
    renderFavorites();
    renderGallery();
    setFeedback('Image favorite deleted.', 'ok');
  } catch (error) {
    setFeedback(`Favorite delete failed: ${error.message}`, 'error');
  }
}

function wireEvents() {
  $('#studio-api-key-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    state.imageApiKey = $('#studio-api-key')?.value.trim() || '';
    if (state.imageApiKey) window.localStorage.setItem(API_KEY_STORAGE_KEY, state.imageApiKey);
    else window.localStorage.removeItem(API_KEY_STORAGE_KEY);
    await refreshData();
  });
  $('#studio-clear-key')?.addEventListener('click', async () => {
    state.imageApiKey = '';
    window.localStorage.removeItem(API_KEY_STORAGE_KEY);
    await refreshData();
  });
  $('#studio-form')?.addEventListener('submit', submitGeneration);
  $('#studio-prewarm')?.addEventListener('click', () => prewarmSelectedModel());
  $('#studio-refresh')?.addEventListener('click', () => refreshData());
  $('#studio-refresh-favorites')?.addEventListener('click', async () => {
    try {
      await loadFavorites();
      renderFavorites();
      renderGallery();
      setFeedback('Favorites refreshed.', 'ok');
    } catch (error) {
      setFeedback(`Favorites refresh failed: ${error.message}`, 'error');
    }
  });

  $('#studio-model')?.addEventListener('change', async () => {
    updateRequestPreview();
    await prewarmSelectedModel();
  });
  $('#studio-workflow')?.addEventListener('change', () => {
    applyWorkflowDefaults(false);
    updateRequestPreview();
  });
  $('#studio-random-seed')?.addEventListener('change', () => {
    if ($('#studio-random-seed')?.checked) setControlValue('studio-seed', '-1');
    updateRequestPreview();
  });
  $('#studio-gallery-size')?.addEventListener('input', (event) => {
    state.gallerySize = Number(event.target.value) || DEFAULT_GALLERY_TILE_SIZE;
    window.localStorage.setItem(GALLERY_SIZE_STORAGE_KEY, String(state.gallerySize));
    renderGallery();
  });

  for (const selector of ['#studio-prompt', '#studio-negative', '#studio-width', '#studio-height', '#studio-steps', '#studio-cfg-scale', '#studio-seed', '#studio-sampler', '#studio-scheduler', '#studio-output', '#studio-sync-timeout']) {
    $(selector)?.addEventListener('input', updateRequestPreview);
    $(selector)?.addEventListener('change', updateRequestPreview);
  }

  $('#studio-gallery')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-gallery-action]');
    if (!button) return;
    const index = button.dataset.jobIndex;
    if (button.dataset.galleryAction === 'save-favorite') saveGalleryFavorite(index);
    if (button.dataset.galleryAction === 'load-settings') reuseGallerySettings(index);
  });

  $('#studio-favorites')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-favorite-action]');
    if (!button) return;
    const favoriteId = button.dataset.favoriteId;
    if (button.dataset.favoriteAction === 'load') loadFavorite(favoriteId);
    if (button.dataset.favoriteAction === 'delete') deleteFavorite(favoriteId);
  });
}

function initialize() {
  const gallerySize = $('#studio-gallery-size');
  if (gallerySize) gallerySize.value = String(state.gallerySize);
  const seed = $('#studio-seed');
  if (seed && !seed.value) seed.value = '-1';
  wireEvents();
  renderAll();
  refreshData({ quiet: true });
}

initialize();
