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

const thumbnailObjectUrls = new Map();

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
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}

function formatDurationMs(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'n/a';
  const ms = Number(value);
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} s`;
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

function imageApiAuthRequiredWithoutKey() {
  const auth = state.imageHealth?.auth;
  return Boolean(auth?.enabled && !state.imageApiKey);
}

function renderImageAuth() {
  $('#api-key-input').value = state.imageApiKey;
  const target = $('#image-auth-status');
  const help = $('#image-auth-help');
  const auth = state.imageHealth?.auth;

  if (!auth) {
    target.innerHTML = state.imageApiKey
      ? '<span class="status-pill ok">Browser key saved</span>'
      : '<span class="status-pill warn">Auth status loading</span>';
    help.textContent = 'This field is only for this portal/browser. It is not a ComfyUI key and does not control model loading.';
    return;
  }

  if (!auth.enabled) {
    target.innerHTML = '<span class="status-pill ok">No API key needed</span>';
    help.textContent = 'Server-side image API auth is disabled, so the portal can call the dashboard API without a key. This field can stay blank and is not related to ComfyUI model loading.';
    return;
  }

  if (auth.configured_key_count === 0) {
    target.innerHTML = '<span class="status-pill bad">Auth misconfigured</span>';
    help.textContent = 'The server requires image API auth, but no IMAGE_API_KEYS are configured on the server. Set IMAGE_API_KEYS or disable REQUIRE_IMAGE_API_AUTH.';
    return;
  }

  if (state.imageApiKey) {
    target.innerHTML = '<span class="status-pill ok">Browser key saved</span>';
    help.textContent = 'This browser will send the saved value as Authorization: Bearer <key> to /api/v1. The key is stored only in this browser local storage.';
    return;
  }

  target.innerHTML = '<span class="status-pill warn">API key required</span>';
  help.textContent = 'Paste one server configured IMAGE_API_KEYS value. This is not a ComfyUI key; it only unlocks protected dashboard API calls from this browser.';
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
    target.textContent = imageApiAuthRequiredWithoutKey() ? 'Enter the dashboard API key above to load queue stats.' : 'No queue data yet.';
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

function friendlyPreloadError(status) {
  const error = status?.lastPreloadError;
  if (!error) return '<span class="muted">none</span>';
  if (error.code === 'MODEL_PRELOAD_MODEL_REQUIRED') {
    return '<span class="warn-text">No default checkpoint was selected for that action. Choose an installed checkpoint below, then click Load / Prewarm now, Set as default, or Set default + preload after restart.</span>';
  }
  if (error.code === 'IMAGE_PRELOAD_DEFAULT_MISSING') {
    return '<span class="warn-text">Preload after restart was skipped because no default checkpoint is configured.</span>';
  }
  if (error.code === 'IMAGE_PRELOAD_DEFAULT_FILE_MISSING') {
    return '<span class="danger-text">Preload after restart was skipped because the configured default checkpoint file is missing.</span>';
  }
  return `<span class="danger-text">${escapeHtml(error.code)}: ${escapeHtml(error.message)}</span>`;
}

function renderDefaultModelStatus() {
  const target = $('#default-model-status');
  if (!target) return;
  const status = currentPreloadStatus();
  if (!status) {
    target.innerHTML = imageApiAuthRequiredWithoutKey()
      ? '<p class="muted">Enter the dashboard API key above to load model lifecycle status.</p>'
      : '<p class="muted">No default model lifecycle status yet.</p>';
    return;
  }
  const hasDefault = Boolean(status.currentDefaultCheckpoint || status.defaultModel);
  const defaultExists = status.defaultFileExists;
  const defaultMissing = hasDefault && defaultExists === false;
  const preloadResult = status.lastPreloadResult || 'not_attempted';
  const canLoadDefault = hasDefault && !defaultMissing && !status.active;
  target.className = 'default-model-panel';
  target.innerHTML = `
    <div class="section-heading">
      <div>
        <h3>Default model status</h3>
        <p class="hint">Loaded status is reported only after a successful preload or generation. ComfyUI does not expose a reliable exact current-checkpoint API.</p>
      </div>
      <div class="badge-row">
        ${hasDefault ? badge('default configured', 'ok') : badge('no default selected', 'warn')}
        ${status.preloadOnStartup ? badge('preload after restart enabled', 'ok') : badge('preload after restart disabled', 'warn')}
        ${status.active ? badge('preload running', 'warn') : ''}
      </div>
    </div>
    ${renderKeyValues([
      ['Current default checkpoint', hasDefault ? `<code>${escapeHtml(status.currentDefaultCheckpoint || status.defaultModel)}</code>` : '<span class="muted">none selected yet</span>'],
      ['Default file exists', defaultExists === null ? '<span class="muted">n/a</span>' : escapeHtml(defaultExists ? 'yes' : 'no')],
      ['Preload after restart', escapeHtml(status.preloadOnStartup ? 'yes' : 'no')],
      ['Last preload attempt time', escapeHtml(formatDate(status.lastPreloadAttemptTime))],
      ['Last preload result', `<code>${escapeHtml(preloadResult)}</code>`],
      ['Last preload error/message', friendlyPreloadError(status)],
      ['Last confirmed loaded/prewarmed model', status.lastConfirmedLoadedModel ? `<code>${escapeHtml(status.lastConfirmedLoadedModel)}</code>` : '<span class="muted">not confirmed in this process</span>']
    ])}
    ${!hasDefault ? '<p class="notice warn">No default checkpoint is configured. Use Set as default or Set default + preload after restart from an installed checkpoint below.</p>' : ''}
    ${status.defaultWarning ? `<p class="notice warn">${escapeHtml(status.defaultWarning)}</p>` : ''}
    <div class="button-row lifecycle-actions">
      <button type="button" data-default-action="load" ${canLoadDefault ? '' : 'disabled'} title="${canLoadDefault ? '' : 'Select a valid default checkpoint first.'}">Load default now</button>
      <button type="button" class="secondary" data-default-action="enable-preload" ${hasDefault && !defaultMissing ? '' : 'disabled'}>Enable preload after restart</button>
      <button type="button" class="secondary" data-default-action="disable-preload">Disable preload after restart</button>
      <button type="button" class="secondary danger" data-default-action="clear-default" ${hasDefault ? '' : 'disabled'}>Clear default</button>
    </div>`;
}

function renderImageModels() {
  renderDefaultModelStatus();
  const target = $('#image-models');
  const models = state.imageModels?.models || [];
  if (models.length === 0) {
    target.innerHTML = imageApiAuthRequiredWithoutKey()
      ? '<p class="muted">Enter the dashboard API key above to scan installed models.</p>'
      : '<p class="muted">No local image models found in IMAGE_MODEL_PATHS.</p>';
    renderPlaygroundOptions();
    return;
  }
  const selected = selectedPlaygroundModel();
  target.innerHTML = `<div class="model-list lifecycle-list">${models.map((model) => {
    const isCheckpoint = model.type === 'checkpoint';
    const isSelected = selected && modelMatches(model, selected);
    const badges = [badge('installed on disk', 'ok')];
    if (isSelected) badges.push(badge('selected for generation', 'ok'));
    if (model.isDefault) badges.push(badge('default', 'ok'));
    if (model.isLastConfirmedLoaded) badges.push(badge('last loaded/prewarmed', 'ok'));
    if (model.loadedStatus === 'default_not_confirmed_loaded') badges.push(badge('default not confirmed loaded', 'warn'));
    if (model.defaultWarning) badges.push(badge('missing default file', 'bad'));
    if (!isCheckpoint) badges.push(badge('not a checkpoint', 'warn'));
    const disabledReason = isCheckpoint ? '' : 'Only checkpoint files can be loaded or set as the default image model.';
    return `<article class="model-item lifecycle-model" data-model-id="${escapeHtml(model.id)}">
      <div class="model-title-row">
        <div>
          <h3><code>${escapeHtml(model.relativePath)}</code></h3>
          <p class="hint">ComfyUI checkpoint name: <code>${escapeHtml(modelIdentifier(model))}</code></p>
        </div>
        <div class="badge-row">${badges.join('')}</div>
      </div>
      ${renderKeyValues([
        ['Type', escapeHtml(model.type)],
        ['Size', escapeHtml(formatBytes(model.sizeBytes))],
        ['Modified', escapeHtml(model.modifiedAt || 'n/a')],
        ['Loaded status', `<code>${escapeHtml(model.loadedStatus || 'not_confirmed_loaded')}</code>`],
        ['Can set default', escapeHtml(model.canSetDefault ? 'yes' : 'no')],
        ['Can load/prewarm', escapeHtml(model.canPreload ? 'yes' : 'no')],
        ['Can delete', escapeHtml(model.canDelete ? 'yes' : 'no')]
      ])}
      ${model.preloadWarning ? `<p class="notice warn">${escapeHtml(model.preloadWarning)}</p>` : ''}
      ${model.defaultWarning ? `<p class="notice warn">${escapeHtml(model.defaultWarning)}</p>` : ''}
      <div class="button-row model-actions">
        <button type="button" data-model-action="load" ${model.canPreload ? '' : 'disabled'} title="${escapeHtml(disabledReason)}">Load / Prewarm now</button>
        <button type="button" class="secondary" data-model-action="set-default" ${model.canSetDefault ? '' : 'disabled'} title="${escapeHtml(disabledReason)}">Set as default</button>
        <button type="button" class="secondary" data-model-action="set-default-preload" ${model.canSetDefault ? '' : 'disabled'} title="${escapeHtml(disabledReason)}">Set default + preload after restart</button>
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
    target.innerHTML = imageApiAuthRequiredWithoutKey() ? '<p class="muted">Enter the dashboard API key above to load workflow presets.</p>' : '<p class="muted">No workflow presets loaded.</p>';
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

function jobTimings(job) {
  return job.timings || {
    queueWaitMs: job.queueWaitMs ?? null,
    executionMs: job.executionMs ?? null,
    totalMs: job.totalMs ?? null,
    secondsPerStep: job.secondsPerStep ?? null,
    stepsPerSecond: job.stepsPerSecond ?? null
  };
}

function jobPrompt(job) {
  return job.prompt || job.request?.prompt || '';
}

function jobNegativePrompt(job) {
  return job.negativePrompt || job.request?.negativePrompt || job.request?.negative_prompt || '';
}

function jobArtifacts(job) {
  return Array.isArray(job.artifacts) ? job.artifacts : [];
}

function firstArtifactUrl(job) {
  return job.thumbnailUrl || jobArtifacts(job).find((artifact) => artifact?.url)?.url || '';
}

function hydrateJobThumbnails() {
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
        image.nextElementSibling?.replaceWith(Object.assign(document.createElement('div'), { className: 'thumb-placeholder', textContent: 'Thumbnail unavailable' }));
      });
  }
}

function renderJobMetrics(job) {
  const timings = jobTimings(job);
  const artifacts = jobArtifacts(job);
  const prompt = jobPrompt(job);
  const providerMetadata = job.metadata?.provider || job.providerMetadata || job.metadata || {};
  const tokenValue = providerMetadata?.tokens ?? providerMetadata?.token_count ?? providerMetadata?.prompt_tokens ?? null;
  return `<div class="metrics job-metrics">
    <div class="metric"><span>Total time</span><strong>${formatDurationMs(timings.totalMs)}</strong></div>
    <div class="metric"><span>Execution</span><strong>${formatDurationMs(timings.executionMs)}</strong></div>
    <div class="metric"><span>Queue wait</span><strong>${formatDurationMs(timings.queueWaitMs)}</strong></div>
    <div class="metric"><span>Step speed</span><strong>${timings.stepsPerSecond ? `${formatNumber(timings.stepsPerSecond, ' steps/s')}` : 'n/a'}</strong></div>
    <div class="metric"><span>Steps</span><strong>${escapeHtml(job.steps ?? job.request?.steps ?? 'n/a')}</strong></div>
    <div class="metric"><span>Prompt chars</span><strong>${escapeHtml(prompt.length)}</strong></div>
    <div class="metric"><span>Token metrics</span><strong>${tokenValue === null || tokenValue === undefined ? 'n/a' : escapeHtml(tokenValue)}</strong></div>
    <div class="metric"><span>Artifacts</span><strong>${escapeHtml(artifacts.length || job.artifactCount || 0)}</strong></div>
  </div>`;
}

function renderJobs() {
  const target = $('#image-jobs');
  const jobs = state.imageJobs?.jobs || state.imageStats?.recent_jobs || [];
  if (jobs.length === 0) {
    target.innerHTML = imageApiAuthRequiredWithoutKey()
      ? '<p class="muted">Enter the dashboard API key above to load recent image jobs.</p>'
      : '<p class="muted">No image jobs submitted since this process started.</p>';
    return;
  }
  target.innerHTML = `<div class="job-list image-job-list">${jobs.map((job) => {
    const prompt = jobPrompt(job);
    const negative = jobNegativePrompt(job);
    const imageUrl = firstArtifactUrl(job);
    const artifacts = jobArtifacts(job);
    const statusClass = job.status === 'succeeded' ? 'ok' : job.status === 'failed' ? 'bad' : 'warn';
    return `<article class="job-item image-job-card">
      <div class="job-thumb">
        ${imageUrl ? `<a href="${escapeHtml(imageUrl)}" target="_blank" rel="noopener"><img data-artifact-url="${escapeHtml(imageUrl)}" alt="Generated image thumbnail for job ${escapeHtml(job.id)}" loading="lazy" hidden><div class="thumb-placeholder">Loading thumbnail...</div></a>` : '<div class="thumb-placeholder">No image yet</div>'}
      </div>
      <div class="job-main">
        <div class="model-title-row">
          <div>
            <h3><code>${escapeHtml(job.id)}</code></h3>
            <p class="muted">${escapeHtml(job.provider || 'provider n/a')} | ${escapeHtml(job.workflowId || 'workflow n/a')} | ${job.model ? `<code>${escapeHtml(job.model)}</code>` : 'model n/a'}</p>
          </div>
          <span class="status-pill ${statusClass}">${escapeHtml(job.status)}</span>
        </div>
        <p class="prompt-label">Prompt</p>
        <p class="prompt-text">${prompt ? escapeHtml(prompt) : '<span class="muted">No prompt recorded</span>'}</p>
        ${negative ? `<p class="prompt-label">Negative prompt</p><p class="prompt-text muted">${escapeHtml(negative)}</p>` : ''}
        ${renderJobMetrics(job)}
        ${renderKeyValues([
          ['Size', escapeHtml(`${job.width ?? job.request?.width ?? 'n/a'} x ${job.height ?? job.request?.height ?? 'n/a'}`)],
          ['Seed', escapeHtml(job.seed ?? job.request?.seed ?? 'n/a')],
          ['CFG / sampler', escapeHtml(`${job.cfgScale ?? job.request?.cfgScale ?? job.request?.cfg_scale ?? 'n/a'} / ${job.samplerName ?? job.request?.samplerName ?? job.request?.sampler_name ?? 'n/a'}`)],
          ['Scheduler', escapeHtml(job.scheduler ?? job.request?.scheduler ?? 'n/a')],
          ['Created', escapeHtml(formatDate(job.createdAt))],
          ['Completed', escapeHtml(formatDate(job.completedAt))]
        ])}
        ${artifacts.length ? `<p class="hint">Artifact sizes: ${escapeHtml(artifacts.map((artifact) => formatBytes(artifact.sizeBytes)).join(', '))}</p>` : ''}
        ${job.error ? `<p class="danger-text">${escapeHtml(job.error.code)}: ${escapeHtml(job.error.message)}</p>` : ''}
        <details>
          <summary>Raw request and provider metadata</summary>
          <pre><code>${escapeHtml(JSON.stringify({ request: job.request || {}, metadata: job.metadata || {}, artifacts }, null, 2))}</code></pre>
        </details>
      </div>
    </article>`;
  }).join('')}</div>`;
  hydrateJobThumbnails();
}

function renderGpus() {
  const target = $('#gpu-list');
  const gpuSummary = state.imageStats?.gpu || state.imageHealth?.gpu;
  const gpus = gpuSummary?.gpus || [];
  if (!gpuSummary?.ok) {
    target.innerHTML = `<p class="muted">GPU telemetry unavailable: ${escapeHtml(gpuSummary?.error?.message || (imageApiAuthRequiredWithoutKey() ? 'enter dashboard API key above to load API-backed telemetry' : 'no data yet'))}</p>`;
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
    target.innerHTML = imageApiAuthRequiredWithoutKey() ? '<p class="muted">Enter the dashboard API key above to load model download jobs.</p>' : '<p class="muted">No download metadata loaded.</p>';
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
    target.innerHTML = imageApiAuthRequiredWithoutKey() ? '<p class="muted">Enter the dashboard API key above to load the local catalog.</p>' : '<p class="muted">No local catalog entries configured.</p>';
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
  const firstCheckpoint = checkpoints[0] || null;
  const selectedValue = checkpoints.some((model) => modelMatches(model, previous))
    ? previous
    : defaultItem
      ? modelIdentifier(defaultItem)
      : firstCheckpoint
        ? modelIdentifier(firstCheckpoint)
        : '';

  const placeholder = checkpoints.length > 0
    ? 'Choose a checkpoint to send'
    : 'No checkpoint models found';
  modelSelect.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` + checkpoints.map((model) => {
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
  const checkpoints = checkpointModels();
  if (!model) {
    target.innerHTML = checkpoints.length === 0
      ? '<span class="status-pill warn">No checkpoint installed</span> Install or download a checkpoint before generating.'
      : '<span class="status-pill warn">No checkpoint selected</span> Choose a checkpoint before generating.';
    return;
  }
  const selectedModel = checkpoints.find((candidate) => modelMatches(candidate, model));
  const defaultMissing = status?.currentDefaultCheckpoint && status.defaultFileExists === false;
  target.innerHTML = `${selectedModel?.isDefault ? badge('default', 'ok') : badge('selected for generation', 'ok')} ${selectedModel?.isLastConfirmedLoaded ? badge('last loaded/prewarmed', 'ok') : badge('not confirmed loaded', 'warn')} ${defaultMissing ? badge('configured default missing', 'bad') : ''} Request will send checkpoint <code>${escapeHtml(model)}</code>.`;
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
    metadata: { source: 'portal-generator' }
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

function renderGenerationResult(result) {
  const artifacts = result.artifacts || result.job?.artifacts || [];
  const first = artifacts.find((artifact) => artifact?.url);
  const job = result.job || {};
  const statusClass = job.status === 'succeeded' ? 'ok' : job.status === 'failed' ? 'bad' : 'warn';
  const thumbnail = first?.url
    ? `<a href="${escapeHtml(first.url)}" target="_blank" rel="noopener"><img class="result-image" data-artifact-url="${escapeHtml(first.url)}" alt="Generated image result" loading="lazy" hidden><div class="thumb-placeholder">Loading result image...</div></a>`
    : '';
  return `<div class="generation-result">
    <p><span class="status-pill ${statusClass}">${escapeHtml(job.status || 'submitted')}</span> Job <code>${escapeHtml(job.id || 'n/a')}</code></p>
    ${thumbnail}
    ${renderKeyValues([
      ['Model', job.model ? `<code>${escapeHtml(job.model)}</code>` : '<span class="muted">n/a</span>'],
      ['Prompt', escapeHtml(job.prompt || job.request?.prompt || buildPlaygroundPayload().prompt || '')],
      ['Total time', escapeHtml(formatDurationMs(job.totalMs ?? job.timings?.totalMs))],
      ['Execution time', escapeHtml(formatDurationMs(job.executionMs ?? job.timings?.executionMs))],
      ['Artifacts', escapeHtml(artifacts.length)]
    ])}
    <details>
      <summary>Full API response</summary>
      <pre><code>${escapeHtml(JSON.stringify(result, null, 2))}</code></pre>
    </details>
  </div>`;
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

  const publicHealth = await fetchJson('/health').catch((error) => {
    state.imageError = error;
    return null;
  });
  if (publicHealth) state.imageHealth = publicHealth;

  if (imageApiAuthRequiredWithoutKey()) {
    state.imageStats = null;
    state.imageModels = null;
    state.imageWorkflows = null;
    state.imageJobs = null;
    state.modelDownloads = null;
    state.modelCatalog = null;
    state.imageError = new Error('Dashboard API key required for protected /api/v1 calls. Paste one IMAGE_API_KEYS value above.');
    state.imageError.status = 401;
    return;
  }

  const [stats, models, workflows, jobs, downloads, catalog] = await Promise.allSettled([
    fetchJson('/api/v1/stats'),
    fetchJson('/api/v1/models'),
    fetchJson('/api/v1/workflows'),
    fetchJson('/api/v1/jobs?limit=10'),
    fetchJson('/api/v1/model-downloads?limit=20'),
    fetchJson('/api/v1/model-catalog')
  ]);

  if (stats.status === 'fulfilled') state.imageStats = stats.value;
  if (models.status === 'fulfilled') state.imageModels = models.value;
  if (workflows.status === 'fulfilled') state.imageWorkflows = workflows.value;
  if (jobs.status === 'fulfilled') state.imageJobs = jobs.value;
  if (downloads.status === 'fulfilled') state.modelDownloads = downloads.value;
  if (catalog.status === 'fulfilled') state.modelCatalog = catalog.value;

  const rejected = [stats, models, workflows, jobs, downloads, catalog].find((result) => result.status === 'rejected');
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
    if (action === 'load') {
      setImageFeedback(`Loading/prewarming ${identifier}...`);
      await fetchJson('/api/v1/models/preload', { method: 'POST', body: JSON.stringify({ model: identifier }) });
      await refreshModelsOnly(`Loaded/prewarmed ${identifier}.`);
      return;
    }
    if (action === 'set-default') {
      await fetchJson('/api/v1/models/default', { method: 'POST', body: JSON.stringify({ model: identifier }) });
      await refreshModelsOnly(`Set ${identifier} as the default checkpoint.`);
      return;
    }
    if (action === 'set-default-preload') {
      await fetchJson('/api/v1/models/default', { method: 'POST', body: JSON.stringify({ model: identifier, preload_on_startup: true }) });
      await refreshModelsOnly(`Set ${identifier} as default and enabled preload after restart.`);
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
  if (!button || button.disabled) return;
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
      await refreshModelsOnly('Enabled preload after restart.');
      return;
    }
    if (action === 'disable-preload') {
      await fetchJson('/api/v1/models/preload/startup', { method: 'POST', body: JSON.stringify({ enabled: false }) });
      await refreshModelsOnly('Disabled preload after restart.');
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
    $('#playground-result').innerHTML = renderGenerationResult(result);
    hydrateJobThumbnails();
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
      setImageFeedback(`Loading/prewarming ${model}...`);
      await fetchJson('/api/v1/models/preload', { method: 'POST', body: JSON.stringify({ model }) });
      await refreshModelsOnly(`Loaded/prewarmed ${model}.`);
    }
    if (action === 'default') {
      await fetchJson('/api/v1/models/default', { method: 'POST', body: JSON.stringify({ model }) });
      await refreshModelsOnly(`Set ${model} as the default checkpoint.`);
    }
    if (action === 'startup') {
      await fetchJson('/api/v1/models/default', { method: 'POST', body: JSON.stringify({ model, preload_on_startup: true }) });
      await refreshModelsOnly(`Set ${model} as default and enabled preload after restart.`);
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
