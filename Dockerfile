# syntax=docker/dockerfile:1

# One image definition, two targets: `api` and `worker`.
#   docker build --target api -t coderexic-api .
#   docker build --target worker -t coderexic-worker .

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS build
# Manifests first so the dependency layer is cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm build
# Self-contained production trees with only runtime dependencies.
RUN pnpm deploy --filter @coderexic/api --prod --legacy /out/api \
 && pnpm deploy --filter @coderexic/worker --prod --legacy /out/worker

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node

FROM runtime AS api
COPY --from=build --chown=node:node /out/api ./
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health > /dev/null || exit 1
CMD ["node", "dist/index.js"]

FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker ./
CMD ["node", "dist/index.js"]
