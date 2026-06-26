const $ = (selector) => document.querySelector(selector);

const DEFAULT_GALLERY_LIMIT = 48;
const MAX_GALLERY_LIMIT = 250;
const GALLERY_LIMIT_STEP = 48;
const DEFAULT_TILE_SIZE = 300;
const GALLERY_SIZE_STORAGE_KEY = 'local-ai-images-gallery-size';
const CONTROLS_HEIGHT_STORAGE_KEY = 'local-ai-images-controls-height';
const CONTROLS_MIN_HEIGHT = 240;
const CONTROLS_DEFAULT_HEIGHT = 320;
const CONTROLS_MAX_VIEWPORT_RATIO = 0.58;
const GENERATION_POLL_INTERVAL_MS = 1500;
const GENERATION_POLL_ATTEMPTS = 1200;
const GENERATION_POLL_FAILURE_LIMIT = 5;
const CANCELABLE_JOB_STATES = new Set(['queued', 'pending', 'submitting', 'running', 'generating', 'loading']);
const TERMINAL_JOB_STATES = new Set(['succeeded', 'failed', 'canceled']);
const IMAGE_VIEWER_INACTIVITY_MS = 3000;
const IMAGE_VIEWER_MAX_NATURAL_SCALE = 4;
const IMAGE_VIEWER_ZOOM_WHEEL_SPEED = 0.0015;
const IMAGE_VIEWER_ZOOM_BUTTON_STEP = 1.18;

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
  cancelRequests: new Map(),
  nextClientJobSequence: 0,
  prewarmingModel: null,
  loadedFavoritePayloadBase: null,
  galleryLimit: DEFAULT_GALLERY_LIMIT,
  galleryTileSize: readStoredGallerySize(),
  controlsHeight: readStoredControlsHeight(),
  lastResult: null
};

const galleryImageDrag = {
  isDragging: false,
  lastEndedAt: 0,
  resetTimer: null
};

const imageViewer = {
  overlay: null,
  stage: null,
  image: null,
  message: null,
  closeButton: null,
  downloadButton: null,
  cleanupCallbacks: [],
  inactivityTimer: null,
  previousBodyOverflow: '',
  previousDocumentOverflow: '',
  previousActiveElement: null,
  isOpen: false,
  isLoaded: false,
  isPanning: false,
  isControlActive: false,
  naturalWidth: 0,
  naturalHeight: 0,
  minScale: 1,
  maxScale: IMAGE_VIEWER_MAX_NATURAL_SCALE,
  scale: 1,
  translateX: 0,
  translateY: 0,
  pointerStartX: 0,
  pointerStartY: 0,
  pointerStartTranslateX: 0,
  pointerStartTranslateY: 0
};

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

function syncNegativePromptDrawerLayout() {
  const drawer = $('#image-lab-negative-drawer');
  const stack = $('.image-lab-prompt-stack');
  if (!drawer || !stack) return;
  stack.classList.toggle('has-negative-open', Boolean(drawer.open));
}

function setNegativePromptDrawerOpen(open) {
  const drawer = $('#image-lab-negative-drawer');
  if (!drawer) return;
  const shouldOpen = Boolean(open);
  if (drawer.open !== shouldOpen) drawer.open = shouldOpen;
  syncNegativePromptDrawerLayout();
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

function firstDefinedValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function isTerminalJobStatus(status) {
  return TERMINAL_JOB_STATES.has(String(status || '').toLowerCase());
}

function isActiveJobStatus(status) {
  return CANCELABLE_JOB_STATES.has(String(status || '').toLowerCase());
}

function isClientOnlyJobId(id) {
  return String(id || '').startsWith('pending-');
}

function backendJobIdForCancel(job) {
  const id = String(job?.id || '').trim();
  if (!id || isClientOnlyJobId(id)) return null;
  return id;
}

function cancelRequestKeyForJob(job) {
  return String(job?.clientId || job?.id || '').trim();
}

function cancelRequestForJob(job) {
  const key = cancelRequestKeyForJob(job);
  return key ? state.cancelRequests.get(key) || null : null;
}

function hasCancelRequested(job) {
  return Boolean(
    job?.cancelRequestedAt
    || job?.metadata?.cancelRequestedAt
    || cancelRequestForJob(job)?.requestedAt
  );
}

function hasCancelFailed(job) {
  return Boolean(
    job?.cancelFailedAt
    || job?.metadata?.cancelFailedAt
    || cancelRequestForJob(job)?.failedAt
  );
}

function hasActiveCancelFailure(job) {
  return hasCancelFailed(job) && !isTerminalJobStatus(job?.status);
}

function isCancelableJob(job) {
  const status = String(job?.status || '').toLowerCase();
  if (!job || isTerminalJobStatus(status) || hasCancelRequested(job)) return false;
  return Boolean(job.isClientPending || isActiveJobStatus(status));
}

function pendingJobForClient(clientId) {
  return (state.pendingJobs || []).find((job) => job.clientId === clientId || job.id === clientId) || null;
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


const RESOLUTION_PRESETS = [
  { category: 'Prototype / fast iteration', width: 512, height: 512, label: 'small square draft' },
  { category: 'Prototype / fast iteration', width: 768, height: 512, label: '3:2 landscape draft' },
  { category: 'Prototype / fast iteration', width: 512, height: 768, label: '2:3 portrait draft' },
  { category: 'Prototype / fast iteration', width: 896, height: 640, label: '7:5 wide draft' },
  { category: 'Prototype / fast iteration', width: 640, height: 896, label: '5:7 tall draft' },
  { category: 'Prototype / fast iteration', width: 768, height: 768, label: 'larger square draft' },

  { category: 'SDXL tuned ladder / about 1 MP', width: 704, height: 1408, label: 'very tall poster' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 704, height: 1344, label: 'tall portrait' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 768, height: 1344, label: 'tall mobile portrait' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 768, height: 1280, label: 'classic tall portrait' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 832, height: 1216, label: 'mobile portrait' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 832, height: 1152, label: 'soft portrait' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 896, height: 1152, label: 'known-good portrait' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 896, height: 1088, label: 'near portrait' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 960, height: 1088, label: 'slight portrait' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 960, height: 1024, label: 'near square portrait' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 1024, height: 1024, label: 'square baseline' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 1024, height: 960, label: 'near square landscape' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 1088, height: 960, label: 'slight landscape' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 1088, height: 896, label: 'near landscape' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 1152, height: 896, label: 'known-good landscape' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 1152, height: 832, label: 'soft landscape' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 1216, height: 832, label: 'wide landscape' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 1280, height: 768, label: 'classic wide landscape' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 1344, height: 768, label: 'cinematic landscape' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 1344, height: 704, label: 'ultrawide' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 1408, height: 704, label: 'wide poster' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 1472, height: 704, label: 'ultrawide landscape' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 1536, height: 640, label: 'cinematic ultrawide' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 1600, height: 640, label: 'wide banner' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 1664, height: 576, label: 'panorama' },
  { category: 'SDXL tuned ladder / about 1 MP', width: 1728, height: 576, label: 'extra-wide panorama' },

  { category: 'High detail / SDXL aspect families', width: 1152, height: 1472, label: 'portrait step-up' },
  { category: 'High detail / SDXL aspect families', width: 1344, height: 1728, label: '7:9 portrait step-up' },
  { category: 'High detail / SDXL aspect families', width: 1216, height: 1664, label: 'tall portrait step-up' },
  { category: 'High detail / SDXL aspect families', width: 1152, height: 1728, label: '2:3 portrait step-up' },
  { category: 'High detail / SDXL aspect families', width: 1088, height: 1920, label: 'near 9:16 portrait' },
  { category: 'High detail / SDXL aspect families', width: 1408, height: 1408, label: 'large square' },
  { category: 'High detail / SDXL aspect families', width: 1536, height: 1536, label: 'extra square' },
  { category: 'High detail / SDXL aspect families', width: 1472, height: 1152, label: 'landscape step-up' },
  { category: 'High detail / SDXL aspect families', width: 1728, height: 1344, label: '9:7 landscape step-up' },
  { category: 'High detail / SDXL aspect families', width: 1664, height: 1216, label: 'wide landscape step-up' },
  { category: 'High detail / SDXL aspect families', width: 1728, height: 1152, label: '3:2 landscape step-up' },
  { category: 'High detail / SDXL aspect families', width: 1920, height: 1088, label: 'near 16:9 landscape' },
  { category: 'High detail / SDXL aspect families', width: 2048, height: 1024, label: '2:1 wide landscape' },

  { category: 'RTX 3090 / 24 GB experiments', width: 1536, height: 2048, label: '3:4 portrait' },
  { category: 'RTX 3090 / 24 GB experiments', width: 1792, height: 2304, label: '7:9 portrait upscale' },
  { category: 'RTX 3090 / 24 GB experiments', width: 1536, height: 2304, label: '2:3 portrait' },
  { category: 'RTX 3090 / 24 GB experiments', width: 1536, height: 2560, label: '3:5 tall portrait' },
  { category: 'RTX 3090 / 24 GB experiments', width: 1664, height: 2560, label: 'tall portrait' },
  { category: 'RTX 3090 / 24 GB experiments', width: 2048, height: 2048, label: 'very large square' },
  { category: 'RTX 3090 / 24 GB experiments', width: 2048, height: 1536, label: '4:3 landscape' },
  { category: 'RTX 3090 / 24 GB experiments', width: 2304, height: 1792, label: '9:7 landscape upscale' },
  { category: 'RTX 3090 / 24 GB experiments', width: 2304, height: 1536, label: '3:2 landscape' },
  { category: 'RTX 3090 / 24 GB experiments', width: 2560, height: 1536, label: '5:3 wide landscape' },
  { category: 'RTX 3090 / 24 GB experiments', width: 2560, height: 1664, label: 'wide landscape' },
  { category: 'RTX 3090 / 24 GB experiments', width: 2688, height: 1536, label: 'cinematic landscape' },

  { category: 'Extreme / may require tiling or offload', width: 2304, height: 3072, label: '3:4 portrait' },
  { category: 'Extreme / may require tiling or offload', width: 2688, height: 3456, label: '7:9 portrait max' },
  { category: 'Extreme / may require tiling or offload', width: 2176, height: 3840, label: 'near 9:16 portrait' },
  { category: 'Extreme / may require tiling or offload', width: 3072, height: 2304, label: '4:3 landscape' },
  { category: 'Extreme / may require tiling or offload', width: 3456, height: 2688, label: '9:7 landscape max' },
  { category: 'Extreme / may require tiling or offload', width: 3840, height: 2176, label: 'near 16:9 landscape' },
  { category: 'Extreme / may require tiling or offload', width: 3072, height: 3072, label: 'huge square' },
  { category: 'Extreme / may require tiling or offload', width: 4096, height: 4096, label: 'max square' }
];

function resolutionPresetValue(width, height) {
  return `${width}x${height}`;
}

function resolutionPresetOptionValue(preset) {
  return resolutionPresetValue(preset.width, preset.height);
}

function resolutionPresetOrientation(preset) {
  if (preset.height > preset.width) return 'portrait';
  if (preset.width > preset.height) return 'landscape';
  return 'square';
}

function resolutionPresetMatchesOrientation(preset, orientation) {
  return resolutionPresetOrientation(preset) === orientation;
}

function resolutionPresetFromValue(value, orientation) {
  return RESOLUTION_PRESETS.find((preset) => resolutionPresetOptionValue(preset) === value && resolutionPresetMatchesOrientation(preset, orientation)) || null;
}

function formatMegapixels(width, height) {
  const megapixels = (Number(width) * Number(height)) / 1000000;
  return `${megapixels < 1 ? megapixels.toFixed(2) : megapixels.toFixed(1)} MP`;
}

function greatestCommonDivisor(a, b) {
  let x = Math.abs(Number(a));
  let y = Math.abs(Number(b));
  while (y) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return x || 1;
}

function aspectRatioLabel(width, height) {
  const divisor = greatestCommonDivisor(width, height);
  return `${Number(width) / divisor}:${Number(height) / divisor}`;
}

function resolutionPresetLabel(preset) {
  return `${preset.width} x ${preset.height} - ${preset.label} (${aspectRatioLabel(preset.width, preset.height)}; ${formatMegapixels(preset.width, preset.height)})`;
}

function numericInputValue(selector) {
  const value = Number($(selector)?.value || 0);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function matchedResolutionPresetValue(widthSelector, heightSelector, orientation) {
  const width = numericInputValue(widthSelector);
  const height = numericInputValue(heightSelector);
  if (!width || !height) return '';
  const match = RESOLUTION_PRESETS.find((preset) => preset.width === width && preset.height === height && resolutionPresetMatchesOrientation(preset, orientation));
  return match ? resolutionPresetOptionValue(match) : '';
}

function syncResolutionPresetToDimensions(selectSelector, widthSelector, heightSelector, orientation) {
  const select = $(selectSelector);
  if (!select) return;
  select.value = matchedResolutionPresetValue(widthSelector, heightSelector, orientation);
}

function syncResolutionPresetGroup(selectConfigs, widthSelector, heightSelector) {
  for (const config of selectConfigs) {
    syncResolutionPresetToDimensions(config.selector, widthSelector, heightSelector, config.orientation);
  }
}

function renderResolutionPresetOptions(selectSelector, widthSelector, heightSelector, orientation, customLabel = 'Custom/manual size') {
  const select = $(selectSelector);
  if (!select) return;
  let activeCategory = '';
  let html = `<option value="">${escapeHtml(customLabel)}</option>`;
  for (const preset of RESOLUTION_PRESETS) {
    if (!resolutionPresetMatchesOrientation(preset, orientation)) continue;
    if (preset.category !== activeCategory) {
      if (activeCategory) html += '</optgroup>';
      activeCategory = preset.category;
      html += `<optgroup label="${escapeHtml(activeCategory)}">`;
    }
    html += `<option value="${escapeHtml(resolutionPresetOptionValue(preset))}">${escapeHtml(resolutionPresetLabel(preset))}</option>`;
  }
  if (activeCategory) html += '</optgroup>';
  select.innerHTML = html;
  syncResolutionPresetToDimensions(selectSelector, widthSelector, heightSelector, orientation);
}

function renderResolutionPresetGroup(selectConfigs, widthSelector, heightSelector) {
  for (const config of selectConfigs) {
    renderResolutionPresetOptions(config.selector, widthSelector, heightSelector, config.orientation, config.customLabel);
  }
  syncResolutionPresetGroup(selectConfigs, widthSelector, heightSelector);
}

function applyResolutionPreset(selectSelector, widthSelector, heightSelector, orientation, selectConfigs = []) {
  const select = $(selectSelector);
  const preset = select ? resolutionPresetFromValue(select.value, orientation) : null;
  if (!preset) return false;
  const widthInput = $(widthSelector);
  const heightInput = $(heightSelector);
  if (widthInput) widthInput.value = String(preset.width);
  if (heightInput) heightInput.value = String(preset.height);
  if (selectConfigs.length) {
    syncResolutionPresetGroup(selectConfigs, widthSelector, heightSelector);
  } else {
    syncResolutionPresetToDimensions(selectSelector, widthSelector, heightSelector, orientation);
  }
  return true;
}

const RESOLUTION_PRESET_SELECTS = {
  imageLab: [
    { selector: '#image-lab-portrait-size-preset', orientation: 'portrait', customLabel: 'Custom/manual portrait size' },
    { selector: '#image-lab-landscape-size-preset', orientation: 'landscape', customLabel: 'Custom/manual landscape size' }
  ],
  playground: [
    { selector: '#playground-portrait-size-preset', orientation: 'portrait', customLabel: 'Custom/manual portrait size' },
    { selector: '#playground-landscape-size-preset', orientation: 'landscape', customLabel: 'Custom/manual landscape size' }
  ]
};

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
  const selected = $('#image-lab-workflow')?.value || '';
  if (selected && workflows.some((workflow) => workflow.id === selected)) {
    state.selectedWorkflowId = selected;
    return selected;
  }
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

function workflowUsesCheckpointModel(workflow = selectedWorkflow()) {
  return Boolean((workflow?.parameters || []).includes('model'));
}

function renderWorkflowOptions() {
  const select = $('#image-lab-workflow');
  if (!select) return;
  const workflows = state.imageWorkflows?.workflows || [];
  const previous = select.value || state.selectedWorkflowId || defaultWorkflowId();
  select.innerHTML = workflows.map((workflow) => {
    const label = workflow.name || workflow.id;
    return `<option value="${escapeHtml(workflow.id)}">${escapeHtml(label)}</option>`;
  }).join('');
  const selected = workflows.some((workflow) => workflow.id === previous)
    ? previous
    : defaultWorkflowId();
  select.value = selected || '';
  state.selectedWorkflowId = select.value || null;
}

function renderModelOptions() {
  const select = $('#image-lab-model');
  if (!select) return;
  const checkpointRequired = workflowUsesCheckpointModel();
  if (!checkpointRequired) {
    select.innerHTML = '<option value="">No checkpoint required for this workflow</option>';
    select.value = '';
    select.disabled = true;
    return;
  }
  select.disabled = false;
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
  syncResolutionPresetGroup(RESOLUTION_PRESET_SELECTS.imageLab, '#image-lab-width', '#image-lab-height');
}

function renderControls() {
  renderWorkflowOptions();
  renderModelOptions();
  applyWorkflowDefaults(false);
  renderResolutionPresetGroup(RESOLUTION_PRESET_SELECTS.imageLab, '#image-lab-width', '#image-lab-height');
  const slider = $('#image-lab-gallery-size');
  const sliderValue = $('#image-lab-gallery-size-value');
  if (slider) slider.value = String(state.galleryTileSize);
  if (sliderValue) sliderValue.textContent = `${state.galleryTileSize}px`;
  renderControlChrome();
}

function renderControlChrome() {
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
    model: workflowUsesCheckpointModel(workflow) ? selectedModel() || undefined : undefined,
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
  setNegativePromptDrawerOpen(Boolean(negative));

  const model = payloadString(requestPayload, ['model', 'checkpoint', 'checkpoint_name', 'checkpointName']);
  if (model && !selectModelByPayload(model)) warnings.push(`model ${model}`);

  setInputValue('#image-lab-width', payloadNumber(requestPayload, ['width']));
  setInputValue('#image-lab-height', payloadNumber(requestPayload, ['height']));
  syncResolutionPresetGroup(RESOLUTION_PRESET_SELECTS.imageLab, '#image-lab-width', '#image-lab-height');
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
  if (Array.isArray(job?.artifacts)) return job.artifacts.filter(Boolean);
  return job?.artifact ? [job.artifact].filter(Boolean) : [];
}

function artifactImageUrl(artifact) {
  if (!artifact) return '';
  return artifact.url
    || artifact.imageUrl
    || artifact.image_url
    || artifact.href
    || (artifact.id ? `/api/v1/artifacts/${encodeURIComponent(artifact.id)}` : '');
}

function firstArtifact(job) {
  const artifacts = jobArtifacts(job);
  return artifacts.find((artifact) => artifactImageUrl(artifact)) || artifacts[0] || null;
}

function firstArtifactUrlFromList(artifacts) {
  const list = Array.isArray(artifacts) ? artifacts.filter(Boolean) : [];
  return artifactImageUrl(list.find((artifact) => artifactImageUrl(artifact)) || list[0]);
}

function resultArtifacts(result, job = null) {
  const jobList = jobArtifacts(job);
  const resultList = Array.isArray(result?.artifacts) ? result.artifacts.filter(Boolean) : [];
  if (jobList.some((artifact) => artifactImageUrl(artifact))) return jobList;
  if (resultList.some((artifact) => artifactImageUrl(artifact))) return resultList;
  return jobList.length ? jobList : resultList;
}

function firstFullImageUrl(job) {
  const artifactUrl = artifactImageUrl(firstArtifact(job));
  return artifactUrl || job?.imageUrl || job?.image_url || job?.thumbnailUrl || '';
}

function firstImageUrl(job) {
  return job?.thumbnailUrl || firstFullImageUrl(job);
}

function firstResultImageUrl(result, job) {
  const artifactUrl = firstArtifactUrlFromList(resultArtifacts(result, job));
  return artifactUrl
    || result?.imageUrl
    || result?.image_url
    || job?.thumbnailUrl
    || job?.imageUrl
    || job?.image_url
    || '';
}

function extensionForImageMime(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('png')) return 'png';
  return 'png';
}

function sanitizeDownloadFileName(value, fallback = 'generated-image.png') {
  const base = String(value || '')
    .split(/[\\/]/u)
    .pop()
    ?.replace(/[^a-zA-Z0-9._() -]+/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[.-]+|[.-]+$/gu, '')
    .slice(0, 160);
  return base || fallback;
}

function compactTimestampForFileName(value) {
  const parsed = new Date(value || Date.now());
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().replace(/[:.]/gu, '-');
  return parsed.toISOString().replace(/[:.]/gu, '-');
}

function imageDownloadFileName(job, artifact = firstArtifact(job)) {
  const explicit = artifact?.fileName || artifact?.filename || artifact?.name;
  if (explicit) return sanitizeDownloadFileName(explicit);
  const id = sanitizeDownloadFileName(job?.id || artifact?.jobId || artifact?.id || 'generated-image', 'generated-image').replace(/\.[^.]+$/u, '');
  const timestamp = compactTimestampForFileName(artifact?.createdAt || job?.completedAt || job?.updatedAt || job?.createdAt);
  return sanitizeDownloadFileName(`${id}-${timestamp}.${extensionForImageMime(artifact?.mimeType)}`);
}

function generatedImageAltText(job, fallback = 'Generated image') {
  const prompt = previewText(jobPrompt(job), 120);
  return prompt ? `Generated image: ${prompt}` : fallback;
}

function imageMimeTypeForDrag(mimeType, url = '') {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized.startsWith('image/')) return normalized;
  const path = String(url || '').split('?')[0].toLowerCase();
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  return 'image/png';
}

function markGalleryImageDragStarted() {
  galleryImageDrag.isDragging = true;
  if (galleryImageDrag.resetTimer) window.clearTimeout(galleryImageDrag.resetTimer);
  galleryImageDrag.resetTimer = window.setTimeout(() => {
    galleryImageDrag.isDragging = false;
  }, 1500);
}

function markGalleryImageDragEnded() {
  galleryImageDrag.isDragging = false;
  galleryImageDrag.lastEndedAt = Date.now();
  if (galleryImageDrag.resetTimer) window.clearTimeout(galleryImageDrag.resetTimer);
  galleryImageDrag.resetTimer = window.setTimeout(() => {
    galleryImageDrag.lastEndedAt = 0;
  }, 600);
}

function shouldSuppressImageViewerClickAfterDrag() {
  return galleryImageDrag.isDragging || (Date.now() - galleryImageDrag.lastEndedAt < 600);
}

function handleGalleryImageDragStart(event) {
  const link = event.target.closest?.('[data-image-viewer-url]');
  if (!link || link.closest?.('.image-viewer-overlay')) return;
  const image = link.querySelector('img');
  const source = link.dataset.imageDragUrl
    || link.dataset.imageViewerUrl
    || image?.dataset.fullImageUrl
    || image?.dataset.artifactUrl
    || link.getAttribute('href')
    || '';
  const url = absoluteImageUrl(source);
  if (!url) return;
  const fileName = sanitizeDownloadFileName(link.dataset.imageDownloadName || 'generated-image.png');
  const mimeType = imageMimeTypeForDrag(link.dataset.imageMimeType, url);
  markGalleryImageDragStarted();
  link.classList.add('is-dragging-image');
  if (!event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'copy';
  try { event.dataTransfer.setData('DownloadURL', `${mimeType}:${fileName}:${url}`); } catch {}
  try { event.dataTransfer.setData('text/uri-list', url); } catch {}
  try { event.dataTransfer.setData('text/plain', url); } catch {}
  try { event.dataTransfer.setData('text/html', `<img src="${escapeHtml(url)}" alt="${escapeHtml(image?.alt || 'Generated image')}">`); } catch {}
}

function handleGalleryImageDragEnd(event) {
  const link = event.target.closest?.('[data-image-viewer-url]');
  if (link) link.classList.remove('is-dragging-image');
  markGalleryImageDragEnded();
}

const ACTUAL_SEED_KEYS = ['actualSeed', 'actual_seed', 'seedUsed', 'seed_used', 'resolvedSeed', 'resolved_seed'];

function normalizedSeedValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const seed = Number(value);
  if (!Number.isSafeInteger(seed) || seed < 0) return null;
  return seed;
}

function seedFromRecord(record, keys) {
  if (!isPlainObject(record)) return null;
  for (const key of keys) {
    const seed = normalizedSeedValue(record[key]);
    if (seed !== null) return seed;
  }
  return null;
}

function nestedRecord(record, key) {
  const value = isPlainObject(record) ? record[key] : null;
  return isPlainObject(value) ? value : null;
}

function actualSeedForJob(job, result = null) {
  const resultJob = isPlainObject(result?.job) ? result.job : null;
  const artifact = firstArtifact(job)
    || (Array.isArray(result?.artifacts) ? result.artifacts.find((item) => item?.url) || result.artifacts[0] : null)
    || firstArtifact(resultJob);
  const records = [job, resultJob, result, artifact].filter(isPlainObject);
  const metadataRecords = records.flatMap((record) => [
    nestedRecord(record, 'metadata'),
    nestedRecord(record, 'generation'),
    nestedRecord(record, 'details'),
    nestedRecord(record, 'info'),
    nestedRecord(record, 'providerMetadata'),
    nestedRecord(record, 'provider_metadata')
  ]).filter(isPlainObject);

  for (const record of [...records, ...metadataRecords]) {
    const seed = seedFromRecord(record, ACTUAL_SEED_KEYS);
    if (seed !== null) return seed;
  }

  const requestRecords = records.flatMap((record) => [
    nestedRecord(record, 'request'),
    nestedRecord(record, 'requestPayload'),
    nestedRecord(record, 'request_payload')
  ]).filter(isPlainObject);
  for (const record of [...records, ...metadataRecords, ...requestRecords]) {
    const seed = seedFromRecord(record, ['seed']);
    if (seed !== null) return seed;
  }
  return null;
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

function requestPayloadWithSeed(payload, seed) {
  const resolved = clonePayload(payload);
  const normalized = normalizedSeedValue(seed);
  if (normalized !== null) resolved.seed = normalized;
  return resolved;
}

function regenerationPayloadForJob(job, result = null) {
  const payload = jobRequestPayload(job);
  const actualSeed = actualSeedForJob(job, result);
  return actualSeed === null ? payload : requestPayloadWithSeed(payload, actualSeed);
}

function jobForFavoritePayload(job, payload, actualSeed) {
  const favoriteJob = clonePayload(job);
  if (actualSeed !== null) {
    favoriteJob.seed = actualSeed;
    favoriteJob.requestPayload = clonePayload(payload);
    favoriteJob.request_payload = clonePayload(payload);
    if (isPlainObject(favoriteJob.request)) favoriteJob.request = { ...favoriteJob.request, seed: actualSeed };
    favoriteJob.metadata = { ...(isPlainObject(favoriteJob.metadata) ? favoriteJob.metadata : {}), actualSeed };
  }
  return favoriteJob;
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
    clientCreatedAt: now,
    isClientPending: true,
    clientStatus: 'Submitting...',
    status: 'queued',
    createdAt: now,
    queuedAt: now,
    updatedAt: now,
    startedAt: null,
    completedAt: null,
    cancelRequestedAt: null,
    canceledAt: null,
    cancellationReason: null,
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
    originalRequestPayload: clonePayload(requestPayload),
    metadata: { clientStatus: 'Submitting...' },
    timings: {},
    error: null
  };
}

function addPendingJob(job) {
  state.pendingJobs = [job, ...state.pendingJobs.filter((item) => item.clientId !== job.clientId && item.id !== job.id)];
  renderGallery();
}

function firstPayloadCandidate(candidates) {
  for (const candidate of candidates) {
    if (isPlainObject(candidate)) return clonePayload(candidate);
  }
  return {};
}

function mergeJobUpdate(localJob, jobUpdate, extras = {}) {
  const update = isPlainObject(jobUpdate) ? jobUpdate : {};
  const incomingStatus = String(extras.status || update.status || '').toLowerCase();
  const preserveLocalCanceled = localJob.status === 'canceled' && isActiveJobStatus(incomingStatus);
  const originalRequestPayload = isPlainObject(localJob.originalRequestPayload)
    ? clonePayload(localJob.originalRequestPayload)
    : isPlainObject(localJob.requestPayload)
      ? clonePayload(localJob.requestPayload)
      : {};
  const requestPayload = firstPayloadCandidate([
    extras.requestPayload,
    update.requestPayload,
    update.request_payload,
    localJob.requestPayload,
    localJob.request_payload
  ]);
  const nextMetadata = {
    ...(isPlainObject(localJob.metadata) ? localJob.metadata : {}),
    ...(isPlainObject(update.metadata) ? update.metadata : {}),
    ...(isPlainObject(extras.metadata) ? extras.metadata : {})
  };
  const cancelRequestedAt = firstDefinedValue(extras.cancelRequestedAt, update.cancelRequestedAt, localJob.cancelRequestedAt, nextMetadata.cancelRequestedAt);
  const canceledAt = firstDefinedValue(extras.canceledAt, update.canceledAt, localJob.canceledAt, nextMetadata.canceledAt);
  const cancellationReason = firstDefinedValue(extras.cancellationReason, update.cancellationReason, localJob.cancellationReason, nextMetadata.cancellationReason);
  const cancelFailedAt = firstDefinedValue(extras.cancelFailedAt, update.cancelFailedAt, localJob.cancelFailedAt, nextMetadata.cancelFailedAt);
  const merged = {
    ...localJob,
    ...update,
    ...extras,
    id: update.id || localJob.id,
    clientId: localJob.clientId,
    clientSequence: localJob.clientSequence,
    clientCreatedAt: localJob.clientCreatedAt || localJob.createdAt || localJob.queuedAt || update.createdAt || extras.createdAt || null,
    isClientPending: localJob.isClientPending && !['succeeded', 'failed', 'canceled'].includes(update.status || extras.status || ''),
    ...(cancelRequestedAt ? { cancelRequestedAt } : {}),
    ...(canceledAt ? { canceledAt } : {}),
    ...(cancellationReason ? { cancellationReason } : {}),
    ...(cancelFailedAt ? { cancelFailedAt } : {}),
    originalRequestPayload,
    requestPayload,
    request: update.request || localJob.request || {},
    metadata: {
      ...nextMetadata,
      ...(cancelRequestedAt ? { cancelRequestedAt } : {}),
      ...(canceledAt ? { canceledAt } : {}),
      ...(cancellationReason ? { cancellationReason } : {}),
      ...(cancelFailedAt ? { cancelFailedAt } : {})
    },
    updatedAt: update.updatedAt || extras.updatedAt || new Date().toISOString()
  };
  if (preserveLocalCanceled) {
    merged.status = 'canceled';
    merged.completedAt = localJob.completedAt || localJob.canceledAt || merged.completedAt;
    merged.canceledAt = localJob.canceledAt || merged.canceledAt || merged.completedAt;
    merged.cancelRequestedAt = localJob.cancelRequestedAt || merged.cancelRequestedAt || merged.canceledAt;
    merged.cancellationReason = localJob.cancellationReason || merged.cancellationReason || 'User requested cancellation.';
    merged.error = null;
    merged.isClientPending = false;
  }
  const actualSeed = actualSeedForJob(merged);
  if (actualSeed !== null) {
    merged.seed = actualSeed;
    merged.requestPayload = requestPayloadWithSeed(merged.requestPayload, actualSeed);
    merged.metadata = { ...merged.metadata, actualSeed };
    if (isPlainObject(merged.request)) merged.request = { ...merged.request, seed: actualSeed };
  }
  return merged;
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
  if (code === 'IMAGE_JOB_CANCELED' || jobUpdate?.status === 'canceled') {
    return markPendingJobCanceled(clientId, jobUpdate || {}, message);
  }
  updatePendingJob(clientId, jobUpdate || {}, {
    status: 'failed',
    isClientPending: false,
    completedAt: new Date().toISOString(),
    error: { code, message, ...(bodyError?.details === undefined ? {} : { details: bodyError.details }) },
    metadata: { clientStatus: 'Failed' }
  });
  return message;
}

function markPendingJobCanceled(clientId, jobUpdate = {}, message = 'Image generation was canceled.') {
  const now = new Date().toISOString();
  updatePendingJob(clientId, jobUpdate || {}, {
    status: 'canceled',
    isClientPending: false,
    completedAt: jobUpdate?.completedAt || jobUpdate?.canceledAt || now,
    cancelRequestedAt: jobUpdate?.cancelRequestedAt || now,
    canceledAt: jobUpdate?.canceledAt || jobUpdate?.completedAt || now,
    cancellationReason: jobUpdate?.cancellationReason || message || 'User requested cancellation.',
    error: null,
    metadata: {
      clientStatus: 'Canceled',
      cancelRequestedAt: jobUpdate?.cancelRequestedAt || now,
      canceledAt: jobUpdate?.canceledAt || jobUpdate?.completedAt || now,
      cancellationReason: jobUpdate?.cancellationReason || message || 'User requested cancellation.'
    }
  });
  return message || 'Image generation was canceled.';
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

function absoluteImageUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  try {
    return new URL(value, window.location.href).href;
  } catch {
    return value;
  }
}

function retryableImageUrl(url, attempts = 0) {
  const value = String(url || '').trim();
  if (!value || attempts <= 0) return value;
  try {
    const parsed = new URL(value, window.location.href);
    parsed.searchParams.set('image_preview_retry', String(attempts));
    return parsed.href;
  } catch {
    return value;
  }
}

function resetHydratedImageForNewUrl(image, url) {
  if (image.dataset.hydratedUrl === url) return;
  delete image.dataset.loaded;
  delete image.dataset.loading;
  delete image.dataset.loadAttempts;
  image.dataset.hydratedUrl = url;
  image.removeAttribute('src');
}

function markHydratedImageLoaded(image) {
  if (!image.isConnected) return;
  image.hidden = false;
  image.dataset.loaded = '1';
  delete image.dataset.loading;
  image.nextElementSibling?.remove();
  image.onload = null;
  image.onerror = null;
}

function markHydratedImageErrored(image, url) {
  if (!image.isConnected) return;
  delete image.dataset.loading;
  const attempts = Number(image.dataset.loadAttempts || '0') + 1;
  image.dataset.loadAttempts = String(attempts);
  if (attempts <= 8) {
    const placeholder = image.nextElementSibling;
    if (placeholder) placeholder.textContent = attempts > 2 ? 'Image still loading...' : 'Image loading...';
    window.setTimeout(() => {
      if (image.isConnected && image.dataset.loaded !== '1') hydrateImages();
    }, Math.min(500 * attempts, 2000));
    return;
  }
  image.hidden = true;
  image.nextElementSibling?.replaceWith(Object.assign(document.createElement('div'), { className: 'thumb-placeholder', textContent: 'Image unavailable' }));
  image.onload = null;
  image.onerror = null;
  console.warn('Unable to hydrate generated image preview', url);
}

function hydrateImages() {
  for (const image of document.querySelectorAll('img[data-artifact-url]')) {
    const url = image.dataset.artifactUrl;
    if (!url) continue;
    resetHydratedImageForNewUrl(image, url);
    if (image.dataset.loaded === '1' || image.dataset.loading === '1') continue;
    const attempts = Number(image.dataset.loadAttempts || '0');
    image.dataset.loading = '1';
    image.onload = () => markHydratedImageLoaded(image);
    image.onerror = () => markHydratedImageErrored(image, url);
    image.src = retryableImageUrl(url, attempts);
  }
}

function imageViewerMessage(text, isError = false) {
  if (!imageViewer.message || !imageViewer.overlay) return;
  imageViewer.message.textContent = text;
  imageViewer.message.hidden = false;
  imageViewer.overlay.classList.toggle('has-error', isError);
  imageViewer.overlay.classList.toggle('is-loading', !isError && !imageViewer.isLoaded);
}

function addImageViewerListener(target, type, handler, options) {
  if (!target) return;
  target.addEventListener(type, handler, options);
  imageViewer.cleanupCallbacks.push(() => target.removeEventListener(type, handler, options));
}

function clearImageViewerInactivityTimer() {
  if (!imageViewer.inactivityTimer) return;
  window.clearTimeout(imageViewer.inactivityTimer);
  imageViewer.inactivityTimer = null;
}

function scheduleImageViewerInactivity() {
  clearImageViewerInactivityTimer();
  if (!imageViewer.isOpen || imageViewer.isPanning || imageViewer.isControlActive) return;
  imageViewer.inactivityTimer = window.setTimeout(() => {
    if (!imageViewer.overlay || imageViewer.isPanning || imageViewer.isControlActive) return;
    imageViewer.overlay.classList.add('is-inactive');
  }, IMAGE_VIEWER_INACTIVITY_MS);
}

function showImageViewerChrome() {
  if (!imageViewer.overlay) return;
  imageViewer.overlay.classList.remove('is-inactive');
  scheduleImageViewerInactivity();
}

function imageViewerStageRect() {
  return imageViewer.stage?.getBoundingClientRect() || { left: 0, top: 0, width: window.innerWidth || 1, height: window.innerHeight || 1 };
}

function calculateImageViewerFitScale() {
  const rect = imageViewerStageRect();
  const margin = 32;
  const availableWidth = Math.max(1, rect.width - margin);
  const availableHeight = Math.max(1, rect.height - margin);
  const widthScale = availableWidth / Math.max(1, imageViewer.naturalWidth);
  const heightScale = availableHeight / Math.max(1, imageViewer.naturalHeight);
  return Math.max(0.02, Math.min(widthScale, heightScale, 1));
}

function clampImageViewerScale(scale) {
  return clampNumber(scale, imageViewer.minScale, imageViewer.maxScale);
}

function clampImageViewerPan() {
  if (!imageViewer.stage || !imageViewer.isLoaded) return;
  const rect = imageViewerStageRect();
  const scaledWidth = imageViewer.naturalWidth * imageViewer.scale;
  const scaledHeight = imageViewer.naturalHeight * imageViewer.scale;
  const maxX = Math.max(0, (scaledWidth - rect.width) / 2);
  const maxY = Math.max(0, (scaledHeight - rect.height) / 2);
  imageViewer.translateX = clampNumber(imageViewer.translateX, -maxX, maxX);
  imageViewer.translateY = clampNumber(imageViewer.translateY, -maxY, maxY);
}

function applyImageViewerTransform() {
  if (!imageViewer.image) return;
  clampImageViewerPan();
  imageViewer.image.style.transform = `translate(calc(-50% + ${imageViewer.translateX}px), calc(-50% + ${imageViewer.translateY}px)) scale(${imageViewer.scale})`;
}

function resetImageViewerToFit() {
  if (!imageViewer.isLoaded) return;
  imageViewer.minScale = calculateImageViewerFitScale();
  imageViewer.maxScale = Math.max(IMAGE_VIEWER_MAX_NATURAL_SCALE, imageViewer.minScale);
  imageViewer.scale = imageViewer.minScale;
  imageViewer.translateX = 0;
  imageViewer.translateY = 0;
  applyImageViewerTransform();
}

function zoomImageViewerAtPoint(nextScale, clientX, clientY) {
  if (!imageViewer.isLoaded) return;
  const clampedScale = clampImageViewerScale(nextScale);
  if (Math.abs(clampedScale - imageViewer.scale) < 0.0001) return;
  const rect = imageViewerStageRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const imagePointX = (clientX - centerX - imageViewer.translateX) / imageViewer.scale;
  const imagePointY = (clientY - centerY - imageViewer.translateY) / imageViewer.scale;
  imageViewer.scale = clampedScale;
  imageViewer.translateX = clientX - centerX - imagePointX * imageViewer.scale;
  imageViewer.translateY = clientY - centerY - imagePointY * imageViewer.scale;
  applyImageViewerTransform();
}

function zoomImageViewerAtCenter(nextScale) {
  const rect = imageViewerStageRect();
  zoomImageViewerAtPoint(nextScale, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function setImageViewerNaturalSize() {
  if (!imageViewer.image) return;
  imageViewer.naturalWidth = imageViewer.image.naturalWidth || 1;
  imageViewer.naturalHeight = imageViewer.image.naturalHeight || 1;
  imageViewer.image.style.width = `${imageViewer.naturalWidth}px`;
  imageViewer.image.style.height = `${imageViewer.naturalHeight}px`;
  imageViewer.isLoaded = true;
  imageViewer.overlay?.classList.remove('is-loading', 'has-error');
  imageViewer.overlay?.classList.add('is-loaded');
  if (imageViewer.message) imageViewer.message.hidden = true;
  imageViewer.image.hidden = false;
  resetImageViewerToFit();
}

function closeImageViewer() {
  if (!imageViewer.isOpen) return;
  clearImageViewerInactivityTimer();
  for (const cleanup of imageViewer.cleanupCallbacks.splice(0)) cleanup();
  if (imageViewer.image) {
    imageViewer.image.onload = null;
    imageViewer.image.onerror = null;
    imageViewer.image.removeAttribute('src');
  }
  imageViewer.overlay?.remove();
  document.body.style.overflow = imageViewer.previousBodyOverflow;
  document.documentElement.style.overflow = imageViewer.previousDocumentOverflow;
  document.body.classList.remove('image-viewer-open');
  if (imageViewer.previousActiveElement?.isConnected) {
    try {
      imageViewer.previousActiveElement.focus({ preventScroll: true });
    } catch {
      imageViewer.previousActiveElement.focus();
    }
  }
  Object.assign(imageViewer, {
    overlay: null,
    stage: null,
    image: null,
    message: null,
    closeButton: null,
    downloadButton: null,
    previousActiveElement: null,
    isOpen: false,
    isLoaded: false,
    isPanning: false,
    isControlActive: false,
    naturalWidth: 0,
    naturalHeight: 0,
    minScale: 1,
    maxScale: IMAGE_VIEWER_MAX_NATURAL_SCALE,
    scale: 1,
    translateX: 0,
    translateY: 0
  });
}

function handleImageViewerWheel(event) {
  if (!imageViewer.isOpen) return;
  event.preventDefault();
  showImageViewerChrome();
  if (!imageViewer.isLoaded) return;
  const factor = Math.exp(-event.deltaY * IMAGE_VIEWER_ZOOM_WHEEL_SPEED);
  zoomImageViewerAtPoint(imageViewer.scale * factor, event.clientX, event.clientY);
}

function handleImageViewerPointerDown(event) {
  if (event.button !== undefined && event.button !== 0) return;
  if (event.target.closest?.('.image-viewer-control')) return;
  event.preventDefault();
  showImageViewerChrome();
  if (!imageViewer.isLoaded || !imageViewer.stage) return;
  imageViewer.isPanning = true;
  imageViewer.pointerStartX = event.clientX;
  imageViewer.pointerStartY = event.clientY;
  imageViewer.pointerStartTranslateX = imageViewer.translateX;
  imageViewer.pointerStartTranslateY = imageViewer.translateY;
  imageViewer.overlay?.classList.add('is-panning');
  try {
    imageViewer.stage.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture is best-effort; mouse dragging still works without it.
  }
}

function handleImageViewerPointerMove(event) {
  showImageViewerChrome();
  if (!imageViewer.isPanning) return;
  event.preventDefault();
  imageViewer.translateX = imageViewer.pointerStartTranslateX + event.clientX - imageViewer.pointerStartX;
  imageViewer.translateY = imageViewer.pointerStartTranslateY + event.clientY - imageViewer.pointerStartY;
  applyImageViewerTransform();
}

function finishImageViewerPan(event) {
  if (!imageViewer.isPanning) return;
  imageViewer.isPanning = false;
  imageViewer.overlay?.classList.remove('is-panning');
  try {
    imageViewer.stage?.releasePointerCapture(event.pointerId);
  } catch {
    // Pointer capture may already be released.
  }
  showImageViewerChrome();
}

function handleImageViewerKeydown(event) {
  if (!imageViewer.isOpen) return;
  showImageViewerChrome();
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeImageViewer();
    return;
  }
  if (!imageViewer.isLoaded) return;
  if (event.key === '0') {
    event.preventDefault();
    resetImageViewerToFit();
    return;
  }
  if (event.key === '1') {
    event.preventDefault();
    zoomImageViewerAtCenter(1);
    return;
  }
  if (event.key === '+' || event.key === '=') {
    event.preventDefault();
    zoomImageViewerAtCenter(imageViewer.scale * IMAGE_VIEWER_ZOOM_BUTTON_STEP);
    return;
  }
  if (event.key === '-' || event.key === '_') {
    event.preventDefault();
    zoomImageViewerAtCenter(imageViewer.scale / IMAGE_VIEWER_ZOOM_BUTTON_STEP);
  }
}

function handleImageViewerResize() {
  if (!imageViewer.isLoaded) return;
  imageViewer.minScale = calculateImageViewerFitScale();
  imageViewer.maxScale = Math.max(IMAGE_VIEWER_MAX_NATURAL_SCALE, imageViewer.minScale);
  imageViewer.scale = clampImageViewerScale(imageViewer.scale);
  applyImageViewerTransform();
}

function createImageViewerOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'image-viewer-overlay is-loading';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Image viewer');
  overlay.tabIndex = -1;
  overlay.innerHTML = `
    <div class="image-viewer-controls" aria-label="Image viewer controls">
      <a class="image-viewer-control image-viewer-download" aria-label="Download image">Download</a>
      <button type="button" class="image-viewer-control image-viewer-close" aria-label="Close image viewer">Close</button>
    </div>
    <div class="image-viewer-stage" aria-live="polite">
      <div class="image-viewer-message">Loading full-resolution image...</div>
      <img class="image-viewer-image" alt="Generated image" draggable="false" hidden>
    </div>`;
  return overlay;
}

function openImageViewer({ src, alt = 'Generated image', downloadName = 'generated-image.png' }) {
  const fullSource = String(src || '').trim();
  closeImageViewer();
  const overlay = createImageViewerOverlay();
  document.body.appendChild(overlay);
  imageViewer.overlay = overlay;
  imageViewer.stage = overlay.querySelector('.image-viewer-stage');
  imageViewer.image = overlay.querySelector('.image-viewer-image');
  imageViewer.message = overlay.querySelector('.image-viewer-message');
  imageViewer.closeButton = overlay.querySelector('.image-viewer-close');
  imageViewer.downloadButton = overlay.querySelector('.image-viewer-download');
  imageViewer.previousBodyOverflow = document.body.style.overflow;
  imageViewer.previousDocumentOverflow = document.documentElement.style.overflow;
  imageViewer.previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  imageViewer.isOpen = true;
  imageViewer.isLoaded = false;
  imageViewer.isPanning = false;
  imageViewer.isControlActive = false;
  document.body.style.overflow = 'hidden';
  document.documentElement.style.overflow = 'hidden';
  document.body.classList.add('image-viewer-open');

  addImageViewerListener(imageViewer.closeButton, 'click', closeImageViewer);
  addImageViewerListener(imageViewer.downloadButton, 'click', (event) => {
    showImageViewerChrome();
    if (!imageViewer.downloadButton?.getAttribute('href')) event.preventDefault();
  });
  for (const control of overlay.querySelectorAll('.image-viewer-control')) {
    addImageViewerListener(control, 'pointerenter', () => {
      imageViewer.isControlActive = true;
      showImageViewerChrome();
    });
    addImageViewerListener(control, 'pointerleave', () => {
      imageViewer.isControlActive = false;
      showImageViewerChrome();
    });
    addImageViewerListener(control, 'focusin', () => {
      imageViewer.isControlActive = true;
      showImageViewerChrome();
    });
    addImageViewerListener(control, 'focusout', () => {
      imageViewer.isControlActive = false;
      showImageViewerChrome();
    });
  }
  addImageViewerListener(overlay, 'wheel', handleImageViewerWheel, { passive: false });
  addImageViewerListener(overlay, 'pointermove', handleImageViewerPointerMove);
  addImageViewerListener(imageViewer.stage, 'pointerdown', handleImageViewerPointerDown);
  addImageViewerListener(imageViewer.stage, 'pointerup', finishImageViewerPan);
  addImageViewerListener(imageViewer.stage, 'pointercancel', finishImageViewerPan);
  addImageViewerListener(window, 'keydown', handleImageViewerKeydown, true);
  addImageViewerListener(window, 'resize', handleImageViewerResize);

  if (imageViewer.downloadButton) {
    imageViewer.downloadButton.setAttribute('download', sanitizeDownloadFileName(downloadName));
    if (fullSource) imageViewer.downloadButton.setAttribute('href', fullSource);
    else imageViewer.downloadButton.setAttribute('aria-disabled', 'true');
  }

  if (imageViewer.image) {
    imageViewer.image.alt = alt;
    imageViewer.image.onload = setImageViewerNaturalSize;
    imageViewer.image.onerror = () => {
      imageViewer.isLoaded = false;
      imageViewer.image.hidden = true;
      imageViewer.overlay?.classList.remove('is-loading', 'is-loaded');
      imageViewerMessage('Unable to load this full-resolution image. The artifact may no longer be available.', true);
    };
  }

  showImageViewerChrome();
  overlay.focus({ preventScroll: true });
  if (!fullSource) {
    imageViewerMessage('No viewable image artifact is available for this item.', true);
    return;
  }
  imageViewerMessage('Loading full-resolution image...');
  imageViewer.image.src = fullSource;
}

function openImageViewerFromLink(link) {
  const image = link.querySelector('img');
  const src = link.dataset.imageViewerUrl || image?.dataset.fullImageUrl || image?.dataset.artifactUrl || link.getAttribute('href') || '';
  openImageViewer({
    src,
    alt: link.dataset.imageAlt || image?.alt || 'Generated image',
    downloadName: link.dataset.imageDownloadName || sanitizeDownloadFileName('generated-image.png')
  });
}

function handleImageViewerLinkClick(event) {
  const link = event.target.closest?.('[data-image-viewer-url]');
  if (!link) return false;
  if (shouldSuppressImageViewerClickAfterDrag()) {
    event.preventDefault();
    event.stopPropagation();
    return true;
  }
  event.preventDefault();
  event.stopPropagation();
  openImageViewerFromLink(link);
  return true;
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
  const artifacts = resultArtifacts(result, job);
  const artifact = artifacts.find((item) => artifactImageUrl(item)) || firstArtifact(job) || artifacts[0] || null;
  const imageUrl = firstResultImageUrl(result, job);
  const imageAlt = generatedImageAltText(job, 'Last generated image');
  const downloadName = imageDownloadFileName(job, artifact);
  const tone = statusTone(job.status || 'submitted', job);
  target.innerHTML = `<div class="generation-result image-lab-result">
    <p>${statusPill(statusLabelForJob(job), tone)} Job <code>${escapeHtml(job.id || 'n/a')}</code></p>
    ${imageUrl ? `<a class="image-viewer-link" href="${escapeHtml(imageUrl)}" data-image-viewer-url="${escapeHtml(imageUrl)}" data-image-drag-url="${escapeHtml(imageUrl)}" data-image-download-name="${escapeHtml(downloadName)}" data-image-mime-type="${escapeHtml(artifact?.mimeType || '')}" data-image-alt="${escapeHtml(imageAlt)}" draggable="true"><img class="result-image" data-artifact-url="${escapeHtml(imageUrl)}" data-full-image-url="${escapeHtml(imageUrl)}" alt="${escapeHtml(imageAlt)}" loading="lazy" draggable="true" hidden><div class="thumb-placeholder">Loading result image...</div></a>` : '<div class="thumb-placeholder">No image artifact available</div>'}
    <p class="compact-meta-line"><span><strong>Seed:</strong> ${escapeHtml(actualSeedForJob(job, result) ?? job.requestPayload?.seed ?? 'n/a')}</span><span><strong>Total:</strong> ${escapeHtml(formatDurationMs(job.totalMs ?? job.timings?.totalMs))}</span></p>
  </div>`;
  hydrateImages();
}

function galleryJobKeys(job) {
  return [job?.id, job?.clientId, job?.providerJobId, job?.provider_job_id]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function mergeGalleryDisplayJob(localJob, remoteJob) {
  if (!localJob) return remoteJob;
  const remoteArtifacts = jobArtifacts(remoteJob);
  const localArtifacts = jobArtifacts(localJob);
  const remoteIsTerminal = isTerminalJobStatus(remoteJob?.status);
  const merged = {
    ...localJob,
    ...remoteJob,
    clientId: localJob.clientId || remoteJob.clientId,
    clientSequence: localJob.clientSequence || remoteJob.clientSequence,
    clientCreatedAt: localJob.clientCreatedAt || localJob.createdAt || remoteJob.clientCreatedAt || remoteJob.createdAt || null,
    isClientPending: localJob.isClientPending && !remoteIsTerminal,
    originalRequestPayload: isPlainObject(remoteJob.originalRequestPayload) ? remoteJob.originalRequestPayload : localJob.originalRequestPayload,
    requestPayload: firstPayloadCandidate([remoteJob.requestPayload, remoteJob.request_payload, localJob.requestPayload, localJob.request_payload]),
    request: isPlainObject(remoteJob.request) && Object.keys(remoteJob.request).length ? remoteJob.request : localJob.request || {},
    metadata: {
      ...(isPlainObject(localJob.metadata) ? localJob.metadata : {}),
      ...(isPlainObject(remoteJob.metadata) ? remoteJob.metadata : {})
    }
  };
  if (remoteArtifacts.length) merged.artifacts = remoteArtifacts;
  else if (localArtifacts.length) merged.artifacts = localArtifacts;
  const displayUrl = remoteJob.thumbnailUrl || firstFullImageUrl(merged) || localJob.thumbnailUrl || '';
  if (displayUrl) merged.thumbnailUrl = displayUrl;
  return merged;
}

function currentJobs() {
  const remoteJobs = state.imageJobs?.jobs || state.imageJobs?.items || [];
  const jobsByPrimaryKey = new Map();
  const aliasToPrimaryKey = new Map();

  const upsertJob = (job, mergeWithExisting = false) => {
    const keys = galleryJobKeys(job);
    if (keys.length === 0) return;
    const existingPrimaryKey = keys.map((key) => aliasToPrimaryKey.get(key)).find(Boolean);
    const primaryKey = existingPrimaryKey || keys[0];
    const existing = jobsByPrimaryKey.get(primaryKey);
    const nextJob = existing && mergeWithExisting ? mergeGalleryDisplayJob(existing, job) : existing || job;
    jobsByPrimaryKey.set(primaryKey, nextJob);
    for (const key of new Set([...keys, ...galleryJobKeys(nextJob)])) aliasToPrimaryKey.set(key, primaryKey);
  };

  for (const job of state.pendingJobs || []) upsertJob(job);
  for (const job of remoteJobs) upsertJob(job, true);

  return [...jobsByPrimaryKey.values()].sort((a, b) => {
    const bDate = gallerySortTimestamp(b);
    const aDate = gallerySortTimestamp(a);
    if (bDate !== aDate) return bDate - aDate;
    return Number(b.clientSequence || 0) - Number(a.clientSequence || 0);
  });
}

function gallerySortTimestamp(job) {
  const timestamp = job?.clientId
    ? job.clientCreatedAt || job.queuedAt || job.createdAt || job.updatedAt || job.completedAt || job.canceledAt
    : job?.completedAt || job?.canceledAt || job?.cancelRequestedAt || job?.updatedAt || job?.createdAt || job?.queuedAt;
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

function statusTone(status, job = null) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'succeeded') return 'ok';
  if (normalized === 'failed') return 'bad';
  if (normalized === 'canceled') return 'neutral';
  if (job && hasActiveCancelFailure(job)) return 'bad';
  if (isActiveJobStatus(normalized)) return 'warn';
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
  if (hasActiveCancelFailure(job)) return 'Cancel failed';
  if (job.status === 'canceled') return 'Canceled';
  if (hasCancelRequested(job)) return 'Canceling...';
  if (job.status === 'running') return 'Generating...';
  if (job.status === 'queued') return clientStatus === 'Submitting...' ? 'Submitting...' : 'Queued...';
  if (job.status === 'failed') return 'Generation failed';
  return clientStatus || 'Image loading...';
}

function renderCancelControl(job) {
  if (hasActiveCancelFailure(job)) {
    return '<button type="button" class="secondary image-lab-cancel-button" disabled>Cancel failed</button>';
  }
  if (hasCancelRequested(job) && !isTerminalJobStatus(job.status)) {
    return '<button type="button" class="secondary image-lab-cancel-button" disabled>Canceling...</button>';
  }
  if (!isCancelableJob(job)) return '';
  return '<button type="button" class="secondary image-lab-cancel-button" data-gallery-action="cancel-job">Cancel</button>';
}

function renderGalleryImageContent(job, imageUrl, prompt, jobId, dimensions) {
  const status = job.status || 'unknown';
  const artifact = firstArtifact(job);
  const fullImageUrl = firstFullImageUrl(job) || imageUrl;
  const displayImageUrl = imageUrl || fullImageUrl;
  const imageAlt = `Generated image: ${previewText(prompt, 90) || jobId}`;
  if (displayImageUrl) {
    return `<a class="gallery-image-link" href="${escapeHtml(fullImageUrl)}" data-image-viewer-url="${escapeHtml(fullImageUrl)}" data-image-drag-url="${escapeHtml(fullImageUrl)}" data-image-download-name="${escapeHtml(imageDownloadFileName(job, artifact))}" data-image-mime-type="${escapeHtml(artifact?.mimeType || '')}" data-image-alt="${escapeHtml(imageAlt)}" draggable="true" aria-label="Open full-resolution image viewer for ${escapeHtml(previewText(prompt, 80) || jobId)}"><img class="gallery-image" data-artifact-url="${escapeHtml(displayImageUrl)}" data-full-image-url="${escapeHtml(fullImageUrl)}" alt="${escapeHtml(imageAlt)}" loading="lazy" draggable="true" hidden><div class="thumb-placeholder">Image loading...</div></a>`;
  }
  if (isActiveJobStatus(status) || job.isClientPending || (hasCancelRequested(job) && !isTerminalJobStatus(status))) {
    return `<div class="thumb-placeholder image-lab-pending-placeholder"><span class="image-lab-placeholder-title">${escapeHtml(pendingMessage(job))}</span><span class="image-lab-status-actions">${statusPill(statusLabelForJob(job), statusTone(status, job))}${renderCancelControl(job)}</span><span class="image-lab-placeholder-subtitle">${escapeHtml(dimensions)} preview space reserved for this request.</span></div>`;
  }
  if (status === 'canceled') {
    const message = job.cancellationReason || job.metadata?.cancellationReason || 'This generation was canceled before an image was produced.';
    return `<div class="thumb-placeholder image-lab-canceled-placeholder"><span class="image-lab-placeholder-title">Canceled</span><span class="image-lab-placeholder-subtitle">${escapeHtml(message)}</span></div>`;
  }
  if (status === 'failed') {
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
  const payload = regenerationPayloadForJob(job);
  const favorite = favoriteForJob(job);
  const jobId = job?.id || `job-${index + 1}`;
  const status = job.status || 'unknown';
  const tone = statusTone(status, job);
  const dimensions = `${job.width ?? job.request?.width ?? payload.width ?? 'n/a'} x ${job.height ?? job.request?.height ?? payload.height ?? 'n/a'}`;
  const seed = actualSeedForJob(job) ?? payload.seed ?? 'n/a';
  const model = job.model || payload.model || 'model n/a';
  const hasDeterministicSeed = actualSeedForJob(job) !== null;
  const canSaveFavorite = Boolean(imageUrl) && status === 'succeeded' && hasDeterministicSeed;
  const saveFavoriteDisabled = favorite || !canSaveFavorite;
  const favoriteDisabledReason = status === 'canceled'
    ? 'Canceled jobs do not have a generated image to save as a favorite.'
    : status === 'succeeded' && !hasDeterministicSeed
      ? 'This completed image did not expose the actual seed needed for deterministic favorite regeneration.'
      : 'A completed image artifact is required before saving a favorite.';
  const favoriteTitle = canSaveFavorite ? '' : ` title="${escapeHtml(favoriteDisabledReason)}"`;
  const requestedSeed = job.request?.seed ?? job.originalRequestPayload?.seed ?? payload.seed ?? 'n/a';
  const resolvedSeed = actualSeedForJob(job) ?? 'n/a';
  const cancelRequestedAt = job.cancelRequestedAt || job.metadata?.cancelRequestedAt || null;
  const canceledAt = job.canceledAt || job.metadata?.canceledAt || (status === 'canceled' ? job.completedAt : null);
  const cancellationReason = job.cancellationReason || job.metadata?.cancellationReason || null;
  const cardClasses = ['image-lab-gallery-card'];
  if (isActiveJobStatus(status) || job.isClientPending) cardClasses.push('is-pending');
  if (status === 'failed') cardClasses.push('is-failed');
  if (status === 'canceled') cardClasses.push('is-canceled');
  const requestDetails = {
    jobId,
    clientId: job.clientId || undefined,
    resultUrl: job.resultUrl || job.result_url || undefined,
    statusUrl: job.statusUrl || job.status_url || undefined,
    requestPayload: payload,
    request: job.request || {},
    metadata: job.metadata || {},
    cancellation: {
      cancelRequestedAt,
      canceledAt,
      cancellationReason,
      cancelError: job.cancelError || job.metadata?.cancelError || null
    },
    artifacts: jobArtifacts(job)
  };
  const clientIdAttribute = job.clientId ? ` data-client-id="${escapeHtml(job.clientId)}"` : '';
  return `<article class="${cardClasses.join(' ')}" data-job-index="${escapeHtml(index)}" data-job-id="${escapeHtml(jobId)}"${clientIdAttribute} data-job-state="${escapeHtml(status)}">
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
          <p class="compact-meta-line"><span><strong>Status:</strong> ${statusPill(statusLabelForJob(job), tone)}</span><span><strong>Job:</strong> <code>${escapeHtml(jobId)}</code></span>${job.clientId && job.clientId !== jobId ? `<span><strong>Client:</strong> <code>${escapeHtml(job.clientId)}</code></span>` : ''}<span><strong>Provider job:</strong> <code>${escapeHtml(job.providerJobId || 'n/a')}</code></span></p>
          <p class="compact-meta-line"><span><strong>Workflow:</strong> ${escapeHtml(job.workflowId || payload.workflow_id || 'n/a')}</span><span><strong>Provider:</strong> ${escapeHtml(job.provider || 'n/a')}</span><span><strong>Submitted:</strong> ${escapeHtml(formatDate(job.queuedAt || job.createdAt))}</span><span><strong>Started:</strong> ${escapeHtml(formatDate(job.startedAt))}</span><span><strong>Completed:</strong> ${escapeHtml(formatDate(job.completedAt))}</span></p>
          <p class="compact-meta-line"><span><strong>Cancel requested:</strong> ${escapeHtml(formatDate(cancelRequestedAt))}</span><span><strong>Canceled:</strong> ${escapeHtml(formatDate(canceledAt))}</span><span><strong>Reason:</strong> ${escapeHtml(cancellationReason || 'n/a')}</span></p>
          <p class="compact-meta-line"><span><strong>Size:</strong> ${escapeHtml(dimensions)}</span><span><strong>Steps:</strong> ${escapeHtml(job.steps ?? payload.steps ?? 'n/a')}</span><span><strong>CFG:</strong> ${escapeHtml(job.cfgScale ?? payload.cfg_scale ?? 'n/a')}</span><span><strong>Seed requested:</strong> ${escapeHtml(requestedSeed)}</span><span><strong>Resolved seed:</strong> ${escapeHtml(resolvedSeed)}</span><span><strong>Sampler:</strong> ${escapeHtml(job.samplerName ?? payload.sampler_name ?? 'n/a')}</span><span><strong>Scheduler:</strong> ${escapeHtml(job.scheduler ?? payload.scheduler ?? 'n/a')}</span></p>
          <p class="compact-meta-line"><span><strong>Queue wait:</strong> ${escapeHtml(formatDurationMs(job.queueWaitMs ?? job.timings?.queueWaitMs))}</span><span><strong>Total:</strong> ${escapeHtml(formatDurationMs(job.totalMs ?? job.timings?.totalMs))}</span><span><strong>Execution:</strong> ${escapeHtml(formatDurationMs(job.executionMs ?? job.timings?.executionMs))}</span><span><strong>Artifact:</strong> ${escapeHtml(artifact?.id || 'n/a')}</span></p>
        </div>
        <div class="job-prompt-grid">
          ${renderPromptBlock('Positive prompt', prompt, 'No prompt recorded')}
          ${renderPromptBlock('Negative prompt', negative, 'No negative prompt recorded')}
        </div>
        ${job.error ? `<p class="danger-text">${escapeHtml(job.error.code)}: ${escapeHtml(job.error.message)}</p>` : ''}
        ${hasCancelFailed(job) ? `<p class="danger-text">Cancel failed: ${escapeHtml(job.metadata?.cancelError?.message || 'The backend rejected the cancellation request.')}</p>` : ''}
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

function favoriteDimensions(favorite) {
  const payload = favorite?.requestPayload || {};
  const width = favorite?.width ?? favorite?.artifact?.width ?? payloadNumber(payload, ['width']);
  const height = favorite?.height ?? favorite?.artifact?.height ?? payloadNumber(payload, ['height']);
  return width && height ? `${width}x${height}` : 'size n/a';
}

function favoriteModelLabel(favorite) {
  return favorite?.model || payloadString(favorite?.requestPayload || {}, ['model', 'checkpoint', 'checkpoint_name', 'checkpointName']) || 'model n/a';
}

function favoriteSeedLabel(favorite) {
  return favorite?.seed ?? payloadSeed(favorite?.requestPayload || {}) ?? 'n/a';
}

function artifactUrlFromId(id) {
  const value = String(id || '').trim();
  return value ? `/api/v1/artifacts/${encodeURIComponent(value)}` : '';
}

function favoriteImageUrl(favorite) {
  if (!favorite) return '';
  return favorite.thumbnailUrl
    || favorite.thumbnail_url
    || favorite.imageUrl
    || favorite.image_url
    || favorite.url
    || artifactImageUrl(favorite.artifact)
    || artifactUrlFromId(favorite.artifactId || favorite.artifact_id)
    || firstImageUrl(favorite.job)
    || firstArtifactUrlFromList(favorite.artifacts)
    || '';
}

function renderFavorites() {
  const target = $('#image-lab-favorites');
  if (!target) return;
  const favorites = state.imageFavorites?.favorites || [];
  if (!state.imageFavorites) {
    target.classList.add('placeholder');
    target.innerHTML = '<p class="muted">Loading saved image favorites...</p>';
    return;
  }
  if (favorites.length === 0) {
    target.classList.add('placeholder');
    target.innerHTML = '<p class="muted">No image favorites yet. Save a generated gallery item to pin it here.</p>';
    return;
  }
  target.classList.remove('placeholder');
  target.innerHTML = favorites.map((favorite) => {
    const imageUrl = favoriteImageUrl(favorite);
    const caption = favorite.title || favorite.promptPreview || favorite.jobId || 'Image favorite';
    const promptPreview = favorite.promptPreview || favorite.prompt || caption;
    const model = favoriteModelLabel(favorite);
    const seed = favoriteSeedLabel(favorite);
    const dimensions = favoriteDimensions(favorite);
    const updated = formatDate(favorite.updatedAt || favorite.createdAt);
    return `<article class="image-lab-favorite-card" data-favorite-id="${escapeHtml(favorite.id)}">
      <button type="button" class="image-lab-favorite-thumb" data-favorite-action="load" aria-label="Load favorite ${escapeHtml(caption)}">
        ${imageUrl ? `<img class="image-lab-favorite-image" data-artifact-url="${escapeHtml(imageUrl)}" alt="Favorite image: ${escapeHtml(previewText(caption, 80))}" loading="lazy" decoding="async"><div class="thumb-placeholder">Loading favorite...</div>` : '<div class="thumb-placeholder">No saved image</div>'}
      </button>
      <div class="image-lab-favorite-body">
        <div class="image-lab-favorite-details">
          <strong title="${escapeHtml(caption)}">${escapeHtml(previewText(caption, 64))}</strong>
          <span class="hint image-lab-favorite-model"><code>${escapeHtml(model)}</code></span>
          <span class="hint">seed ${escapeHtml(seed)} - ${escapeHtml(dimensions)} - ${escapeHtml(updated)}</span>
          <span class="image-lab-favorite-prompt">${escapeHtml(previewText(promptPreview, 92))}</span>
        </div>
        <div class="button-row favorite-actions">
          <button type="button" data-favorite-action="load" aria-label="Load favorite ${escapeHtml(caption)}">Load</button>
          <span class="favorite-action-spacer" aria-hidden="true"></span>
          <button type="button" class="secondary danger" data-favorite-action="delete" aria-label="Delete favorite ${escapeHtml(caption)}">Delete</button>
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

async function refreshModelsOnly(message = '', options = {}) {
  state.imageModels = await fetchJson('/api/v1/models/refresh', { method: 'POST' });
  if (options.renderControls === false) renderControlChrome();
  else renderControls();
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
  if (!job?.status) return hasCancelRequested(job) ? 'Canceling...' : 'Submitted';
  const status = String(job.status || '').toLowerCase();
  if (status === 'succeeded') return 'Completed';
  if (status === 'failed') return 'Failed';
  if (status === 'canceled') return 'Canceled';
  if (hasActiveCancelFailure(job)) return 'Cancel failed';
  if (hasCancelRequested(job)) return 'Canceling...';
  if (status === 'queued') return job.clientStatus === 'Submitting...' || job.metadata?.clientStatus === 'Submitting...' ? 'Submitting...' : 'Queued';
  if (status === 'running') return 'Generating...';
  return String(job.status);
}

function resultExtras(result, job, submittedPayload = null) {
  const clientStatus = statusLabelForJob(job);
  const actualSeed = actualSeedForJob(job, result);
  const requestPayload = regenerationPayloadForJob(job, result);
  const artifacts = resultArtifacts(result, job);
  const imageUrl = firstResultImageUrl(result, job);
  return {
    clientStatus,
    requestPayload,
    ...(isPlainObject(submittedPayload) ? { originalRequestPayload: clonePayload(submittedPayload) } : {}),
    ...(artifacts.length ? { artifacts } : {}),
    ...(imageUrl ? { thumbnailUrl: job?.thumbnailUrl || imageUrl, imageUrl } : {}),
    ...(actualSeed !== null ? { seed: actualSeed } : {}),
    ...(job?.cancelRequestedAt ? { cancelRequestedAt: job.cancelRequestedAt } : {}),
    ...(job?.canceledAt ? { canceledAt: job.canceledAt } : {}),
    ...(job?.cancellationReason ? { cancellationReason: job.cancellationReason } : {}),
    resultUrl: result?.result_url || result?.resultUrl || undefined,
    statusUrl: result?.status_url || result?.statusUrl || undefined,
    metadata: {
      clientStatus,
      ...(actualSeed !== null ? { actualSeed } : {}),
      ...(job?.cancelRequestedAt ? { cancelRequestedAt: job.cancelRequestedAt } : {}),
      ...(job?.canceledAt ? { canceledAt: job.canceledAt } : {}),
      ...(job?.cancellationReason ? { cancellationReason: job.cancellationReason } : {}),
      resultUrl: result?.result_url || result?.resultUrl || undefined,
      statusUrl: result?.status_url || result?.statusUrl || undefined
    }
  };
}

function errorJob(error) {
  return isPlainObject(error?.body?.job) ? error.body.job : null;
}

async function finalizeGenerationResult(clientId, submittedPayload, result) {
  const job = result?.job || null;
  if (!job) throw new Error('The generation response did not include a job record.');
  updatePendingJob(clientId, job, resultExtras(result, job, submittedPayload));

  if (job.status === 'canceled') {
    const request = state.cancelRequests.get(clientId);
    if (request) request.confirmedAt = job.canceledAt || job.completedAt || new Date().toISOString();
    setStatus(`Generation canceled for job ${job.id || 'n/a'}.`);
    await refreshGalleryOnly();
    return;
  }

  if (job.status && job.status !== 'succeeded') {
    const error = new Error(job.error?.message || `Generation finished with status ${job.status}.`);
    error.body = { job, error: job.error };
    throw error;
  }

  state.lastResult = result;
  renderLastResult();
  await Promise.allSettled([refreshGalleryOnly(), refreshModelsOnly('', { renderControls: false })]);
  const seed = actualSeedForJob(job, result) ?? 'n/a';
  const cancelNote = state.cancelRequests.has(clientId) ? ' Cancellation had been requested, but the backend completed before it could take effect.' : '';
  setStatus(`Generation complete for job ${job.id || 'n/a'}. Actual seed: ${seed}.${cancelNote}`);
}


function markLocalCancelRequested(job, message = 'Canceling...') {
  const key = cancelRequestKeyForJob(job);
  if (!key) return null;
  const now = new Date().toISOString();
  const existing = state.cancelRequests.get(key) || {};
  state.cancelRequests.set(key, {
    ...existing,
    requestedAt: existing.requestedAt || now,
    reason: 'User requested cancellation.'
  });
  updatePendingJob(key, job, {
    cancelRequestedAt: existing.requestedAt || now,
    cancellationReason: 'User requested cancellation.',
    metadata: {
      clientStatus: message,
      cancelRequestedAt: existing.requestedAt || now,
      cancellationReason: 'User requested cancellation.'
    }
  });
  return state.cancelRequests.get(key);
}

async function sendCancelForBackendJob(clientId, backendJobId, baseJob) {
  const request = state.cancelRequests.get(clientId) || { requestedAt: new Date().toISOString(), reason: 'User requested cancellation.' };
  if (request.sending) return null;
  request.sending = true;
  request.backendJobId = backendJobId;
  state.cancelRequests.set(clientId, request);
  updatePendingJob(clientId, baseJob || {}, {
    cancelRequestedAt: request.requestedAt,
    cancellationReason: request.reason,
    metadata: {
      clientStatus: 'Canceling...',
      cancelRequestedAt: request.requestedAt,
      cancellationReason: request.reason
    }
  });

  try {
    const result = await fetchJson(`/api/v1/jobs/${encodeURIComponent(backendJobId)}/cancel`, { method: 'POST' });
    request.sending = false;
    request.confirmedAt = result.job?.canceledAt || result.job?.completedAt || new Date().toISOString();
    state.cancelRequests.set(clientId, request);
    if (result.job) updatePendingJob(clientId, result.job, resultExtras(result, result.job));
    if (result.job?.status === 'canceled') {
      setStatus(`Generation canceled for job ${backendJobId}.`);
    } else if (result.job?.status === 'succeeded') {
      setStatus(`Cancel requested for job ${backendJobId}, but it had already completed.`);
    } else if (result.job?.metadata?.cancelFailedAt) {
      setStatus(`Cancel failed for job ${backendJobId}: ${result.job.metadata.cancelError?.message || 'backend rejected cancellation'}`, false);
    } else {
      setStatus(`Cancel requested for job ${backendJobId}.`);
    }
    return result;
  } catch (error) {
    const now = new Date().toISOString();
    request.sending = false;
    request.failedAt = now;
    request.error = error.message;
    state.cancelRequests.set(clientId, request);
    updatePendingJob(clientId, baseJob || {}, {
      cancelFailedAt: now,
      metadata: {
        clientStatus: 'Cancel failed',
        cancelFailedAt: now,
        cancelError: { code: error?.body?.error?.code || 'IMAGE_JOB_CANCEL_FAILED', message: error.message }
      }
    });
    setStatus(`Cancel failed: ${error.message}`, false);
    return null;
  }
}

async function cancelGalleryJob(job) {
  const clientId = cancelRequestKeyForJob(job);
  if (!clientId) {
    setStatus('Unable to cancel this job because it has no job identity.', false);
    return;
  }
  markLocalCancelRequested(job, backendJobIdForCancel(job) ? 'Canceling...' : 'Cancel requested...');
  const backendJobId = backendJobIdForCancel(job);
  if (!backendJobId) {
    setStatus('Cancel requested. The request will be sent as soon as the backend job ID is available.');
    return;
  }
  await sendCancelForBackendJob(clientId, backendJobId, job);
}

async function applyDeferredCancelIfNeeded(clientId, job) {
  const request = state.cancelRequests.get(clientId);
  if (!request || !job?.id || isTerminalJobStatus(job.status)) return job;
  const backendJobId = backendJobIdForCancel(job);
  if (!backendJobId) return job;
  const result = await sendCancelForBackendJob(clientId, backendJobId, job);
  return result?.job || pendingJobForClient(clientId) || job;
}

async function submitGenerationJob(clientId, payload) {
  try {
    let result = await fetchJson('/api/v1/generate', { method: 'POST', body: JSON.stringify(payload) });
    let job = result.job || null;
    if (job) {
      state.activeJobId = job.id || state.activeJobId;
      updatePendingJob(clientId, job, resultExtras(result, job));
      job = await applyDeferredCancelIfNeeded(clientId, job);
      if (job) result = { ...result, job };
    }

    if (job?.id && ['queued', 'running'].includes(job.status)) {
      setStatus(`Generation ${job.status}; job ${job.id} is being tracked in the gallery.`);
      result = await pollGenerationResult(job.id, clientId);
      job = result.job || job;
    }

    await finalizeGenerationResult(clientId, payload, result);
  } catch (error) {
    const job = errorJob(error);
    if (job?.status === 'canceled' || error?.body?.error?.code === 'IMAGE_JOB_CANCELED') {
      const message = markPendingJobCanceled(clientId, job || {}, error?.body?.error?.message || 'Image generation was canceled.');
      setStatus(`Generation canceled: ${message}`);
      return;
    }
    const message = markPendingJobFailed(clientId, error, job);
    const target = $('#image-lab-last-result');
    if (target) target.innerHTML = `<p class="danger-text">${escapeHtml(message)}</p>`;
    const prefix = error?.status === 429 ? 'Generation queue limit reached' : 'Generation failed';
    setStatus(`${prefix}: ${message}`, false);
  } finally {
    renderControlChrome();
  }
}

async function handleGenerate(event) {
  event.preventDefault();
  if (state.prewarmingModel) {
    setStatus('Model prewarming is still running. Submit again once the checkpoint is ready.', false);
    return;
  }
  const payload = clonePayload(buildGenerationPayload());
  if (workflowUsesCheckpointModel() && !payload.model) {
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
  renderControlChrome();
}

async function pollGenerationResult(jobId, clientId) {
  let last = null;
  let consecutiveFailures = 0;
  for (let attempt = 0; attempt < GENERATION_POLL_ATTEMPTS; attempt += 1) {
    await sleep(GENERATION_POLL_INTERVAL_MS);
    const localJob = pendingJobForClient(clientId);
    if (localJob?.status === 'canceled') {
      return { ok: false, job: localJob, error: { code: 'IMAGE_JOB_CANCELED', message: localJob.cancellationReason || 'Image generation was canceled.' } };
    }
    try {
      const result = await fetchJson(`/api/v1/jobs/${encodeURIComponent(jobId)}/result?format=url`);
      consecutiveFailures = 0;
      last = result;
      const job = result.job || null;
      if (job) updatePendingJob(clientId, job, resultExtras(result, job));
      const status = job?.status;
      if (isTerminalJobStatus(status) || !isActiveJobStatus(status)) return result;
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
  const actualSeed = actualSeedForJob(job);
  const payload = regenerationPayloadForJob(job);
  if (job?.status === 'canceled') {
    setStatus('Canceled jobs do not have a generated image to save as a favorite.', false);
    return;
  }
  const savedFavoriteImageUrl = artifactImageUrl(artifact) || firstImageUrl(job) || '';
  if (!savedFavoriteImageUrl) {
    setStatus('Wait until the generated image artifact is available before saving a favorite.', false);
    return;
  }
  if (!isPlainObject(payload) || !payload.prompt) {
    setStatus('This job does not have a usable prompt payload to save.', false);
    return;
  }
  if (actualSeed === null) {
    setStatus('Cannot save a deterministic favorite because this completed job did not expose the actual seed used. Refresh the gallery and try again, or regenerate with an explicit seed.', false);
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
    image_url: savedFavoriteImageUrl,
    artifact_id: artifact?.id || undefined,
    job_id: job?.id || undefined,
    artifact: artifact || undefined,
    job: jobForFavoritePayload(job, payload, actualSeed)
  };
  await fetchJson('/api/v1/image-favorites', { method: 'POST', body: JSON.stringify(body) });
  await refreshFavoritesOnly('Saved image favorite with the actual seed in its regeneration payload.');
}

function findGalleryJob(button) {
  const jobs = currentJobs();
  const index = Number(button.dataset.jobIndex);
  if (Number.isInteger(index) && jobs[index]) return jobs[index];
  const card = button.closest('[data-job-id]');
  const jobId = card?.dataset.jobId || '';
  const clientId = card?.dataset.clientId || '';
  return jobs.find((job) => (clientId && String(job.clientId || '') === clientId) || (jobId && String(job.id || '') === jobId)) || null;
}

async function handleGalleryClick(event) {
  if (handleImageViewerLinkClick(event)) return;
  const button = event.target.closest('[data-gallery-action]');
  if (!button || button.disabled) return;
  const job = findGalleryJob(button);
  if (!job) {
    setStatus('Unable to find that gallery job in the current list.', false);
    return;
  }
  const action = button.dataset.galleryAction;
  try {
    if (action === 'cancel-job') {
      await cancelGalleryJob(job);
      return;
    }
    if (action === 'save-favorite') {
      await saveFavoriteFromJob(job);
      return;
    }
    if (action === 'load-settings') {
      const warnings = applyGenerationPayloadToControls(regenerationPayloadForJob(job));
      const warningText = warnings.length ? ` Some fields need attention: ${warnings.join(', ')}.` : '';
      setStatus(`Loaded job settings into the controls.${warningText}`, warnings.length === 0);
      return;
    }
    if (action === 'copy-payload') {
      await navigator.clipboard.writeText(JSON.stringify(regenerationPayloadForJob(job), null, 2));
      setStatus('Copied deterministic regeneration payload to clipboard.');
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
  const negativeDrawer = $('#image-lab-negative-drawer');
  negativeDrawer?.addEventListener('toggle', syncNegativePromptDrawerLayout);
  syncNegativePromptDrawerLayout();
  $('#image-lab-gallery')?.addEventListener('click', handleGalleryClick);
  $('#image-lab-gallery')?.addEventListener('dragstart', handleGalleryImageDragStart);
  $('#image-lab-gallery')?.addEventListener('dragend', handleGalleryImageDragEnd);
  $('#image-lab-last-result')?.addEventListener('click', handleImageViewerLinkClick);
  $('#image-lab-last-result')?.addEventListener('dragstart', handleGalleryImageDragStart);
  $('#image-lab-last-result')?.addEventListener('dragend', handleGalleryImageDragEnd);
  $('#image-lab-favorites')?.addEventListener('click', handleFavoriteClick);
  $('#image-lab-load-more')?.addEventListener('click', async () => {
    state.galleryLimit = Math.min(MAX_GALLERY_LIMIT, state.galleryLimit + GALLERY_LIMIT_STEP);
    await refreshGalleryOnly(`Showing up to ${state.galleryLimit} newest history items.`);
  });
  $('#image-lab-workflow')?.addEventListener('change', async (event) => {
    state.selectedWorkflowId = event.target.value || null;
    applyWorkflowDefaults(true);
    renderModelOptions();
    updatePayloadPreview();
    if (workflowUsesCheckpointModel() && selectedModel()) await prewarmSelectedModel();
  });
  for (const config of RESOLUTION_PRESET_SELECTS.imageLab) {
    $(config.selector)?.addEventListener('change', () => {
      applyResolutionPreset(config.selector, '#image-lab-width', '#image-lab-height', config.orientation, RESOLUTION_PRESET_SELECTS.imageLab);
      updatePayloadPreview();
    });
  }
  $('#image-lab-model')?.addEventListener('change', async () => {
    updatePayloadPreview();
    if (workflowUsesCheckpointModel() && selectedModel()) await prewarmSelectedModel();
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
    const handleParameterChange = () => {
      if (selector === '#image-lab-width' || selector === '#image-lab-height') {
        syncResolutionPresetGroup(RESOLUTION_PRESET_SELECTS.imageLab, '#image-lab-width', '#image-lab-height');
      }
      updatePayloadPreview();
    };
    element?.addEventListener('input', handleParameterChange);
    element?.addEventListener('change', handleParameterChange);
  }
}

wireEvents();
refreshAll();
