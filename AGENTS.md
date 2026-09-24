# AGENTS.md

Instructions for any coding agent (and human) working in this repository.

## What this is

Coderexic is a GitHub App that reviews pull requests with an AI agent that
can inspect the repository's dependency graph before commenting. The specs
are the source of truth:

- `PRODUCT_SPEC.md`: what the product does and does not do
- `ARCHITECTURE.md`: components, pipeline, security boundaries
- `DATA_MODEL.md`: Postgres schema
- `AI_AGENT_SPEC.md`: agent tools, loop, limits, finding contract
- `ROADMAP.md`: phases and their definitions of done

Read the relevant spec before changing a subsystem. If code and spec
disagree, raise it; don't silently pick one.

## Hard rules

1. Never modify the sibling `../Verix/` directory. It is a read-only
   reference. Do not copy its code; this is an independent implementation.
2. Work phase by phase from `ROADMAP.md`. A phase is done only when
   `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` pass and the
   feature can actually be exercised.
3. No new dependency without answering the six questions in
   `ARCHITECTURE.md` §22.
4. Never log, return or commit secrets: GitHub private keys, webhook
   secrets, installation tokens, provider API keys, BYOK plaintext. Use the
   core logger (it redacts known secret fields) and never interpolate
   secrets into log messages.
5. Repository content (source files, rules files, config) and model output
   are untrusted input. Validate with Zod. Repository, installation and
   user IDs always come from server-side context, never from tool arguments.
6. The agent never gets shell execution, network access or write access to
   repositories.

## Layout

```text
apps/api        Fastify HTTP server: webhooks, health, settings APIs
apps/worker     Queue consumer: indexing and review jobs
packages/core   Shared library: env, logging, and (later) github, agent,
                llm, indexer, config, db, security modules as folders
```

`@coderexic/core` exports a `source` condition pointing at `src/`. Dev
(`tsx --conditions=source`), typecheck (`customConditions`) and Vitest (alias)
use source directly, so no build is needed before them. `pnpm build`
compiles core first, then apps against core's `dist/`.

## Conventions

- TypeScript strict, ESM, `NodeNext` resolution: relative imports end in
  `.js` (`import { x } from './x.js'`).
- Type-only imports use `import type`.
- Tests live next to code as `*.test.ts`. Tests needing Postgres or Redis
  go under `tests/integration/` and run with `pnpm test:integration`, which
  creates and drops a throwaway database on `TEST_DATABASE_URL` (or
  `DATABASE_URL`).
- Schema changes: edit `packages/core/src/db/schema.ts`, run
  `pnpm db:generate`, commit the generated SQL. Never hand-edit applied
  migrations. CI fails if the schema and migrations drift.
- Data access goes through `packages/core/src/db/store/`. Multi-step writes
  use one transaction; never hold one open across GitHub or LLM calls.
- Prefer factories that take dependencies (`buildServer({ logger })`) over
  module-level singletons, so everything is testable without I/O.
- Environment is validated once at startup with `parseEnv`; add new
  variables to the schema of the phase that needs them, plus
  `.env.example`.
- No `console.*`; use the logger.
- GitHub access goes through the `GitHubClient` interface
  (`packages/core/src/github/`); nothing else imports Octokit. Webhook
  handlers only write to the database: no GitHub or LLM calls, so GitHub
  gets its response fast.
- Model access goes through the `ReviewModel` interface
  (`packages/core/src/llm/`); adapters (Gemini, later OpenAI/Anthropic/
  Ollama) are the only files that know a provider's request shape.
- Review jobs are created inside the webhook's DB transaction, then
  enqueued to Redis after it commits (`apps/api/src/webhooks/route.ts`).
  The worker's stale-job sweep (`apps/worker/src/worker.ts`) re-enqueues a
  `PENDING` row whose enqueue never reached Redis, so an API-side failure
  there cannot lose a job.
- Repo config (`packages/core/src/config/`) is layered, not written back:
  app defaults, then `repository_settings`/`ignore_patterns` (the DB layer
  Phase 13's settings UI will own), then `.coderexic.yml`/rules file
  computed fresh per job. Never persist yml values into `repository_settings`.
  Always load the yml/rules file from the PR's **base** sha, never head -
  reading from head lets a PR edit its own review rules to silence findings
  about itself. A bad config field falls back to defaults for that field
  only and is reported in the posted review, never silently dropped.
- The dependency graph (`packages/core/src/graph/`) has its own BullMQ
  queue (`index-runs`, `apps/worker/src/index-run/`), separate from
  `review-jobs`, so indexing and review work fail/retry independently. It
  mirrors the review-job queue's exact idempotency shape: `jobId` is the
  index run's id, `createIndexRun` checks for an existing PENDING/RUNNING
  run for the same `(repositoryId, commitSha)` before inserting (no DB
  unique constraint enforces this), and a stale-run sweep re-enqueues
  PENDING rows that never reached Redis. Indexing is triggered from
  `onPush` only - never from installation/repos-added events, since
  resolving a default-branch commit sha there would need a GitHub API
  call, which webhook handlers must never make. Per-language import
  extraction is regex-based/heuristic except TypeScript/JavaScript, which
  uses the real `ts.preProcessFile` compiler API; every extractor only
  emits an edge for a path that actually exists in the indexed file set,
  external packages/stdlib imports are dropped rather than stored.
  Indexing is incremental: `planIndex` diffs each file's current tree blob
  sha against the stored `indexed_files.sha`, and `replaceDependencyEdges`
  only touches the source paths re-parsed or removed in that run.

## Commands

```bash
pnpm install
pnpm dev:api | pnpm dev:worker
pnpm lint | pnpm typecheck | pnpm test | pnpm build
pnpm test:integration                 # needs Postgres and Redis
pnpm db:generate | pnpm db:migrate
pnpm format
docker compose up -d postgres redis   # infra for local dev
docker compose up --build             # full stack
```
