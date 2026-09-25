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
  `onPush` - never from installation/repos-added events, since resolving a
  default-branch commit sha there would need a GitHub API call, which
  webhook handlers must never make. It's also self-healing:
  `processReviewJob` (`apps/worker/src/review/pipeline.ts`) checks
  `repository.indexedSha !== pr.baseSha` and, if so, fire-and-forget kicks
  off an index run itself (`createIndexRun` + its normal dedup, enqueued
  onto the same `index-runs` queue), so a repo nobody has pushed to since
  install doesn't stay un-indexed forever. This never blocks or fails the
  review - failures are logged and swallowed. Per-language import
  extraction is regex-based/heuristic except TypeScript/JavaScript, which
  uses the real `ts.preProcessFile` compiler API; every extractor only
  emits an edge for a path that actually exists in the indexed file set,
  external packages/stdlib imports are dropped rather than stored.
  Indexing is incremental: `planIndex` diffs each file's current tree blob
  sha against the stored `indexed_files.sha`, and `replaceDependencyEdges`
  only touches the source paths re-parsed or removed in that run.
- The context engine (`packages/core/src/context/`) answers what a
  changed file imports, what depends on it, and which related tests exist
  (`buildReviewContext`, AI_AGENT_SPEC.md §18's tiers). Imports for a PR's
  changed files are re-extracted fresh from PR **head** content (the
  stored graph only reflects the indexed default branch, which has no
  entry for a PR's own new/edited imports); dependents - including for a
  PR's removed/renamed-old paths - come from the stored graph via batched
  `getForwardEdgesForPaths`/`getReverseEdgesForPaths`, never from
  per-path queries. Nothing calls `buildReviewContext` from the review
  pipeline yet; that wiring belongs to the agent loop (Phase 8/9), once
  there's an actual request payload to put the related files into.
  `ReviewContextCache` (`context/cache.ts`) is scoped to one review job.
  `context/fetch-content.ts`'s `fetchCachedContent` wraps every
  `GitHubClient.getFileContent` call made through it: a transient error
  (network, rate limit) is never cached and is reported as retryable; a
  permanent per-file problem (`GitHubFileError` - binary, over the size
  limit, a directory) is cached and reported once with no retry
  suggestion; only a genuine 404 is cached as "no content". An earlier
  version of this code caught every error the same way and cached all of
  them as "file missing" - one transient GitHub 5xx would silently starve
  the rest of that review.
- The agent tool executor (`packages/core/src/agent/executor.ts`'s
  `AgentToolExecutor`) implements AI_AGENT_SPEC.md §5's four tools
  (`get_file_content`, `get_imports`, `get_dependents`, `submit_review`)
  against one review's fixed repo/commit - the model only ever supplies a
  path, never a repository. It reuses `fetchCachedContent` for GitHub-fetch
  dedup, but keeps a separate `deliveredFiles` set for "already shown to
  the model" (§10's duplicate-call prevention): a changed file's content
  the context engine fetched for import extraction has never reached the
  model, so a first real `get_file_content` call for it must not be
  refused as a duplicate. `deliveredFiles` is only updated once a fetch
  actually completes, so a call that hits `toolTimeoutMs` and times out
  can't poison a later, successful retry with a false "already fetched".
  `get_imports`/`get_dependents` results are cached under
  `imports:${path}`/`dependents:${path}` query keys on the same cache
  (§10's "cache identical graph queries" half, distinct from the file-dedup
  half). `get_file_content`'s result is wrapped in a `<<<FILE`/`FILE>>>`
  fence (escaping any pre-existing occurrence of that sequence in the file,
  same trick as `llm/prompt.ts`'s rules fence) - content is truncated to
  `maxToolResultBytes` **before** fencing, not after, so a result over the
  limit still closes its fence rather than reaching the model unclosed.
- The agent loop (`packages/core/src/agent/loop.ts`'s `runAgentLoop`)
  drives `AgentToolExecutor` through AI_AGENT_SPEC.md §9's turns:
  `chat` -> if `submit_review` succeeded, stop; if no tool calls, try
  fallback-parsing the text as a review (§9, not §15 - see below) or
  terminate; otherwise answer *every* tool call in the batch, even one
  after a `submit_review` in the same turn, before checking whether any
  of them finished the run. Past `maxFileFetches`, a `get_file_content`
  call is rejected with a "submit now" message without ever reaching the
  executor - ending the run outright there would throw away the whole
  investigation - and `MAX_FILE_FETCHES` only becomes the termination
  reason if the run then ends without a submission. The wall-clock
  deadline and any caller-supplied `AbortSignal` are combined via
  `AbortSignal.any`; either one aborting maps to `TIMEOUT`, since the
  `agent_runs.termination_reason` enum (DATA_MODEL.md) has no separate
  "cancelled" value.
- `AgentAdapter`/`ToolExecutor` (`agent/types.ts`) are interfaces, not the
  concrete `AgentToolExecutor` class, specifically so `runAgentLoop` can be
  unit-tested with a fake of each and no database or provider SDK at all.
  A `ToolCall.id` is always present even though Gemini's function calls
  don't carry one - its adapter (`llm/gemini-agent.ts`) synthesizes one.
- `db/store/agent-runs.ts` persists one `agent_runs` row per loop and one
  `agent_tool_calls` row per call (metadata only - never the tool result
  text or fetched file content, DATA_MODEL.md). `runAgentBranch`
  (`apps/worker/src/review/pipeline.ts`) wraps the whole loop in a
  try/catch: any crash - a malformed tool call, a DB error mid-loop -
  finalizes both rows as `FAILED` rather than leaving them stuck
  `RUNNING` forever. This includes storing `{}` for a tool call with no
  `args` at all (Gemini can omit it), since `arguments_json` is a NOT
  NULL jsonb column and a bare insert of `undefined` would otherwise
  crash the whole review.
- The agent loop is wired into the real worker behind `AGENT_LOOP_ENABLED`
  (`apps/worker/src/env.ts`), **off by default**. It's parsed as an
  explicit `z.enum(['true', 'false'])` + transform, not
  `z.coerce.boolean()`, which would treat the *string* `"false"` as
  truthy. With the flag off, `processReviewJob` runs exactly the Phase
  4 one-shot path it always has; AI_AGENT_SPEC.md §15's "fallback mode"
  is not met by that path, since it never calls the context engine for
  preselected related content - don't conflate the two. `maxReviewSeconds`
  (repo-configurable, default 60, sized for one model call) gets a
  `Math.max(configured, 180)` floor on the agent path, since ten turns
  plus tool-call time can exceed the one-shot default easily.
- Four providers exist behind `AgentAdapter`/`ReviewModel`: Gemini
  (`llm/gemini.ts`/`gemini-agent.ts`), OpenAI and Groq (both
  `llm/openai-compatible.ts` - Groq's API is OpenAI-compatible, so
  `llm/groq.ts` is a thin wrapper around the same adapter OpenAI uses,
  differing only in `baseUrl`/default model), and Anthropic
  (`llm/anthropic.ts`, raw HTTP against the Messages API). Every raw-HTTP
  adapter shares one retry/timeout policy (`llm/http-policy.ts`'s
  `postJsonWithRetry`): retries on 429/503 (Anthropic also 529), a
  *per-attempt* timeout (default 60s, `DEFAULT_REQUEST_TIMEOUT_MS`,
  constructed fresh inside the retry loop, not once outside it - see
  ROADMAP.md Phase 10) combined with the caller's `AbortSignal` via
  `AbortSignal.any`, and a thrown `ModelHttpError` that includes only the
  HTTP status - never the response body, which can echo request secrets
  back (a provider's 401 body fragmenting the key that was sent).
- `claude-sonnet-5`/`claude-opus-5` (Anthropic's default, `DEFAULT_ANTHROPIC_MODEL`
  is `claude-opus-5` per the `claude-api` skill - never downgrade the
  default without being told to) run adaptive thinking whenever a request
  omits `thinking`, which `llm/anthropic.ts` always does. Its `providerData`
  therefore carries the raw response `content` array (echoed back verbatim
  for a later turn, Gemini's pattern), so a `thinking` block is never
  silently dropped, and it never sends `tool_choice` at all - forcing a
  tool is documented as incompatible with extended thinking on these
  models, so the one-shot composer's text-parsing fallback carries that
  case instead.
- Every provider except Gemini gets its one-shot `ReviewModel` (the
  fallback path when `AGENT_LOOP_ENABLED` is off) for free via
  `llm/one-shot-from-agent.ts`'s `createOneShotFromAgentAdapter`: one
  `chat()` call with only the `submit_review` tool and `AgentChatOptions`'
  new `toolChoice` forcing it, instead of a separate one-shot
  request-builder per provider. A provider that ignores `toolChoice` (or,
  like Anthropic, never receives it) falls back to parsing the response as
  plain text, the same fallback-parsing path `agent/loop.ts` already has.
- `llm/provider-factory.ts`'s `buildProviderRegistry` only creates an
  entry for a provider whose API key is actually set
  (`apps/worker/src/env.ts`'s `workerEnvSchema` makes every per-provider
  key optional and uses `superRefine` to require only the one
  `MODEL_PROVIDER` selects - a Groq-only deployment must boot without ever
  setting `GEMINI_API_KEY`). `ReviewPipelineDeps.providers` lets a repo's
  `.coderexic.yml` `model:` field (an enum from
  `config/schema.ts`'s `SUPPORTED_MODEL_PROVIDERS` - never a base URL or
  model string, since that's untrusted repo input and an arbitrary URL
  would be an SSRF) pick a *different configured* provider per review,
  falling back to the deployment default with a config warning when the
  named provider has no key. That per-repo choice can only swap **which**
  adapter runs within whichever mode (one-shot or agent-loop) this
  deployment is already in - it must never itself turn the agent loop on
  when `AGENT_LOOP_ENABLED` is off; `apps/worker/src/review/pipeline.ts`
  gates `resolvedAgentAdapter` on `deps.agentAdapter`'s presence first,
  precisely because an earlier version let any configured provider's
  `agentAdapter` silently enable agent mode regardless of the flag.
- `checkProviderHealth` (`llm/provider-factory.ts`) is a single no-token
  models-list `GET` per provider, run once at worker startup for the
  selected default (logs a warning on failure, never crashes startup), and
  `validateModelCredential` reuses it for BYOK key validation - a 401/403
  there means the key itself is bad, not a transient outage.
- BYOK (`packages/core/src/crypto/`, `db/store/model-credentials.ts`) is
  DB-and-crypto-layer only this phase - no API endpoint, since there's no
  web app or auth flow yet to expose it through; exercised directly by
  tests. `encryptCredential`/`decryptCredential`
  (`crypto/credential-crypto.ts`) are AES-256-GCM with a random 12-byte IV
  per call and the ciphertext bound to its row via AAD
  (`user_id|repository_id|provider`), so a ciphertext copied into a
  different row fails to decrypt instead of silently decrypting wrong.
  Master keys are a version -> 32-byte-key map from
  `MODEL_CREDENTIALS_MASTER_KEYS` (never the DB), validated at load time
  (`crypto/env.ts`'s `loadModelCredentialsConfig`, which also confirms the
  configured `MODEL_CREDENTIALS_KEY_VERSION` actually has a key). Only
  `db/store/model-credentials.ts`'s `resolveDecryptedCredential` ever
  returns plaintext - every CRUD function returns `ModelCredentialMetadata`
  (no `encryptedSecret` field), and `encryptedSecret`/`plaintext`/`masterKey`
  are in the logger's `SECRET_KEYS` so they're redacted at any object depth.
  `model_credentials` has two partial unique indexes: one keyed on
  `(user_id, repository_id, provider)` with `NULLS NOT DISTINCT` (hand-added
  to the generated migration SQL - drizzle-kit's `uniqueIndex` builder has
  no API for it) for user-scoped credentials, and one keyed on
  `(repository_id, provider) WHERE repository_id IS NOT NULL` for
  repo-scoped ones - a repo credential is shared by the whole repo
  regardless of which user added it, so its exclusivity can't be keyed on
  `user_id`. `llm/credential-resolution.ts`'s `resolveProviderEntry`
  composes the DB's repo/user tiers with the system tier
  (`buildProviderRegistry`) into one `ProviderEntry`; it is not wired into
  `apps/worker/src/review/pipeline.ts` - a review job has no
  session-derived user, so using the PR author's key would bill whoever
  opened the PR, including fork contributors.
- Manual re-review (Phase 12): a PR comment `/review review`
  (`github/commands.ts`'s `hasReviewCommand`) from an `OWNER`/`MEMBER`/
  `COLLABORATOR` (`comment.author_association`; missing or `Bot` = unauthorized)
  creates a `manual` review job, handled entirely inside
  `apps/api/src/webhooks/handlers.ts`'s `onIssueComment` - webhook handlers
  still make no GitHub API calls, so the job's `head_sha` starts as
  `ZERO_SHA` (`db/store/review-jobs.ts`, an all-zero 40-hex placeholder) and
  the worker (`apps/worker/src/review/pipeline.ts`) overwrites it via
  `updateReviewJobHeadSha` once it actually fetches the PR. A manual job
  skips the superseded/draft checks an automatic job goes through - an
  explicit command beats the automatic-trigger policy - but still gets
  checked against `findActiveReviewJob` twice: once at the webhook handler
  (no `headSha`, catches a second command while one's already in flight)
  and once in the pipeline after the real head sha is known (`headSha` +
  `excludeId`, catches a manual job racing an automatic job to the same
  commit). Rejections (unauthorized commenter, already in flight, PR
  closed) are **silent** - a deliberate product decision made this phase
  (not a permission constraint: GitHub's docs list "create an issue
  comment" under *both* the Issues and Pull requests permission sections,
  so the existing `Pull requests: write` is actually enough to post a plain
  comment on a PR). A successful manual review's only status report is the
  review itself, posted the same way an automatic review's is; posting an
  ack/rejection comment too is a small, cheap follow-up if wanted later.
- `apps/web` (Phase 13a, Next.js App Router) is a peer of `apps/api`/
  `apps/worker`, not a client of `apps/api` - it imports `packages/core`
  directly for DB access (ARCHITECTURE §4's Phase 13a decisions). Two
  monorepo-integration quirks worth knowing before touching it: (1) `next
  build` needs `@coderexic/core` **built** (`pnpm --filter @coderexic/core
  build`) - Next's bundler resolves the package via its `exports` map's
  `default` condition (built `dist/`) regardless of tsconfig settings,
  unlike `apps/api`/`apps/worker`'s `tsx --conditions=source`; `pnpm -r
  build` already handles the ordering. `pnpm typecheck`/`pnpm lint` need
  no prior build, though - `apps/web/tsconfig.json`'s `"customConditions":
  ["source"]` (matching `apps/api`/`apps/worker`) makes `tsc`/ESLint
  resolve straight to `packages/core/src`. (2) `apps/web`'s own local
  imports (e.g. `from './env'`) must **not** carry a `.js` extension -
  Turbopack doesn't resolve a `.js` specifier to a sibling `.ts` file the
  way `tsc`'s `moduleResolution: "bundler"` does, unlike every other
  `.js`-suffixed import elsewhere in the monorepo (which stays that way
  under `NodeNext`). `packages/core/src/db/migrate.ts`'s
  `MIGRATIONS_FOLDER` also had to stop using
  `new URL('../../drizzle', import.meta.url)` (Turbopack's asset-reference
  scanner tries to bundle whatever that resolves to, even through
  `serverExternalPackages`, even for code `apps/web` never calls) in favor
  of `resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle')` -
  same result, invisible to that scanner.
- Auth (`apps/web/src/auth.ts`): `next-auth` v4, JWT session strategy, no
  DB adapter - `db/store/users.ts`'s `upsertUser` is called by hand from
  the `jwt` callback, matched on `githubUserId` (survives a GitHub login
  rename). The `GithubProvider` is configured against the **GitHub App's
  own** OAuth client (App settings, not a separate OAuth App) - that's
  what makes the resulting user token valid for
  `GET /user/installations`. The GitHub access token is kept on the JWT
  only (`token.githubAccessToken`) and never copied onto `session` in the
  `session` callback, since anything on `session` is readable by client
  JS via `/api/auth/session`; it's decoded server-side only via
  `getToken` in a Route Handler (`apps/web/src/session.ts`'s
  `getAccessToken`, shared by every API route that needs it), which is why
  every authorized-data page (dashboard, repository, review) fetches from a
  small client component rather than rendering in the page's Server
  Component - `getToken` needs a real `NextRequest`, which a Server
  Component doesn't have without a hack.
- `packages/core/src/github/user-access.ts`'s `listAuthorizedRepositories`
  is the authorization check behind the repo list: it calls GitHub's API
  with the signed-in user's own token (never an installation token, never
  trusts a client-supplied installation id or an `owner_login` match), and
  cross-checks every result against this app's own DB
  (`removed_at is null`) before returning it - GitHub being right isn't
  enough on its own (PRODUCT_SPEC §17.10). Throws a typed
  `GitHubUserAccessError` (carries the HTTP status) rather than a bare
  `Error`, so a caller can tell a genuinely expired/revoked token (a
  GitHub App user token expires after 8h by default) from any other
  failure - `app/api/repos/route.ts` maps a 401 from it to `401 {error:
  'sign in again'}` rather than a 500. Token refresh isn't implemented;
  see ROADMAP.md Phase 13a.
- `NEXTAUTH_URL` is a **required** env var (`webEnvSchema`), not left to
  next-auth's own default - that default is `http://localhost:3000`,
  which collides with `apps/api`'s default port and silently sends the
  OAuth callback to the wrong place. `apps/web`'s dev/start scripts pin a
  fixed port (`:3001`) rather than relying on `next dev`'s default, to
  match.
- **Every route that takes a repository or review id in its URL
  re-derives authorization from GitHub, never trusts the id** -
  `packages/core/src/github/user-access.ts`'s `findAuthorizedRepository`
  and `findAuthorizedReviewJob`, both integration-tested including the
  cross-repo case (a review job id from a repository the caller isn't
  authorized for must never resolve, even if the caller is legitimately
  authorized for some *other* repository). Repositories are routed by
  `repositoryId` (the app's own UUID) rather than `owner/name` -
  `repositories.fullName` isn't unique and goes stale on a GitHub rename.
  A failed check is always a plain 404 (never 403), so existence never
  leaks.
- API routes map DB rows to explicit response shapes
  (`apps/web/src/dto.ts`'s `to*Dto` functions) rather than returning rows
  directly - a schema column added later can't leak to the client without
  a matching mapper change.
- Model-authored text (review summaries, finding descriptions) is always
  rendered as plain text (`whitespace-pre-wrap`), never markdown-to-HTML or
  `dangerouslySetInnerHTML` - it's untrusted the same way a repo's own
  instructions are (§13).
- Tailwind v4 (`@tailwindcss/postcss`) plus hand-authored, shadcn-style
  primitives in `apps/web/src/components/ui.tsx` (Tailwind utilities +
  `cva` variants + a `cn()` helper from `apps/web/src/lib/cn.ts`) - not the
  `shadcn` CLI's generated files. Confirmed by actually running
  `shadcn@latest init`: it needs Tailwind and an import alias already
  configured and does neither itself, and `apps/web` uses extension-less
  relative imports rather than a `@/*` alias, so adding one just for the
  CLI wasn't worth it for a handful of components.
- The GitHub App's install link (`apps/web/src/install-url.ts`) is built
  from a server-only `GITHUB_APP_SLUG` env var, not `NEXT_PUBLIC_*` -
  Next inlines `NEXT_PUBLIC_*` at `next build` time, so a build made
  before the var was set would bake in `undefined` for every deploy until
  the next rebuild. The install flow's return leg (a `setup_action`/
  `installation_id` query param GitHub may redirect back with) is never
  read or trusted - the dashboard just re-derives authorization from
  `listAuthorizedRepositories` on load, the same as any other visit.

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
