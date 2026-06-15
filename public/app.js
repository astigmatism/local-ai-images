const $ = (selector) => document.querySelector(selector);

const state = {
  imageApiKey: window.localStorage.getItem('local-ai-images-api-key') || '',
  imageHealth: null,
  imageStats: null,
  imageModels: null,
  imageWorkflows: null,
  imageJobs: null,
  modelDownloads: null,
  modelCatalog: null,
  imageError: null,
  activeJobId: null
};

async function fetchJson(url, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (url.startsWith('/api/v1') && state.imageApiKey) {
    headers.authorization = `Bearer ${state.imageApiKey}`;
  }
  const response = await fetch(url, { headers, ...options });
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

function formatBytesMiB(value) {
  return value === null || value === undefined ? 'n/a' : `${value.toLocaleString()} MiB`;
}

function formatBytes(value) {
  if (value === null || value === undefined) return 'n/a';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;
  return `${(value / 1024 / 1024 / 1024).toLocaleString(undefined, { maximumFractionDigits: 2 })} GiB`;
}

function formatNumber(value, suffix = '') {
  if (value === null || value === undefined) return 'n/a';
  return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}

function formatDate(value) {
  if (!value) return 'n/a';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderKeyValues(values) {
  return `<dl class="kv">${values.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${value}</dd>`).join('')}</dl>`;
}

function statusPill(ok, labels = ['OK', 'Problem']) {
  return `<span class="status-pill ${ok ? 'ok' : 'bad'}">${escapeHtml(ok ? labels[0] : labels[1])}</span>`;
}

function badge(label, tone = '') {
  return `<span class="badge ${tone}">${escapeHtml(label)}</span>`;
}

function normalizeModel(value) {
  return String(value || '').trim().replace(/\\/g, '/').toLowerCase();
}

function modelIdentifier(model) {
  return model?.comfyName || model?.fileName || model?.relativePath || model?.id || '';
}

function modelMatches(model, value) {
  const normalized = normalizeModel(value);
  if (!normalized || !model) return false;
  return [model.id, model.comfyName, model.fileName, model.relativePath, model.path, model.name, model.displayName]
    .filter(Boolean)
    .some((candidate) => normalizeModel(candidate) === normalized);
}

function currentPreloadStatus() {
  return state.imageModels?.defaultStatus || state.imageModels?.preload || state.imageHealth?.models?.preload || null;
}

function checkpointModels() {
  return (state.imageModels?.models || []).filter((model) => model.type === 'checkpoint');
}

function selectedPlaygroundModel() {
  const select = $('#playground-model');
  return select ? select.value : '';
}

function renderImageAuth() {
  $('#api-key-input').value = state.imageApiKey;
  const target = $('#image-auth-status');
  target.innerHTML = state.imageApiKey
    ? '<span class="status-pill ok">API key saved locally</span>'
    : '<span class="status-pill warn">No browser API key set</span>';
}

function renderImageHealth() {
  const target = $('#image-health-content');
  if (state.imageError && !state.imageHealth) {
    target.innerHTML = `<p class="muted">Image API unavailable from this browser: ${escapeHtml(state.imageError.message)}</p>`;
    return;
  }

  const health = state.imageHealth;
  if (!health) {
    target.textContent = 'No image API health data yet.';
    return;
  }

  target.innerHTML = `
    <p>${statusPill(health.ok && health.engine?.ok, ['Ready', 'Attention'])}</p>
    ${renderKeyValues([
      ['Service', escapeHtml(health.service || 'Local AI Images')],
      ['Backend', `<code>${escapeHtml(health.backend || 'unknown')}</code>`],
      ['Engine', escapeHtml(health.engine?.ok ? `${health.engine.provider} reachable` : `${health.engine?.provider || 'engine'} unavailable`) ],
      ['Enabled', escapeHtml(health.enabled ? 'yes' : 'no')],
      ['Auth', escapeHtml(health.auth?.enabled ? `enabled (${health.auth.configured_key_count || 0} key configured)` : 'disabled')],
      ['Model paths', escapeHtml((health.models?.paths || []).join(', ') || 'n/a')],
      ['Workflow count', escapeHtml(health.workflows?.count ?? 'n/a')]
    ])}`;
}

function renderQueue() {
  const target = $('#image-queue-content');
  const queue = state.imageStats?.queue || state.imageHealth?.queue;
  if (!queue) {
    target.textContent = 'No queue data yet.';
    return;
  }
  target.innerHTML = `<div class="metrics">
    <div class="metric"><span>Queued</span><strong>${escapeHtml(queue.queued)}</strong></div>
    <div class="metric"><span>Running</span><strong>${escapeHtml(queue.running)}</strong></div>
    <div class="metric"><span>Succeeded</span><strong>${escapeHtml(queue.succeeded)}</strong></div>
    <div class="metric"><span>Failed</span><strong>${escapeHtml(queue.failed)}</strong></div>
    <div class="metric"><span>Canceled</span><strong>${escapeHtml(queue.canceled)}</strong></div>
    <div class="metric"><span>Concurrency</span><strong>${escapeHtml(queue.concurrency)}</strong></div>
  </div>`;
}

function renderDefaultModelStatus() {
  const target = $('#default-model-status');
  if (!target) return;
  const status = currentPreloadStatus();
  if (!status) {
    target.innerHTML = '<p class="muted">No default model lifecycle status yet.</p>';
    return;
  }
  const hasDefault = Boolean(status.currentDefaultCheckpoint || status.defaultModel);
  const defaultExists = status.defaultFileExists;
  const preloadResult = status.lastPreloadResult || 'not_attempted';
  target.className = 'default-model-panel';
  target.innerHTML = `
    <div class="section-heading">
      <div>
        <h3>Default model status</h3>
        <p class="hint">Loaded status is reported only after a successful preload or generation. ComfyUI does not expose a reliable exact current-checkpoint API.</p>
      </div>
      <div class="badge-row">
        ${hasDefault ? badge('default configured', 'ok') : badge('no default', 'warn')}
        ${status.preloadOnStartup ? badge('preload on startup enabled', 'ok') : badge('preload on startup disabled', 'warn')}
        ${status.active ? badge('preload running', 'warn') : ''}
      </div>
    </div>
    ${renderKeyValues([
      ['Current default checkpoint', hasDefault ? `<code>${escapeHtml(status.currentDefaultCheckpoint || status.defaultModel)}</code>` : '<span class="muted">none</span>'],
      ['Default file exists', defaultExists === null ? '<span class="muted">n/a</span>' : escapeHtml(defaultExists ? 'yes' : 'no')],
      ['Preload-on-startup enabled', escapeHtml(status.preloadOnStartup ? 'yes' : 'no')],
      ['Last preload attempt time', escapeHtml(formatDate(status.lastPreloadAttemptTime))],
      ['Last preload result', `<code>${escapeHtml(preloadResult)}</code>`],
      ['Last preload error', status.lastPreloadError ? `<span class="danger-text">${escapeHtml(status.lastPreloadError.code)}: ${escapeHtml(status.lastPreloadError.message)}</span>` : '<span class="muted">none</span>'],
      ['Last confirmed loaded/prewarmed model', status.lastConfirmedLoadedModel ? `<code>${escapeHtml(status.lastConfirmedLoadedModel)}</code>` : '<span class="muted">not confirmed in this process</span>']
    ])}
    ${status.defaultWarning ? `<p class="notice warn">${escapeHtml(status.defaultWarning)}</p>` : ''}
    <div class="button-row lifecycle-actions">
      <button type="button" data-default-action="load">Load default now</button>
      <button type="button" class="secondary" data-default-action="enable-preload">Enable preload on startup</button>
      <button type="button" class="secondary" data-default-action="disable-preload">Disable preload on startup</button>
      <button type="button" class="secondary danger" data-default-action="clear-default">Clear default</button>
    </div>`;
}

function renderImageModels() {
  renderDefaultModelStatus();
  const target = $('#image-models');
  const models = state.imageModels?.models || [];
  if (models.length === 0) {
    target.innerHTML = '<p class="muted">No local image models found in IMAGE_MODEL_PATHS.</p>';
    renderPlaygroundOptions();
    return;
  }
  const selected = selectedPlaygroundModel();
  target.innerHTML = `<div class="model-list lifecycle-list">${models.map((model) => {
    const isSelected = selected && modelMatches(model, selected);
    const badges = [badge('installed', 'ok')];
    if (isSelected) badges.push(badge('selected for playground', 'ok'));
    if (model.isDefault) badges.push(badge('default', 'ok'));
    if (model.isLastConfirmedLoaded) badges.push(badge('last loaded/prewarmed', 'ok'));
    if (model.loadedStatus === 'default_not_confirmed_loaded') badges.push(badge('default not confirmed loaded', 'warn'));
    if (model.defaultWarning) badges.push(badge('missing default file', 'bad'));
    return `<article class="model-item lifecycle-model" data-model-id="${escapeHtml(model.id)}">
      <div class="model-title-row">
        <div>
          <h3><code>${escapeHtml(model.relativePath)}</code></h3>
          <p class="hint">ComfyUI name: <code>${escapeHtml(modelIdentifier(model))}</code></p>
        </div>
        <div class="badge-row">${badges.join('')}</div>
      </div>
      ${renderKeyValues([
        ['Type', escapeHtml(model.type)],
        ['Size', escapeHtml(formatBytes(model.sizeBytes))],
        ['Modified', escapeHtml(model.modifiedAt || 'n/a')],
        ['Loaded status', `<code>${escapeHtml(model.loadedStatus || 'not_confirmed_loaded')}</code>`],
        ['Can set default', escapeHtml(model.canSetDefault ? 'yes' : 'no')],
        ['Can preload', escapeHtml(model.canPreload ? 'yes' : 'no')],
        ['Can delete', escapeHtml(model.canDelete ? 'yes' : 'no')]
      ])}
      ${model.defaultWarning ? `<p class="notice warn">${escapeHtml(model.defaultWarning)}</p>` : ''}
      <div class="button-row model-actions">
        <button type="button" data-model-action="use">Use in playground</button>
        <button type="button" data-model-action="load" ${model.canPreload ? '' : 'disabled'}>Load / Prewarm now</button>
        <button type="button" class="secondary" data-model-action="set-default" ${model.canSetDefault ? '' : 'disabled'}>Set as default</button>
        <button type="button" class="secondary" data-model-action="set-default-preload" ${model.canSetDefault ? '' : 'disabled'}>Set default + preload on startup</button>
        ${model.isDefault ? '<button type="button" class="secondary" data-model-action="clear-default">Clear default</button>' : ''}
        <button type="button" class="secondary danger" data-model-action="delete" ${model.canDelete ? '' : 'disabled'}>Delete model</button>
        <button type="button" class="secondary" data-model-action="refresh">Refresh scan</button>
      </div>
    </article>`;
  }).join('')}</div>`;
  renderPlaygroundOptions();
}

function renderWorkflows() {
  const target = $('#image-workflows');
  const workflows = state.imageWorkflows?.workflows || [];
  if (workflows.length === 0) {
    target.innerHTML = '<p class="muted">No workflow presets loaded.</p>';
    renderPlaygroundOptions();
    return;
  }
  target.innerHTML = `<div class="model-list compact">${workflows.map((workflow) => `<article class="model-item">
    <h3><code>${escapeHtml(workflow.id)}</code></h3>
    <p class="muted">${escapeHtml(workflow.description || workflow.name)}</p>
    ${renderKeyValues([
      ['Source', escapeHtml(workflow.source)],
      ['Default size', escapeHtml(`${workflow.defaults?.width || 'n/a'} x ${workflow.defaults?.height || 'n/a'}`)],
      ['Steps', escapeHtml(workflow.defaults?.steps || 'n/a')],
      ['Sampler', escapeHtml(workflow.defaults?.samplerName || 'n/a')]
    ])}
  </article>`).join('')}</div>`;
  renderPlaygroundOptions();
}

function renderJobs() {
  const target = $('#image-jobs');
  const jobs = state.imageJobs?.jobs || state.imageStats?.recent_jobs || [];
  if (jobs.length === 0) {
    target.innerHTML = '<p class="muted">No image jobs submitted since this process started.</p>';
    return;
  }
  target.innerHTML = `<div class="job-list">${jobs.map((job) => `<article class="job-item">
    <div>
      <h3><code>${escapeHtml(job.id)}</code></h3>
      <p class="muted">${escapeHtml(job.workflowId || '')} ${job.model ? `| ${escapeHtml(job.model)}` : ''}</p>
    </div>
    <span class="status-pill ${job.status === 'succeeded' ? 'ok' : job.status === 'failed' ? 'bad' : 'warn'}">${escapeHtml(job.status)}</span>
  </article>`).join('')}</div>`;
}

function renderGpus() {
  const target = $('#gpu-list');
  const gpuSummary = state.imageStats?.gpu || state.imageHealth?.gpu;
  const gpus = gpuSummary?.gpus || [];
  if (!gpuSummary?.ok) {
    target.innerHTML = `<p class="muted">GPU telemetry unavailable: ${escapeHtml(gpuSummary?.error?.message || 'no data yet')}</p>`;
    return;
  }
  if (gpus.length === 0) {
    target.innerHTML = '<p class="muted">No GPU data available.</p>';
    return;
  }

  target.innerHTML = gpus.map((gpu) => `<article class="gpu-card">
    <h3>GPU ${escapeHtml(gpu.index)}: ${escapeHtml(gpu.name)}</h3>
    <p class="muted">${escapeHtml(gpu.uuid || 'UUID unavailable')} | Driver ${escapeHtml(gpu.driver_version || 'n/a')}</p>
    <div class="metrics">
      <div class="metric"><span>Memory used</span><strong>${formatBytesMiB(gpu.memory_used_mib)}</strong></div>
      <div class="metric"><span>Memory free</span><strong>${formatBytesMiB(gpu.memory_free_mib)}</strong></div>
      <div class="metric"><span>Memory total</span><strong>${formatBytesMiB(gpu.memory_total_mib)}</strong></div>
      <div class="metric"><span>GPU utilization</span><strong>${formatNumber(gpu.utilization_gpu_percent, '%')}</strong></div>
      <div class="metric"><span>Temperature</span><strong>${formatNumber(gpu.temperature_c, ' °C')}</strong></div>
      <div class="metric"><span>Power draw / limit</span><strong>${formatNumber(gpu.power_draw_w, ' W')} / ${formatNumber(gpu.power_limit_w, ' W')}</strong></div>
    </div>
    ${gpu.warnings?.length ? `<p class="hint">Warnings: ${escapeHtml(gpu.warnings.join(', '))}</p>` : ''}
  </article>`).join('');
}

function renderModelDownloads() {
  const status = $('#model-install-status');
  const downloads = state.modelDownloads;
  const typeSelect = $('#download-type');
  const destinationInput = $('#download-destination');
  if (downloads && typeSelect) {
    const destinations = downloads.destinations || {};
    const current = typeSelect.value || 'checkpoint';
    typeSelect.innerHTML = Object.keys(destinations).map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');
    if (destinations[current]) typeSelect.value = current;
    destinationInput.value = destinations[typeSelect.value] || '';
  }
  if (status) {
    status.innerHTML = downloads?.enabled ? badge('downloads enabled', 'ok') : badge('downloads disabled', 'warn');
  }

  const target = $('#model-downloads');
  const jobs = downloads?.jobs || [];
  if (!target) return;
  if (!downloads) {
    target.innerHTML = '<p class="muted">No download metadata loaded.</p>';
    return;
  }
  if (jobs.length === 0) {
    target.innerHTML = '<p class="muted">No model download jobs yet.</p>';
    return;
  }
  target.innerHTML = `<div class="job-list">${jobs.map((job) => `<article class="job-item">
    <div>
      <h3><code>${escapeHtml(job.fileName)}</code></h3>
      <p class="muted">${escapeHtml(job.type)} | ${formatBytes(job.downloadedBytes)}${job.totalBytes ? ` / ${formatBytes(job.totalBytes)}` : ''}</p>
      ${job.error ? `<p class="danger-text">${escapeHtml(job.error.code)}: ${escapeHtml(job.error.message)}</p>` : ''}
    </div>
    <span class="status-pill ${job.status === 'succeeded' ? 'ok' : job.status === 'failed' ? 'bad' : 'warn'}">${escapeHtml(job.status)}</span>
  </article>`).join('')}</div>`;
}

function renderModelCatalog() {
  const target = $('#model-catalog');
  const entries = state.modelCatalog?.entries || [];
  if (!target) return;
  if (entries.length === 0) {
    target.innerHTML = '<p class="muted">No local catalog entries configured.</p>';
    return;
  }
  target.innerHTML = `<div class="model-list compact">${entries.map((entry) => `<article class="model-item">
    <h3>${escapeHtml(entry.name || entry.id)}</h3>
    <p class="muted">${escapeHtml(entry.description || entry.notes || '')}</p>
    ${renderKeyValues([
      ['Type', escapeHtml(entry.type || 'n/a')],
      ['File name', entry.fileName ? `<code>${escapeHtml(entry.fileName)}</code>` : '<span class="muted">n/a</span>'],
      ['Source', escapeHtml(entry.sourceName || entry.sourceUrl || 'local catalog')]
    ])}
    ${entry.downloadUrl ? `<button type="button" class="secondary" data-catalog-url="${escapeHtml(entry.downloadUrl)}" data-catalog-type="${escapeHtml(entry.type || 'checkpoint')}" data-catalog-file="${escapeHtml(entry.fileName || '')}">Use catalog download URL</button>` : ''}
  </article>`).join('')}</div>`;
}

function renderPlaygroundOptions() {
  const modelSelect = $('#playground-model');
  const workflowSelect = $('#playground-workflow');
  if (!modelSelect || !workflowSelect) return;

  const status = currentPreloadStatus();
  const defaultModel = status?.currentDefaultCheckpoint || state.imageModels?.defaultModel || '';
  const checkpoints = checkpointModels();
  const previous = modelSelect.value;
  const defaultItem = checkpoints.find((model) => modelMatches(model, defaultModel));
  const selectedValue = checkpoints.some((model) => modelMatches(model, previous))
    ? previous
    : defaultItem
      ? modelIdentifier(defaultItem)
      : '';

  modelSelect.innerHTML = `<option value="">${defaultModel ? `Use configured default (${escapeHtml(defaultModel)})` : 'No model selected'}</option>` + checkpoints.map((model) => {
    const labels = [];
    if (model.isDefault) labels.push('default');
    if (model.isLastConfirmedLoaded) labels.push('last loaded/prewarmed');
    const label = `${model.comfyName || model.fileName}${labels.length ? ` (${labels.join(', ')})` : ''}`;
    return `<option value="${escapeHtml(modelIdentifier(model))}">${escapeHtml(label)}</option>`;
  }).join('');
  modelSelect.value = selectedValue;

  const workflows = state.imageWorkflows?.workflows || [];
  const previousWorkflow = workflowSelect.value;
  workflowSelect.innerHTML = workflows.map((workflow) => `<option value="${escapeHtml(workflow.id)}">${escapeHtml(workflow.name || workflow.id)}</option>`).join('');
  if (workflows.some((workflow) => workflow.id === previousWorkflow)) {
    workflowSelect.value = previousWorkflow;
  }
  if (!workflowSelect.value && workflows[0]) workflowSelect.value = workflows[0].id;
  applyWorkflowDefaults(false);
  updatePlaygroundPreview();
  renderPlaygroundStatus();
}

function renderPlaygroundStatus() {
  const target = $('#playground-default-model');
  if (!target) return;
  const status = currentPreloadStatus();
  const model = selectedPlaygroundModel() || status?.currentDefaultCheckpoint || '';
  if (!model) {
    target.innerHTML = '<span class="status-pill warn">No model selected and no default exists</span> Select a checkpoint before generating.';
    return;
  }
  const selectedModel = checkpointModels().find((candidate) => modelMatches(candidate, model));
  target.innerHTML = `${selectedModel?.isDefault ? badge('default', 'ok') : badge('selected', 'ok')} ${selectedModel?.isLastConfirmedLoaded ? badge('last loaded/prewarmed', 'ok') : badge('not confirmed loaded', 'warn')} Request will send checkpoint <code>${escapeHtml(model)}</code>.`;
}

function selectedWorkflow() {
  const id = $('#playground-workflow')?.value;
  return (state.imageWorkflows?.workflows || []).find((workflow) => workflow.id === id) || state.imageWorkflows?.workflows?.[0] || null;
}

function applyWorkflowDefaults(overwrite = true) {
  const workflow = selectedWorkflow();
  if (!workflow) return;
  const defaults = workflow.defaults || {};
  const pairs = [
    ['#playground-width', defaults.width],
    ['#playground-height', defaults.height],
    ['#playground-steps', defaults.steps],
    ['#playground-cfg-scale', defaults.cfgScale],
    ['#playground-sampler', defaults.samplerName],
    ['#playground-scheduler', defaults.scheduler]
  ];
  for (const [selector, value] of pairs) {
    const input = $(selector);
    if (!input || value === undefined || value === null) continue;
    if (overwrite || input.value === '') input.value = value;
  }
}

function buildPlaygroundPayload() {
  const status = currentPreloadStatus();
  const payload = {
    prompt: $('#playground-prompt')?.value.trim() || '',
    negative_prompt: $('#playground-negative')?.value.trim() || '',
    workflow_id: $('#playground-workflow')?.value || undefined,
    width: Number($('#playground-width')?.value || 0) || undefined,
    height: Number($('#playground-height')?.value || 0) || undefined,
    steps: Number($('#playground-steps')?.value || 0) || undefined,
    cfg_scale: Number($('#playground-cfg-scale')?.value || 0),
    seed: $('#playground-random-seed')?.checked ? -1 : Number($('#playground-seed')?.value || -1),
    sampler_name: $('#playground-sampler')?.value.trim() || undefined,
    scheduler: $('#playground-scheduler')?.value.trim() || undefined,
    output: $('#playground-output')?.value || 'url',
    sync_timeout_ms: Number($('#playground-sync-timeout')?.value || 0),
    metadata: { source: 'portal-playground' }
  };
  const model = selectedPlaygroundModel() || status?.currentDefaultCheckpoint || '';
  if (model) payload.model = model;
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined || payload[key] === '') delete payload[key];
  }
  return payload;
}

function updatePlaygroundPreview() {
  const payload = buildPlaygroundPayload();
  const requestPreview = $('#playground-request-preview');
  const curlPreview = $('#playground-curl-preview');
  if (requestPreview) requestPreview.textContent = JSON.stringify(payload, null, 2);
  if (curlPreview) {
    const auth = state.imageApiKey ? " \\\n  -H 'Authorization: Bearer <browser-saved-key>'" : '';
    curlPreview.textContent = `curl -sS -X POST /api/v1/generate${auth} \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify(payload)}'`;
  }
  renderPlaygroundStatus();
}

function renderAll() {
  renderImageAuth();
  renderImageHealth();
  renderQueue();
  renderImageModels();
  renderWorkflows();
  renderJobs();
  renderGpus();
  renderModelDownloads();
  renderModelCatalog();
}

async function refreshImageApi() {
  state.imageError = null;
  const [health, stats, models, workflows, jobs, downloads, catalog] = await Promise.allSettled([
    fetchJson('/api/v1/health'),
    fetchJson('/api/v1/stats'),
    fetchJson('/api/v1/models'),
    fetchJson('/api/v1/workflows'),
    fetchJson('/api/v1/jobs?limit=10'),
    fetchJson('/api/v1/model-downloads?limit=20'),
    fetchJson('/api/v1/model-catalog')
  ]);

  if (health.status === 'fulfilled') state.imageHealth = health.value;
  if (stats.status === 'fulfilled') state.imageStats = stats.value;
  if (models.status === 'fulfilled') state.imageModels = models.value;
  if (workflows.status === 'fulfilled') state.imageWorkflows = workflows.value;
  if (jobs.status === 'fulfilled') state.imageJobs = jobs.value;
  if (downloads.status === 'fulfilled') state.modelDownloads = downloads.value;
  if (catalog.status === 'fulfilled') state.modelCatalog = catalog.value;

  const rejected = [health, stats, models, workflows, jobs, downloads, catalog].find((result) => result.status === 'rejected');
  if (rejected) {
    state.imageError = rejected.reason;
    console.warn(rejected.reason);
  }
}

async function refresh() {
  try {
    await refreshImageApi();
    renderAll();
  } catch (error) {
    setImageFeedback(error.message, false);
  }
}

async function refreshModelsOnly(message = 'Model inventory refreshed.') {
  state.imageModels = await fetchJson('/api/v1/models/refresh', { method: 'POST' });
  renderImageModels();
  setImageFeedback(message);
}

function setImageFeedback(message, ok = true) {
  const feedback = $('#image-feedback');
  feedback.className = `feedback ${ok ? 'ok' : 'error'}`;
  feedback.textContent = message;
}

function findModelFromButton(button) {
  const item = button.closest('[data-model-id]');
  const id = item?.dataset?.modelId;
  return (state.imageModels?.models || []).find((model) => model.id === id) || null;
}

async function handleModelAction(event) {
  const button = event.target.closest('[data-model-action]');
  if (!button) return;
  const action = button.dataset.modelAction;
  const model = findModelFromButton(button);
  if (!model && action !== 'refresh') return;
  const identifier = modelIdentifier(model);
  try {
    if (action === 'use') {
      $('#playground-model').value = identifier;
      updatePlaygroundPreview();
      renderImageModels();
      setImageFeedback(`Selected ${identifier} for the playground.`);
      return;
    }
    if (action === 'load') {
      setImageFeedback(`Preloading ${identifier}...`);
      await fetchJson('/api/v1/models/preload', { method: 'POST', body: JSON.stringify({ model: identifier }) });
      await refreshModelsOnly(`Loaded/prewarmed ${identifier}.`);
      return;
    }
    if (action === 'set-default') {
      await fetchJson('/api/v1/models/default', { method: 'POST', body: JSON.stringify({ model: identifier }) });
      await refreshModelsOnly(`Set ${identifier} as default.`);
      return;
    }
    if (action === 'set-default-preload') {
      await fetchJson('/api/v1/models/default', { method: 'POST', body: JSON.stringify({ model: identifier, preload_on_startup: true }) });
      await refreshModelsOnly(`Set ${identifier} as default and enabled preload on startup.`);
      return;
    }
    if (action === 'clear-default') {
      await fetchJson('/api/v1/models/default', { method: 'DELETE' });
      await refreshModelsOnly('Cleared the default checkpoint.');
      return;
    }
    if (action === 'delete') {
      const preview = `Delete model file?\n\nFile: ${model.fileName}\nType: ${model.type}\nSize: ${formatBytes(model.sizeBytes)}\n\nType the exact file name to confirm.`;
      const confirmation = window.prompt(preview, '');
      if (confirmation !== model.fileName) {
        setImageFeedback('Delete canceled: confirmation did not match the exact file name.', false);
        return;
      }
      const body = { confirm_file_name: confirmation };
      if (model.isDefault) {
        const clear = window.confirm(`${model.fileName} is the current default checkpoint. Delete it and clear the default setting?`);
        if (!clear) {
          setImageFeedback('Delete canceled: clear the default first or choose delete-and-clear.', false);
          return;
        }
        body.delete_and_clear_default = true;
      }
      await fetchJson(`/api/v1/models/${encodeURIComponent(model.id)}`, { method: 'DELETE', body: JSON.stringify(body) });
      await refreshModelsOnly(`Deleted ${model.fileName} and refreshed the scan.`);
      return;
    }
    if (action === 'refresh') {
      await refreshModelsOnly('Model inventory refreshed.');
    }
  } catch (error) {
    setImageFeedback(error.message, false);
    await refresh().catch(() => undefined);
  }
}

async function handleDefaultAction(event) {
  const button = event.target.closest('[data-default-action]');
  if (!button) return;
  const action = button.dataset.defaultAction;
  try {
    if (action === 'load') {
      setImageFeedback('Loading default checkpoint now...');
      await fetchJson('/api/v1/models/preload', { method: 'POST', body: JSON.stringify({}) });
      await refreshModelsOnly('Default checkpoint loaded/prewarmed.');
      return;
    }
    if (action === 'enable-preload') {
      await fetchJson('/api/v1/models/preload/startup', { method: 'POST', body: JSON.stringify({ enabled: true }) });
      await refreshModelsOnly('Enabled preload on startup.');
      return;
    }
    if (action === 'disable-preload') {
      await fetchJson('/api/v1/models/preload/startup', { method: 'POST', body: JSON.stringify({ enabled: false }) });
      await refreshModelsOnly('Disabled preload on startup.');
      return;
    }
    if (action === 'clear-default') {
      await fetchJson('/api/v1/models/default', { method: 'DELETE' });
      await refreshModelsOnly('Cleared the default checkpoint.');
    }
  } catch (error) {
    setImageFeedback(error.message, false);
    await refresh().catch(() => undefined);
  }
}

async function handlePlaygroundSubmit(event) {
  event.preventDefault();
  const payload = buildPlaygroundPayload();
  if (!payload.model) {
    setImageFeedback('Choose a checkpoint or configure a default before generating.', false);
    return;
  }
  if (!payload.prompt) {
    setImageFeedback('Prompt is required.', false);
    return;
  }
  try {
    $('#playground-result').textContent = 'Submitting generation request...';
    const result = await fetchJson('/api/v1/generate', { method: 'POST', body: JSON.stringify(payload) });
    state.activeJobId = result.job?.id || null;
    $('#playground-cancel').disabled = !state.activeJobId;
    $('#playground-result').innerHTML = `<pre><code>${escapeHtml(JSON.stringify(result, null, 2))}</code></pre>`;
    await refresh();
  } catch (error) {
    $('#playground-result').innerHTML = `<p class="danger-text">${escapeHtml(error.message)}</p>`;
    setImageFeedback(error.message, false);
  }
}

async function handlePlaygroundModelButton(action) {
  const model = selectedPlaygroundModel() || currentPreloadStatus()?.currentDefaultCheckpoint || '';
  if (!model) {
    setImageFeedback('Choose a checkpoint model first.', false);
    return;
  }
  try {
    if (action === 'load') {
      setImageFeedback(`Preloading ${model}...`);
      await fetchJson('/api/v1/models/preload', { method: 'POST', body: JSON.stringify({ model }) });
      await refreshModelsOnly(`Loaded/prewarmed ${model}.`);
    }
    if (action === 'default') {
      await fetchJson('/api/v1/models/default', { method: 'POST', body: JSON.stringify({ model }) });
      await refreshModelsOnly(`Set ${model} as default.`);
    }
    if (action === 'startup') {
      await fetchJson('/api/v1/models/default', { method: 'POST', body: JSON.stringify({ model, preload_on_startup: true }) });
      await refreshModelsOnly(`Set ${model} as default and enabled preload on startup.`);
    }
  } catch (error) {
    setImageFeedback(error.message, false);
  }
}

async function handleDownloadSubmit(event) {
  event.preventDefault();
  const type = $('#download-type').value;
  const body = {
    url: $('#download-url').value.trim(),
    type,
    file_name: $('#download-file-name').value.trim() || undefined,
    destination: $('#download-destination').value.trim() || undefined,
    set_default: $('#download-set-default').checked && type === 'checkpoint',
    overwrite: $('#download-overwrite').checked
  };
  try {
    const started = await fetchJson('/api/v1/model-downloads', { method: 'POST', body: JSON.stringify(body) });
    setImageFeedback(`Started model download job ${started.job.id}.`);
    await refresh();
  } catch (error) {
    setImageFeedback(error.message, false);
  }
}

function wireEvents() {
  $('#refresh-button').addEventListener('click', refresh);

  $('#api-key-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    state.imageApiKey = $('#api-key-input').value.trim();
    if (state.imageApiKey) window.localStorage.setItem('local-ai-images-api-key', state.imageApiKey);
    else window.localStorage.removeItem('local-ai-images-api-key');
    setImageFeedback(state.imageApiKey ? 'Saved API key in this browser only.' : 'Cleared browser API key.');
    await refresh();
  });

  $('#clear-key-button').addEventListener('click', async () => {
    state.imageApiKey = '';
    window.localStorage.removeItem('local-ai-images-api-key');
    $('#api-key-input').value = '';
    setImageFeedback('Cleared browser API key.');
    await refresh();
  });

  $('#refresh-models-button').addEventListener('click', async () => {
    try {
      setImageFeedback('Refreshing model inventory...');
      await refreshModelsOnly('Model inventory refreshed.');
    } catch (error) {
      setImageFeedback(`Unable to refresh model inventory: ${error.message}`, false);
    }
  });

  $('#image-models').addEventListener('click', handleModelAction);
  $('#default-model-status').addEventListener('click', handleDefaultAction);
  $('#playground-form').addEventListener('submit', handlePlaygroundSubmit);
  $('#apply-workflow-defaults').addEventListener('click', () => {
    applyWorkflowDefaults(true);
    updatePlaygroundPreview();
  });
  $('#playground-load-selected').addEventListener('click', () => handlePlaygroundModelButton('load'));
  $('#playground-set-selected-default').addEventListener('click', () => handlePlaygroundModelButton('default'));
  $('#playground-preload-selected-startup').addEventListener('click', () => handlePlaygroundModelButton('startup'));
  $('#playground-cancel').addEventListener('click', async () => {
    if (!state.activeJobId) return;
    try {
      const canceled = await fetchJson(`/api/v1/jobs/${encodeURIComponent(state.activeJobId)}/cancel`, { method: 'POST' });
      $('#playground-result').innerHTML = `<pre><code>${escapeHtml(JSON.stringify(canceled, null, 2))}</code></pre>`;
      setImageFeedback(`Cancel requested for job ${state.activeJobId}.`);
      await refresh();
    } catch (error) {
      setImageFeedback(error.message, false);
    }
  });

  for (const selector of ['#playground-model', '#playground-workflow', '#playground-prompt', '#playground-negative', '#playground-width', '#playground-height', '#playground-steps', '#playground-cfg-scale', '#playground-seed', '#playground-output', '#playground-sampler', '#playground-scheduler', '#playground-sync-timeout', '#playground-random-seed']) {
    const element = $(selector);
    element?.addEventListener('input', updatePlaygroundPreview);
    element?.addEventListener('change', updatePlaygroundPreview);
  }

  $('#model-download-form').addEventListener('submit', handleDownloadSubmit);
  $('#download-type').addEventListener('change', () => {
    $('#download-destination').value = state.modelDownloads?.destinations?.[$('#download-type').value] || '';
  });
  $('#model-catalog').addEventListener('click', (event) => {
    const button = event.target.closest('[data-catalog-url]');
    if (!button) return;
    $('#download-url').value = button.dataset.catalogUrl || '';
    $('#download-type').value = button.dataset.catalogType || 'checkpoint';
    $('#download-file-name').value = button.dataset.catalogFile || '';
    $('#download-destination').value = state.modelDownloads?.destinations?.[$('#download-type').value] || '';
    setImageFeedback('Copied catalog entry into the download form. Review the URL and filename before starting.');
  });
}

wireEvents();
refresh();
setInterval(refresh, 10000);
