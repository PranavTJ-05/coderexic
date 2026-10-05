# syntax=docker/dockerfile:1

# Render-specific. Render's Blueprint builds a Dockerfile's final stage only
# - it has no equivalent of `docker build --target` (confirmed against
# render.com/docs/blueprint-spec and render.com/docs/docker, neither
# documents a build-target field), so the root Dockerfile's single
# multi-target file (used by docker-compose.yml and
# .github/workflows/ci.yml) can't be deployed as-is on Render. This
# duplicates just its `base`/`build`/`worker` stages into one self-contained
# file. Keep both in sync (docs/deployment.md explains the split in full).

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/worker/package.json apps/worker/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY apps/worker ./apps/worker
RUN pnpm --filter @coderexic/core --filter @coderexic/worker build
RUN pnpm deploy --filter @coderexic/worker --prod --legacy /out/worker

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node
COPY --from=build --chown=node:node /out/worker ./
EXPOSE 9091
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9091/health > /dev/null || exit 1
CMD ["node", "dist/index.js"]
