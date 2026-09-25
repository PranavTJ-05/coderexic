# Architecture: Coderexic

Section numbers are kept stable. `AGENTS.md` cites §22.

## 1. Principles
1. GitHub is the source of truth for repo state.
2. The DB holds app state and the indexed graph, not an authoritative copy of
   the source.
3. AI is an analysis component, not the system of record.
4. Agent tools are explicit and allowlisted.
5. External providers sit behind interfaces.
6. Webhooks enqueue work; workers do the long-running analysis.
7. Every external input is untrusted.
8. Every expensive operation has a budget.
9. Every major capability can be tested on its own.
10. Start as a modular monolith. Split only when scale demands it.

## 2. High-level flow
```text
GitHub --webhook/API--> API/Webhook server --create job--> Queue --> Review Worker
Worker uses: GitHub API, Repository DB, Config Loader
  -> Context/Graph Engine -> Review Agent (tools: imports, dependents, file content)
  -> LLM Provider -> Structured Review -> Validation Layer -> GitHub API -> PR comments
```

## 3. Repository layout
The spec's full monorepo sketch:
- `apps/`: `api`, `worker`, `web`
- `packages/`: core, github, agent, llm, indexer, config, database, security,
  observability, shared
- `tests/`: fixtures, integration, evaluation
- `infra/`: docker, deployment
- `docs/`
- root files: `.env.example`, `docker-compose.yml`, and the spec docs

A smaller first build may be one TypeScript app with modules. Never put a
network boundary between packages.

**Decision:** Coderexic uses the lean variant. It has `apps/api`,
`apps/worker` and `apps/web` (Phase 13a), and one `packages/core` split
into folders.

## 4. Runtime components
- **API:**
  - health checks
  - webhooks and install callbacks
  - It never runs agent reviews itself.
- **Web** (`apps/web`, Phase 13a): the hosted UI, GitHub OAuth/session, user
  settings, review-status pages. See "Decisions made while implementing
  (Phase 13a)" below for why this moved off the original sketch's "API"
  bullet.
- **Worker:** consumes review jobs. It fetches the PR, loads config, makes
  sure the graph is current, runs the agent, validates findings, publishes the
  GitHub review and persists the result.
- **Queue:** choose one and never build a custom queue. The options were
  Redis + BullMQ, a Postgres-backed queue (tiny deploys) or SQS (AWS).
  **Decision: Redis + BullMQ.**
- **PostgreSQL** stores:
  - users, installations, repos and repo settings
  - dependency edges
  - review jobs, reviews and findings
  - provider config metadata and encrypted credentials
  - audit events

### Decisions made while implementing (Phase 13a)
- **GitHub OAuth and session live in `apps/web`, not `apps/api`.** The
  original sketch (§4 above, pre-13a) put "GitHub OAuth (if there's a hosted
  UI)" under API. Once there was a hosted UI (Next.js, per §21), the
  practical choice was Auth.js/next-auth, which is a Next.js library - it
  owns the OAuth callback route and the session cookie itself, and doesn't
  integrate cleanly with a separate Fastify process. `apps/api` keeps
  webhooks and install callbacks only; it has no user-facing routes.
- **`apps/web` reads the database directly through `@coderexic/core`, not
  through `apps/api` over HTTP.** Consistent with §3's "never put a network
  boundary between packages" - `apps/web` is a peer of `apps/api`/
  `apps/worker`, all three importing the same `packages/core` store
  functions directly, not a client of `apps/api`. The operational cost:
  `apps/web/tsconfig.json` sets `"customConditions": ["source"]`
  (matching `apps/api`/`apps/worker`), so `tsc`/ESLint resolve
  `@coderexic/core` straight from `packages/core/src` - `pnpm typecheck`/
  `pnpm lint` need no prior build. Next's own bundler doesn't read that
  tsconfig setting, though: `next build` resolves the package via its
  `exports` map's `default` (built `dist/`) condition regardless, so
  `@coderexic/core` genuinely must be built (`pnpm --filter
  @coderexic/core build`) before `apps/web` can build - transparent from
  the root `pnpm -r build` script, which already runs in dependency order.
- **Authorization for "which repos can this user see" never trusts GitHub's
  API alone.** `packages/core/src/github/user-access.ts`'s
  `listAuthorizedRepositories` calls `GET /user/installations` and
  `GET /user/installations/{id}/repositories` with the signed-in user's own
  GitHub App user-to-server token (not an installation token), then
  cross-checks every result against this app's own DB rows
  (`removed_at is null`) - so a deselected repository or an uninstalled app
  never shows up even if GitHub's API were momentarily stale, and an org
  member only ever sees the subset of an "all repositories" install that
  their own GitHub permissions actually grant (PRODUCT_SPEC.md §17.10).

### Decisions made while implementing (Phase 13b)
- **Every repo/review page route re-derives authorization from GitHub, by
  ID, never by trusting the URL.** `/repositories/[repositoryId]` uses
  `findAuthorizedRepository` (a thin wrapper over `listAuthorizedRepositories`
  filtered to one id); `/reviews/[jobId]`'s `findAuthorizedReviewJob` checks
  the job's *own* `repositoryId`, not whatever repository the linking page
  happened to be on - otherwise a user authorized for repo A could read repo
  B's findings by pasting repo B's job id into a repo-A URL. Both live in
  `packages/core` (not a route handler) specifically so they're
  integration-testable the same way `listAuthorizedRepositories` already
  is - `tests/integration/db/dashboard.test.ts` has explicit cross-repo and
  removed-repository cases. A "not found or not authorized" case is always a
  plain 404, never a 403, so existence never leaks.
- **Repositories are routed by `repositoryId` (the app's own UUID), never by
  `owner/name`.** `repositories.fullName` has a non-unique index, not a
  unique constraint, and goes stale on a GitHub rename - the same reason
  `listAuthorizedRepositories` never matches by `owner_login`.
- **API routes return explicit DTOs (`apps/web/src/dto.ts`), never DB rows
  or `AuthorizedRepository` spread directly.** A column added to the schema
  later can't leak to the client just by existing; it has to be added to a
  `to*Dto` mapper on purpose.
- **LLM-authored text (review summaries, finding descriptions) is rendered
  as plain text (`whitespace-pre-wrap`), never as markdown or
  `dangerouslySetInnerHTML`.** Model output is untrusted (§1, §13) even
  when it's ours to display, not just when it's a tool input.
- **The GitHub App install link is never round-tripped through a
  `setup_action`/`installation_id` query param.** GitHub's install flow can
  redirect back with those params, but they're client-suppliable and
  therefore not trusted for anything - the dashboard always re-derives "what
  am I authorized for" via `listAuthorizedRepositories` on load, exactly as
  it would on any other visit. The install link itself is built from
  `GITHUB_APP_SLUG` (optional; the dashboard's empty state degrades to no
  link when it's unset) rather than a `NEXT_PUBLIC_*` var, since Next
  inlines `NEXT_PUBLIC_*` at `next build` time - a build with the var unset
  would bake in `undefined` for every later deploy until the next rebuild.
- **Tailwind v4 (via `@tailwindcss/postcss`) + hand-authored, shadcn-style
  primitives**, not the `shadcn` CLI's generated files. Verified by actually
  running `shadcn@latest init` first: it requires Tailwind and an import
  alias to already exist and does neither itself, and `apps/web`'s
  convention is extension-less relative imports rather than a `@/*` alias -
  adding one just for the CLI was more churn than it was worth for a
  handful of components. `apps/web/src/components/ui.tsx` matches shadcn's
  visual language (Tailwind utilities + `cva` variants + a `cn()` helper)
  by hand instead.

### Decisions made while implementing (Phase 13c)
- **Repo-level authorization is a GitHub *admin* check
  (`AuthorizedRepository.isAdmin`), separate from "can see this repo."**
  `packages/core/src/github/user-access.ts` reads `permissions.admin` off
  GitHub's repository object (verified against GitHub's own OpenAPI spec
  that `GET /user/installations/{id}/repositories` returns that field, not
  assumed from prose) - a member who sees a repo through an org's "all
  repositories" install must not be able to change what a review costs or
  which key bills it. `permissions` isn't itself a required field on the
  shared schema, so its absence is treated as not-admin (fail closed).
  `apps/web/src/authorize.ts`'s `requireRepoAdmin` is the one gate every
  settings/BYOK/ignore-pattern write route shares.
- **BYOK credential resolution lives in the worker, repo-tier only - no
  `userId` is ever passed.** A review job has a repository and (for a
  manual trigger) a triggering comment, but no signed-in user - the
  `resolveProviderEntry` call `apps/worker/src/review/pipeline.ts`'s new
  `resolveReviewProvider` makes only ever looks up a repo-scoped
  credential, never a user-scoped one (user-scoped BYOK, built in Phase
  11, has no consumer yet - it would need an actual "review triggered
  by/for a specific user" concept this system doesn't have).
- **A BYOK resolution failure fails the review; it never falls back to the
  deployment's own key.** Falling back would silently bill the operator
  instead of honoring the repo admin's explicit choice - the opposite of
  what BYOK is for. `ProviderCredentialResolutionError` (new, in
  `packages/core/src/llm/credential-resolution.ts`) is the distinct
  signal; "no credential configured anywhere for this provider" (not an
  error - just unconfigured) still falls back with a warning.
- **`MODEL_CREDENTIALS_MASTER_KEYS` is optional at the app-env level in
  both `apps/worker` and `apps/web`**, even though Phase 11's own
  `crypto/env.ts` schema requires it - a deployment that has never
  configured BYOK must still boot (confirmed true today: the project's own
  root `.env` doesn't set it). The same value must be set in both apps'
  env if BYOK is used at all; a mismatch makes every repo-level credential
  permanently undecryptable, not just newly-written ones.
- **Model provider precedence gained a middle tier:** `.coderexic.yml`'s
  `model:` (Phase 10, untrusted repo input) still wins, then
  `repository_settings.model_provider` (new - the settings page's write,
  DB-validated by a new CHECK constraint), then the deployment's fixed
  default. `repository_settings.model_name` is stored but deliberately
  *not* wired to model selection yet - see ROADMAP.md's "what's still
  open" for why applying a free-text model name against a system-tier
  credential would be a privilege-widening bug, not a feature.
- **One settings page, not four.** The roadmap's original page list
  (Settings, Model settings, Review rules, Usage) collapses to one route:
  "model settings" and "usage" are real, DB-backed sections of it, and
  "review rules" turned out to mean the `ignore_patterns` table (which had
  schema since Phase 5 but no writer until this phase) rather than an
  editor for `.coderexic.yml`/the rules file itself - that file is
  version-controlled in the repository on purpose (§16), so a web form
  editing it would fight the source of truth instead of complementing it.

## 5. GitHub integration
Wrap GitHub in a `GitHubClient` abstraction. Nothing else in the app depends
on Octokit request details.
```ts
interface GitHubClient {
  getPullRequest(...): Promise<PullRequest>;
  getPullRequestFiles(...): Promise<PRFile[]>;
  getFileContent(...): Promise<string>;
  getRepositoryTree(...): Promise<TreeEntry[]>;
  createReview(...): Promise<void>;
  createIssueComment(...): Promise<void>;
}
```

## 6. Webhook flow
`POST /webhooks/github`:
1. Read the raw body.
2. Verify `X-Hub-Signature-256`.
3. Parse the event and check its type and action.
4. Resolve the installation.
5. Build the idempotency key: `installation_id + repository_id + event_id`.
6. Persist the job.
7. Return 2xx fast.

Execution is also deduplicated on `repository + pull_request + head_sha`.

## 7. Review pipeline
1. Take a `ReviewJob` and load the PR.
2. Load the repo config and the changed files.
3. Filter out ignored paths.
4. Resolve the graph.
5. Build the `AgentContext` and run the agent.
6. Validate the `ReviewFinding[]`.
7. Apply the severity filter.
8. Map findings to GitHub lines.
9. Create the GitHub review.
10. Persist the results.

## 8. Dependency graph
**Forward:** `A -> [B, C]`. **Reverse:** `B -> [A]`, `C -> [A]`.

Each edge row is `(repository_id, source_path, target_path, commit_sha)`.
Indexes on `(repository_id, source_path)` and `(repository_id, target_path)`
make `get_imports(A)` and `get_dependents(B)` cheap.

## 9. Indexing
**Initial (on install):**
1. Read the tree at the default branch.
2. Filter to supported files and fetch their contents.
3. Parse imports and resolve the local ones.
4. Store the edges.
5. Mark the repo indexed at that SHA.

**Incremental (on push):**
1. Diff the old SHA against the new one.
2. For each changed source file, drop its outgoing edges and re-parse it.
3. Update the affected reverse relations.
4. Update the indexed SHA.

If incremental indexing gets unreliable, do a full rebuild. Correctness
beats optimization.

## 10. Import resolution
- **JS/TS:**
  - relative imports
  - `.js` resolving to `.ts`/`.tsx`
  - extensionless imports
  - `index.ts`
  - aliases such as `@/` and `~/`
  - packages excluded from the graph
- **Python:** relative imports, module path mapping, and `__init__` packages.
- **Go:** local module packages. Standard and external packages are ignored
  unless they're in the repo.
- **Rust:** `crate::`, `mod`, and local module relations.
- **Java:** package and import relations.
- **Ruby:** `require` and `require_relative`.

Each import is classified as a **resolved local dependency**, an **external
dependency**, or **unresolved**.

## 11. Context selection
Never give the agent the whole repo. Start with the changed files, their
direct imports and their direct dependents, then let the agent explore.

Future ranking score:
```text
score = direct_dependency_weight + direct_dependent_weight
      + changed_file_proximity + symbol_match + test_relationship + path_relevance
```

## 12. LLM adapters
```ts
interface AgentModel { chat(messages: AgentMessage[], tools: ToolDefinition[]): Promise<AgentResponse>; }
```
The adapters are OpenAI, Anthropic, Gemini and Ollama.

Provider-specific message and tool translation stays inside the adapters. The
agent logic never imports a provider SDK.

## 13. Security boundary
The riskiest boundary is **untrusted repo + untrusted repo instructions +
LLM**.

Repo files may never redefine:
- safety rules
- tool permissions
- filesystem boundaries
- network access
- secrets
- agent limits

Repo instructions are policy hints only.

## 14. Tool security
- **`get_file_content`:**
  - The path must be repo-relative, with no `..` and no absolute paths.
  - The file must be in the target repo.
  - It is fetched at the intended commit or ref.
- **`get_imports` and `get_dependents`:** the repo ID is fixed by
  server-side context, and the path is validated. A user or the model never
  supplies a repo identifier.
- **`submit_review`:**
  - Schema-validated.
  - The file must be one of the changed files.
  - The line must be in a reviewable part of the diff.
  - The severity must be allowed.
  - Suggested code has a size limit.

## 15. Comment publishing
The agent emits internal `ReviewFinding`s. A separate publisher maps them to
`GitHubReviewComment`s, so the LLM never controls GitHub API payloads.

## 16. Configuration
Layers, each overriding the one before:
1. App defaults.
2. User config.
3. Repo `.verix.yml` (or `.coderexic.yml`).
4. The repo rules file.

Validate against a schema. Never use a home-grown YAML parser.

## 17. Failure handling
- **GitHub:**
  - Retry transient errors with exponential backoff.
  - Never retry permanent 4xx errors indefinitely.
- **Model:**
  - Retry a limited number of times.
  - Then mark the review `FAILED_MODEL`.
- **Agent timeout:**
  - Mark the review `TIMED_OUT`.
  - Don't publish partial findings unless that's explicitly supported.
- **Index failure:**
  - The review may fall back to diff-only.
  - That fallback status must be visible.

## 18. State machines
- **Review job:** `PENDING -> RUNNING`, then `SUCCEEDED`, `FAILED`, `TIMED_OUT`
  or `CANCELLED`.
- **Index job:** `PENDING -> INDEXING`, then `READY` or `FAILED`.

## 19. Deployment
The initial chain is Internet -> Nginx/LB -> API container -> Postgres ->
Redis/Queue -> Worker container. Object storage is optional, for large
artifacts and logs later. Docker Compose is enough early on; Kubernetes
isn't needed.

## 20. Scaling path
1. One each of API, worker, Postgres and Redis.
2. Multiple workers.
3. Separate indexing workers, review workers and webhook API.
4. Multi-region or enterprise.

Don't start at stage 4.

## 21. Initial technology
- **Backend:** TypeScript and Node.js, Fastify (or Express), Octokit,
  PostgreSQL, Redis + BullMQ, pnpm, Zod, Vitest, Docker, and
  OpenTelemetry-compatible logs and metrics.
- **Frontend:** Next.js, Tailwind and shadcn/ui.

Use a modular monolith first.

**Decisions:** Fastify, Drizzle ORM with drizzle-kit, pino logging, Node 24,
and TypeScript ~6.0.

## 22. Rules for adding a dependency
Before adding any new technology, answer:
1. What problem does it solve?
2. Why can't the existing stack solve it?
3. What operational cost does it add?
4. What's the impact on local dev?
5. What's the impact on production?
6. Can we remove it later?

Never add something just because it's fashionable.
