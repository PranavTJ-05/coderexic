# Coderexic

Context-aware, agentic pull request review for GitHub.

Coderexic is a GitHub App. When a pull request opens, it reads the diff,
consults a dependency graph of the repository (what the changed files
import and what depends on them), lets an AI agent fetch the related code
it needs, and posts validated findings as inline review comments.

> **Status:** Phase 1 (repository foundation). The API and worker start,
> validate configuration and serve health checks; review features arrive in
> later phases. See [ROADMAP.md](ROADMAP.md).

## Requirements

- Node.js 24 (`.nvmrc`)
- pnpm 10 (`corepack enable` picks the pinned version)
- Docker with Compose v2

## Quick start

```bash
pnpm install
cp .env.example .env              # adjust ports if 5432/6379/3000 are taken

docker compose up -d postgres redis
pnpm dev:api                      # http://127.0.0.1:3000/health
pnpm dev:worker
```

Full stack in containers:

```bash
docker compose up --build
curl http://127.0.0.1:3000/health
```

## Development commands

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `pnpm lint`         | ESLint (type-aware) across the workspace      |
| `pnpm typecheck`    | `tsc --noEmit` per package; no build needed   |
| `pnpm test`         | Vitest                                        |
| `pnpm build`        | Compile core, then apps, to `dist/`           |
| `pnpm format`       | Prettier write (`format:check` in CI)         |

## Layout

```text
apps/api        Fastify server: webhooks, health, settings APIs
apps/worker     Background jobs: repository indexing and reviews
packages/core   Shared code: env validation, logging, and later
                GitHub, agent, LLM, indexer, config and DB modules
```

## Documentation

- [PRODUCT_SPEC.md](PRODUCT_SPEC.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [DATA_MODEL.md](DATA_MODEL.md)
- [AI_AGENT_SPEC.md](AI_AGENT_SPEC.md)
- [ROADMAP.md](ROADMAP.md)
- [AGENTS.md](AGENTS.md): rules for coding agents and contributors
