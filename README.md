# Coderexic

Context-aware, agentic pull request review for GitHub.

Coderexic is a GitHub App. When a pull request opens, it reads the diff,
consults a dependency graph of the repository (what the changed files
import and what depends on them), lets an AI agent fetch the related code
it needs, and posts validated findings as inline review comments.

> **Status:** Phase 4 (basic diff reviewer). Opening a pull request queues a
> review job; the worker asks Gemini for findings on the diff and posts them
> as an inline GitHub review. Repository-specific rules and config start in
> Phase 5. See [ROADMAP.md](ROADMAP.md).

## Requirements

- Node.js 24 (`.nvmrc`)
- pnpm 10 (`corepack enable` picks the pinned version)
- Docker with Compose v2

## Quick start

```bash
pnpm install
cp .env.example .env              # adjust ports if 5432/6379/3000 are taken
# The API needs a webhook secret to start, even without a GitHub App yet:
sed -i "s/^GITHUB_WEBHOOK_SECRET=.*/GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)/" .env

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
| `pnpm test:integration` | Postgres + Redis-backed tests (throwaway DB/queue) |
| `pnpm db:generate`  | Generate a SQL migration from the schema      |
| `pnpm db:migrate`   | Apply pending migrations                      |
| `pnpm github:smoke` | Check GitHub App access against a real repo   |
| `pnpm build`        | Compile core, then apps, to `dist/`           |
| `pnpm format`       | Prettier write (`format:check` in CI)         |

## Layout

```text
apps/api        Fastify server: webhooks, health, settings APIs
apps/worker     Consumes review jobs from Redis, calls the LLM, publishes
                GitHub reviews
packages/core   Shared code: env, logging, db, github, queue, llm, review
                (later: agent, indexer, config)
```

## Documentation

- [PRODUCT_SPEC.md](PRODUCT_SPEC.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)
- [DATA_MODEL.md](DATA_MODEL.md)
- [AI_AGENT_SPEC.md](AI_AGENT_SPEC.md)
- [ROADMAP.md](ROADMAP.md)
- [AGENTS.md](AGENTS.md): rules for coding agents and contributors
- [docs/github-app.md](docs/github-app.md): registering the GitHub App and local webhooks
