# Coderexic

Context-aware, agentic pull request review for GitHub.

Coderexic is a GitHub App. When a pull request opens, it reads the diff,
consults a dependency graph of the repository (what the changed files
import and what depends on them), lets an AI agent fetch the related code
it needs, and posts validated findings as inline review comments.

> **Status:** Phase 3 (GitHub App). Webhooks are verified and recorded, pull
> requests create pending review jobs, and the GitHub client can read PRs
> and publish reviews. Reviewing itself starts in Phase 4. See [ROADMAP.md](ROADMAP.md).

## Requirements

- Node.js 24 (`.nvmrc`)
- pnpm 10 (`corepack enable` picks the pinned version)
- Docker with Compose v2

## Quick start

```bash
pnpm install
cp .env.example .env              # adjust ports if 5432/6379/3000 are taken

docker compose up -d postgres redis
pnpm db:migrate
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
| `pnpm test`         | Unit tests (Vitest, no services needed)       |
| `pnpm test:integration` | Postgres-backed tests (throwaway database) |
| `pnpm db:generate`  | Generate a SQL migration from the schema      |
| `pnpm db:migrate`   | Apply pending migrations                      |
| `pnpm github:smoke` | Check GitHub App access against a real repo   |
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
- [docs/github-app.md](docs/github-app.md): registering the GitHub App and local webhooks
