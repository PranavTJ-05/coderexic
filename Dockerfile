# syntax=docker/dockerfile:1

# One image definition, three targets: `api`, `worker` and `web`. Used by
# docker-compose.yml (local dev) and .github/workflows/ci.yml (build
# verification on every PR).
#   docker build --target api -t coderexic-api .
#   docker build --target worker -t coderexic-worker .
#   docker build --target web -t coderexic-web .
#
# Render deploys (ROADMAP.md Phase 18, render.yaml) use the separate
# docker/api.Dockerfile, docker/worker.Dockerfile and docker/web.Dockerfile
# instead, NOT this file: Render's Blueprint builds a Dockerfile's final
# stage only, with no equivalent of `--target` (confirmed against
# render.com/docs/blueprint-spec and render.com/docs/docker), so a
# multi-target file can't be deployed as-is there. Those three files
# duplicate this one's relevant stages - keep all four in sync.

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
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY apps/web ./apps/web
RUN pnpm --filter @coderexic/core --filter @coderexic/api --filter @coderexic/worker --filter @coderexic/web build
# Self-contained production trees with only runtime dependencies. apps/web
# isn't included here - unlike api/worker, Next's own `output: 'standalone'`
# (apps/web/next.config.ts) already produces its own pruned, self-contained
# bundle via import tracing, copied directly from the build stage below.
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
EXPOSE 9091
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9091/health > /dev/null || exit 1
CMD ["node", "dist/index.js"]

FROM runtime AS web
# Standalone output's own node_modules (traced from actual imports) plus the
# monorepo-root node_modules pnpm's workspace layout traces alongside it -
# both required, neither produced by `pnpm deploy` (apps/web isn't deployed
# that way - see the build stage's comment above).
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
# Standalone output deliberately omits static assets and public files -
# Next's own documented requirement, not an oversight.
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health > /dev/null || exit 1
CMD ["node", "apps/web/server.js"]
