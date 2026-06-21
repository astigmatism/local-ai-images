FROM node:22-bookworm-slim

ARG COMFYUI_REPO=https://github.com/Comfy-Org/ComfyUI.git
ARG COMFYUI_REF=master
ARG PYTORCH_INDEX_URL=https://download.pytorch.org/whl/cu128

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000 \
    COMFYUI_HOST=127.0.0.1 \
    COMFYUI_PORT=8188 \
    COMFYUI_BASE_URL=http://127.0.0.1:8188 \
    COMFYUI_DIR=/opt/comfyui/ComfyUI \
    COMFYUI_VENV=/opt/comfyui/venv \
    COMFYUI_OUTPUT_DIR=/app/data/artifacts/comfyui-output \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PATH=/opt/comfyui/venv/bin:${PATH}

USER root

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    ffmpeg \
    git \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    python3 \
    python3-dev \
    python3-pip \
    python3-venv \
    tini \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/comfyui \
    && (git clone --depth 1 --branch "${COMFYUI_REF}" "${COMFYUI_REPO}" "${COMFYUI_DIR}" \
    || (git clone "${COMFYUI_REPO}" "${COMFYUI_DIR}" \
    && cd "${COMFYUI_DIR}" \
    && git checkout "${COMFYUI_REF}"))

RUN python3 -m venv "${COMFYUI_VENV}" \
    && "${COMFYUI_VENV}/bin/python" -m pip install --upgrade pip setuptools wheel \
    && "${COMFYUI_VENV}/bin/pip" install torch torchvision torchaudio --index-url "${PYTORCH_INDEX_URL}" \
    && "${COMFYUI_VENV}/bin/pip" install -r "${COMFYUI_DIR}/requirements.txt" --extra-index-url "${PYTORCH_INDEX_URL}" \
    && "${COMFYUI_VENV}/bin/pip" cache purge

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY src ./src
COPY public ./public
COPY docs ./docs
COPY deploy ./deploy
COPY config ./config
COPY README.md ./README.md
COPY tsconfig.json ./tsconfig.json
COPY docker-entrypoint.sh /usr/local/bin/local-ai-images-entrypoint

RUN mkdir -p \
    /app/config \
    /app/config/workflows \
    /app/data/artifacts \
    /cache \
    /models \
    && chmod +x /usr/local/bin/local-ai-images-entrypoint \
    && chown -R node:node /app /cache /models /opt/comfyui

USER node

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:8000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/local-ai-images-entrypoint"]