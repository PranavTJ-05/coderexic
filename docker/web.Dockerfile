# syntax=docker/dockerfile:1

# Render-specific. Render's Blueprint builds a Dockerfile's final stage only
# - it has no equivalent of `docker build --target` (confirmed against
# render.com/docs/blueprint-spec and render.com/docs/docker, neither
# documents a build-target field), so the root Dockerfile's single
# multi-target file (used by docker-compose.yml and
# .github/workflows/ci.yml) can't be deployed as-is on Render. This
# duplicates just its `base`/`build`/`web` stages into one self-contained
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
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages/core ./packages/core
COPY apps/web ./apps/web
RUN pnpm --filter @coderexic/core --filter @coderexic/web build
# No `pnpm deploy` here, unlike api/worker: Next's own `output: 'standalone'`
# (apps/web/next.config.ts) already produces its own pruned, self-contained
# bundle via import tracing, copied directly below.

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node
# Standalone output's own node_modules (traced from actual imports) plus the
# monorepo-root node_modules pnpm's workspace layout traces alongside it -
# both required.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
# Standalone output deliberately omits static assets and public files -
# Next's own documented requirement, not an oversight.
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health > /dev/null || exit 1
CMD ["node", "apps/web/server.js"]
