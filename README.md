<p align="center">
  <img src="docs/media/logo.png" alt="Coderexic" width="180">
</p>

<h1 align="center">Coderexic</h1>

<p align="center">
  <strong>Context-aware, agentic pull request review for GitHub.</strong>
</p>

<p align="center">
  <a href="https://github.com/PranavTJ-05/coderexic/actions/workflows/ci.yml">
    <img src="https://github.com/PranavTJ-05/coderexic/actions/workflows/ci.yml/badge.svg" alt="CI status">
  </a>
  <img src="https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white" alt="Node 24">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript strict">
  <img src="https://img.shields.io/badge/tests-685%20passing-10b981" alt="685 tests passing">
</p>

---

Coderexic is a GitHub App. When a pull request opens, it reads the diff,
consults a dependency graph of the repository (what the changed files
import and what depends on them), lets an AI agent fetch the related code
it actually needs, and posts validated findings as inline review comments
directly on the PR.

It exists because a diff-only review misses a change's *impact*: a function
edited in isolation might break a caller three files away, silently change
an auth check, or violate a convention only visible in a sibling file.
Coderexic gives the model a map of the repository and lets it decide what
else to look at, instead of guessing from the diff alone.

## Demo

<!--
  Drop the recorded walkthrough here, e.g.:
  [![Coderexic walkthrough](docs/media/video-thumbnail.png)](https://youtu.be/your-video-id)
  A GitHub-hosted .mp4 dragged into this file via the GitHub web editor
  auto-embeds without needing a thumbnail trick.
-->

*(video walkthrough coming soon)*

## Features

- **Automatic PR review.** Opening or pushing to a pull request queues a
  review job with no setup beyond installing the App — no explaining the
  codebase to the model.
- **Dependency-aware context.** An incremental graph indexer resolves
  imports across **TypeScript, JavaScript, Python, Go, Rust, Java and
  Ruby**, both forward (what a file imports) and reverse (what depends on
  it), so review isn't limited to the diff's own lines.
- **Agentic review loop (opt-in).** With `AGENT_LOOP_ENABLED=true`, the
  model itself decides when to call `get_imports`, `get_dependents` and
  `get_file_content` before ending with `submit_review`, instead of having
  everything pre-fetched and inlined for it. Off by default — more model
  calls per review, and newer than the one-shot path.
- **One-shot fallback by default.** Without the agent loop, the worker
  sends a single prompt (diff + related-file context + repo rules) and
  posts one structured review — deterministic, cheap, and always available.
- **Multi-provider models.** Gemini, OpenAI, Anthropic or Groq — pick one
  with `MODEL_PROVIDER`; only that provider's API key needs to be set. A
  repository's own `.coderexic.yml` can select a different *configured*
  provider per review.
- **Bring your own key (BYOK).** A repo admin can store their own provider
  API key through the web UI; it's encrypted at rest (AES-256-GCM,
  versioned master keys, rotation, soft deletion) and resolved
  `repo > user > system` at review time.
- **Repo-specific rules.** A `.coderexic.yml`/`.verix.yml` plus a rules file
  (loaded from the PR's base commit, never its head, so a PR can't edit its
  own review rules to silence findings about itself) shape minimum
  severity, ignored paths, language hints and model selection per repo.
- **Manual re-review.** Any authorized collaborator can comment
  `/review review` on an open PR to trigger a fresh review on demand,
  independent of the automatic per-push dedup.
- **Web dashboard.** Sign in with GitHub, see every repository you're
  authorized to review, browse review history, drill into a single
  review's findings, and manage per-repo settings (severity threshold,
  ignore patterns, model provider/BYOK) — authorization is re-checked
  live against GitHub, never cached.
- **Observability.** Both `api` and `worker` expose Prometheus metrics at
  `/metrics` (webhook delivery, queue depth, review latency/outcome, model
  token usage, agent turns and tool calls, errors by code), bearer-token
  gated and never exposed unauthenticated by default. `/health` and
  `/ready` liveness/readiness endpoints on both processes.
- **Evaluation harness.** A scored eval suite (precision, recall, line
  accuracy, severity accuracy, cost, latency) runs fixture PRs — known-bug
  cases and false-positive traps — through the *same* post-processing
  pipeline production uses, so what gets measured is what a user would
  actually see.

## How it works

```text
GitHub PR opened/pushed
        |
        v
  apps/api  (webhook received, signature verified, job enqueued)
        |
        v  Redis / BullMQ
        |
        v
  apps/worker
        |-- fetch PR diff + repo config + rules (from base commit)
        |-- consult the dependency graph for related files
        |-- (optional) agent loop: model requests more context on demand
        |-- ask the model for structured findings
        |-- filter by ignore patterns + minimum severity, dedupe, place
        |   findings on real diff lines
        v
  GitHub PR review posted (inline comments + summary)
```

A push also queues an incremental dependency-graph index; if a PR's base
commit isn't indexed yet, the review pipeline kicks off an index run itself
rather than waiting for the next push.

### What a review actually looks like

One inline comment per finding, anchored to the exact line(s):

> **🟠 High:** SQL query built with string concatenation from unsanitized
> user input — use a parameterized query instead.
> ```suggestion
> const rows = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
> ```

Plus one top-level review summary with any findings that couldn't be
anchored inline (and why), and a hidden marker so a retried job never
posts the same review twice.

## Use cases

- **Solo developers** who want a second pair of eyes on every PR without
  waiting on a human reviewer's schedule.
- **Small teams** who want consistent review coverage (missing `await`s,
  null derefs, injection, leaked resources) without slowing down senior
  engineers doing style nitpicks.
- **OSS maintainers** who want first-pass triage on external contributions
  before spending their own review time.
- **Self-hosted deployments** where a team wants control over which model
  provider sees their code, or wants to bring their own API key per
  repository rather than sharing one deployment-wide key.

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

# apps/web needs its own env file - see apps/web/.env.example
cp apps/web/.env.example apps/web/.env.local
pnpm dev:web                      # http://localhost:3001 (fixed port; apps/api already owns :3000)
```

Full stack in containers:

```bash
docker compose up --build
curl http://127.0.0.1:3000/health
```

To get real reviews happening (not just a running stack), you additionally
need: one model provider API key set in `.env`, and a registered GitHub App
pointed at your running `api` with its webhook reaching it (a local tunnel
like smee or ngrok for local dev). See
[docs/github-app.md](docs/github-app.md) for the exact registration steps.

## Observability

Both `api` and `worker` expose Prometheus metrics at `/metrics` (the worker
also gets its own `/health`, on `METRICS_PORT`, default `9091`, since it has
no other HTTP surface). `/metrics` is bearer-token gated: set `METRICS_TOKEN`
on the process (same value on both, or different, they're independent) and
send `Authorization: Bearer <token>`. Leaving `METRICS_TOKEN` unset means
`/metrics` isn't registered at all on the API and always answers 404 on the
worker — it's never exposed unauthenticated by default.

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:3000/metrics       # api
curl -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:9091/metrics       # worker
```

## Evaluation

```bash
pnpm eval                         # scripted mode: no API key, no spend, proves the harness
pnpm eval:live \
  --provider gemini \
  --i-understand-this-spends-real-money   # runs fixtures through a real model - costs money
```

`pnpm eval` scores 37 fixture cases (27 known-bug, 10 false-positive traps)
through the same finding post-processing production uses, and reports
precision, recall, line accuracy, severity accuracy, cost and latency. The
scripted run proves the *harness* is correct (it scores its own scripted
oracle at precision = recall = 1.0); it is not a measured quality baseline
for any real model — that requires `eval:live` and an explicit
acknowledgment that it spends real money.

## Development commands

| Command                 | What it does                                              |
| ------------------------ | ------------------------------------------------------------ |
| `pnpm install`           | Install all workspace dependencies                           |
| `pnpm dev:api`           | Run `apps/api` in watch mode                                  |
| `pnpm dev:worker`        | Run `apps/worker` in watch mode                               |
| `pnpm dev:web`           | Run `apps/web` (Next.js dashboard) in watch mode              |
| `pnpm dev:landing`       | Run `apps/landing` (marketing site) in watch mode             |
| `pnpm lint`              | ESLint (type-aware) across the workspace                     |
| `pnpm typecheck`         | `tsc --noEmit` per package; no build needed                  |
| `pnpm test`              | Unit tests (Vitest, no services needed)                      |
| `pnpm test:integration`  | Postgres + Redis-backed tests (throwaway DB/queue)           |
| `pnpm eval`              | Evaluation harness, scripted mode — no API key, no spend     |
| `pnpm eval:live`         | Evaluation harness against a real provider — costs money     |
| `pnpm db:generate`       | Generate a SQL migration from the schema                     |
| `pnpm db:migrate`        | Apply pending migrations                                     |
| `pnpm github:smoke`      | Check GitHub App access against a real repo                  |
| `pnpm graph:index`       | Run the dependency-graph indexer against a repo directly     |
| `pnpm build`             | Compile `packages/core`, then every app, to `dist/`           |
| `pnpm format`            | Prettier write (`format:check` in CI)                        |

## Project status

18 of the 22 phases in [ROADMAP.md](ROADMAP.md) are complete (pending
merge): repository foundation, database, GitHub App integration, diff
review, repo config, dependency graph, context engine, agent tools/loop,
multi-provider models, BYOK, re-review, the web dashboard (auth, browsing,
settings), observability, the evaluation harness, security hardening,
reliability, and production deployment (Render + Vercel,
[docs/deployment.md](docs/deployment.md)).

As of this commit: **470 unit tests** and **215 integration tests**, all
passing, plus a 37-case evaluation suite (27 known-bug, 10 false-positive).

Ahead: beta on 5-10 real repos, tracking review latency, false positives
and model cost before adding anything else. See [ROADMAP.md](ROADMAP.md) for
the full phase-by-phase breakdown and what "done" means for each one.

## Layout

```text
apps/api        Fastify server: webhooks, health/readiness, metrics,
                settings APIs
apps/worker     Consumes review jobs and index runs from Redis; calls the
                LLM and publishes GitHub reviews; builds the dependency
                graph; exposes its own health/metrics listener
apps/web        Next.js dashboard: GitHub sign-in, repository list, review
                history, per-repo settings and BYOK
apps/landing    Next.js marketing site (deployed separately, on Vercel) -
                no backend dependency, no env vars beyond the app's URL
packages/core   Shared code: env, logging, metrics, db, github, queue,
                llm, review, config, graph, context, agent, crypto,
                evaluation
```

## Documentation

- [PRODUCT_SPEC.md](PRODUCT_SPEC.md): what Coderexic is and who it's for
- [ARCHITECTURE.md](ARCHITECTURE.md): system design and component boundaries
- [DATA_MODEL.md](DATA_MODEL.md): database schema and its reasoning
- [AI_AGENT_SPEC.md](AI_AGENT_SPEC.md): the review agent's tools, loop and
  guardrails
- [ROADMAP.md](ROADMAP.md): phase-by-phase build plan and current status
- [AGENTS.md](AGENTS.md): rules for coding agents and contributors
- [docs/github-app.md](docs/github-app.md): registering the GitHub App and
  local webhook forwarding
- [docs/deployment.md](docs/deployment.md): production deployment on Render
- [docs/dependencies.md](docs/dependencies.md): why each dependency was
  added, and what it would take to remove it

<p align="center">Built with ❤️ by <a href="https://github.com/PranavTJ-05">PranavTJ-05</a></p>
