FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000 \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility

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

RUN mkdir -p /app/config /app/data/artifacts /app/models /app/config/workflows /cache \
    && chown -R node:node /app /cache

USER node

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]