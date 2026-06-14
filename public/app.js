const $ = (selector) => document.querySelector(selector);

const state = {
  health: null,
  config: null,
  runningModels: [],
  installedModels: [],
  gpus: [],
  imageApiKey: window.localStorage.getItem('local-ai-image-api-key') || '',
  imageHealth: null,
  imageStats: null,
  imageModels: null,
  imageWorkflows: null,
  imageJobs: null,
  imageError: null
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

function renderHealth() {
  const target = $('#health-content');
  const health = state.health;
  if (!health) {
    target.textContent = 'No health data yet.';
    return;
  }

  const loadedClass = health.default_model_loaded ? 'ok' : 'warn';
  target.innerHTML = `
    <p>${statusPill(health.ok)}</p>
    ${renderKeyValues([
      ['Service', escapeHtml(health.service || 'Local AI LLM Monitor')],
      ['App version', escapeHtml(health.version || 'unknown')],
      ['Ollama', escapeHtml(health.ollama?.ok ? `reachable ${health.ollama?.version ? `(v${health.ollama.version})` : ''}` : `unreachable: ${health.error?.message || 'unknown error'}`)],
      ['Default model', `<code>${escapeHtml(health.default_model || '')}</code>`],
      ['Default loaded', `<span class="status-pill ${loadedClass}">${health.default_model_loaded ? 'Loaded' : 'Not loaded'}</span>`],
      ['Running model count', escapeHtml((health.running_models || []).length)]
    ])}`;
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

function renderConfig() {
  if (state.config?.config?.default_model) {
    $('#default-model-input').value = state.config.config.default_model;
  }
}

function renderModels(targetSelector, models, emptyMessage) {
  const target = $(targetSelector);
  if (!models || models.length === 0) {
    target.innerHTML = `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
    return;
  }
  target.innerHTML = `<div class="model-list">${models.map((model) => {
    const name = model.name || model.model || 'unnamed model';
    return `<article class="model-item">
      <h3><code>${escapeHtml(name)}</code></h3>
      ${renderKeyValues([
        ['Model', `<code>${escapeHtml(model.model || name)}</code>`],
        ['Size', model.size ? escapeHtml(`${model.size.toLocaleString()} bytes`) : 'n/a'],
        ['VRAM size', model.size_vram ? escapeHtml(`${model.size_vram.toLocaleString()} bytes`) : 'n/a'],
        ['Parameters', escapeHtml(model.details?.parameter_size || 'n/a')],
        ['Quantization', escapeHtml(model.details?.quantization_level || 'n/a')],
        ['Expires', escapeHtml(model.expires_at || model.modified_at || 'n/a')]
      ])}
    </article>`;
  }).join('')}</div>`;
}

function renderImageModels() {
  const target = $('#image-models');
  const models = state.imageModels?.models || [];
  if (models.length === 0) {
    target.innerHTML = '<p class="muted">No local image models found in IMAGE_MODEL_PATHS.</p>';
    return;
  }
  target.innerHTML = `<div class="model-list compact">${models.slice(0, 12).map((model) => `<article class="model-item">
    <h3><code>${escapeHtml(model.relativePath)}</code></h3>
    ${renderKeyValues([
      ['Type', escapeHtml(model.type)],
      ['Size', escapeHtml(formatBytes(model.sizeBytes))],
      ['Modified', escapeHtml(model.modifiedAt || 'n/a')]
    ])}
  </article>`).join('')}</div>
  ${models.length > 12 ? `<p class="hint">Showing 12 of ${escapeHtml(models.length)} scanned model files.</p>` : ''}`;
}

function renderWorkflows() {
  const target = $('#image-workflows');
  const workflows = state.imageWorkflows?.workflows || [];
  if (workflows.length === 0) {
    target.innerHTML = '<p class="muted">No workflow presets loaded.</p>';
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
  const gpus = state.gpus;
  if (!gpus || gpus.length === 0) {
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

function renderAll() {
  renderImageAuth();
  renderImageHealth();
  renderQueue();
  renderImageModels();
  renderWorkflows();
  renderJobs();
  renderHealth();
  renderConfig();
  renderModels('#running-models', state.runningModels, 'No models are currently loaded in Ollama memory.');
  renderModels('#installed-models', state.installedModels, 'No installed models returned by Ollama.');
  renderGpus();
}

async function refreshImageApi() {
  state.imageError = null;
  const [health, stats, models, workflows, jobs] = await Promise.allSettled([
    fetchJson('/api/v1/health'),
    fetchJson('/api/v1/stats'),
    fetchJson('/api/v1/models'),
    fetchJson('/api/v1/workflows'),
    fetchJson('/api/v1/jobs?limit=10')
  ]);

  if (health.status === 'fulfilled') state.imageHealth = health.value;
  if (stats.status === 'fulfilled') state.imageStats = stats.value;
  if (models.status === 'fulfilled') state.imageModels = models.value;
  if (workflows.status === 'fulfilled') state.imageWorkflows = workflows.value;
  if (jobs.status === 'fulfilled') state.imageJobs = jobs.value;

  const rejected = [health, stats, models, workflows, jobs].find((result) => result.status === 'rejected');
  if (rejected) {
    state.imageError = rejected.reason;
    console.warn(rejected.reason);
  }
}

async function refresh() {
  const feedback = $('#operation-feedback');
  try {
    const [health, config, running, installed, gpus] = await Promise.allSettled([
      fetchJson('/health'),
      fetchJson('/config'),
      fetchJson('/models/running'),
      fetchJson('/models/installed'),
      fetchJson('/gpus')
    ]);

    if (health.status === 'fulfilled') state.health = health.value;
    if (config.status === 'fulfilled') state.config = config.value;
    if (running.status === 'fulfilled') state.runningModels = running.value.models || [];
    if (installed.status === 'fulfilled') state.installedModels = installed.value.models || [];
    if (gpus.status === 'fulfilled') state.gpus = gpus.value.gpus || [];

    for (const result of [health, config, running, installed, gpus]) {
      if (result.status === 'rejected') console.warn(result.reason);
    }

    await refreshImageApi();
    renderAll();
  } catch (error) {
    feedback.className = 'feedback error';
    feedback.textContent = error.message;
  }
}

function setFeedback(message, ok = true) {
  const feedback = $('#operation-feedback');
  feedback.className = `feedback ${ok ? 'ok' : 'error'}`;
  feedback.textContent = message;
}

function setImageFeedback(message, ok = true) {
  const feedback = $('#image-feedback');
  feedback.className = `feedback ${ok ? 'ok' : 'error'}`;
  feedback.textContent = message;
}

$('#refresh-button').addEventListener('click', refresh);

$('#api-key-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.imageApiKey = $('#api-key-input').value.trim();
  if (state.imageApiKey) window.localStorage.setItem('local-ai-image-api-key', state.imageApiKey);
  else window.localStorage.removeItem('local-ai-image-api-key');
  setImageFeedback(state.imageApiKey ? 'Saved API key in this browser only.' : 'Cleared browser API key.');
  await refresh();
});

$('#clear-key-button').addEventListener('click', async () => {
  state.imageApiKey = '';
  window.localStorage.removeItem('local-ai-image-api-key');
  $('#api-key-input').value = '';
  setImageFeedback('Cleared browser API key.');
  await refresh();
});

$('#refresh-models-button').addEventListener('click', async () => {
  try {
    setImageFeedback('Refreshing model inventory...');
    state.imageModels = await fetchJson('/api/v1/models/refresh', { method: 'POST' });
    setImageFeedback(`Scanned ${state.imageModels.models.length} model files.`);
    renderImageModels();
  } catch (error) {
    setImageFeedback(`Unable to refresh model inventory: ${error.message}`, false);
  }
});

$('#config-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const defaultModel = $('#default-model-input').value.trim();
  try {
    const result = await fetchJson('/config', {
      method: 'POST',
      body: JSON.stringify({ default_model: defaultModel })
    });
    state.config = result;
    setFeedback(`Saved default model ${defaultModel}.`);
    await refresh();
  } catch (error) {
    setFeedback(`Unable to save default model: ${error.message}`, false);
  }
});

$('#load-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const model = $('#load-model-input').value.trim();
  const makeDefault = $('#make-default-input').checked;
  try {
    setFeedback(`Loading ${model}...`);
    const result = await fetchJson('/model/load', {
      method: 'POST',
      body: JSON.stringify({ model, make_default: makeDefault })
    });
    setFeedback(`${result.model} pre-warmed. Loaded: ${result.loaded ? 'yes' : 'verification pending'}.`);
    await refresh();
  } catch (error) {
    setFeedback(`Unable to load model: ${error.message}`, false);
  }
});

$('#prewarm-default-button').addEventListener('click', async () => {
  try {
    const defaultModel = $('#default-model-input').value.trim();
    setFeedback(`Pre-warming ${defaultModel || 'default model'}...`);
    const result = await fetchJson('/model/prewarm', {
      method: 'POST',
      body: JSON.stringify(defaultModel ? { model: defaultModel } : {})
    });
    setFeedback(`${result.model} pre-warmed. Loaded: ${result.loaded ? 'yes' : 'verification pending'}.`);
    await refresh();
  } catch (error) {
    setFeedback(`Unable to pre-warm model: ${error.message}`, false);
  }
});

refresh();
setInterval(refresh, 10000);
