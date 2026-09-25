# Roadmap: Coderexic

**Every phase leaves the repo working.** Writing the code doesn't finish a
phase. A phase is done only when:
- the implementation exists
- tests exist and pass
- lint and typecheck pass
- the docs are updated
- the feature can actually be exercised

## Phase 0: Product and architecture
**Goal:** turn the idea into an executable engineering spec.
- [x] Product specification
- [x] Architecture
- [x] Data model
- [x] Agent specification
- [x] Roadmap
- [x] AGENTS.md
- [ ] Threat model
- [ ] Initial evaluation strategy

**Done when:** anyone can explain GitHub event → review job → repo context →
agent → findings → GitHub comments, without ambiguity.

## Phase 1: Repository foundation
**Goal:** a clean, production-oriented TypeScript repo.
- [x] pnpm setup
- [x] TypeScript strict mode
- [x] Workspace structure
- [x] Linting
- [x] Formatting
- [x] Vitest
- [x] Environment validation
- [x] Docker
- [x] PostgreSQL
- [x] Health endpoint
- [x] Structured logging
- [x] CI
- [x] README
- [x] AGENTS.md

**Done when:** `pnpm install`, `lint`, `typecheck`, `test` and `build` and
`docker compose up` all succeed.

## Phase 2: Database
**Goal:** persistent app state.
- [x] Migration system
- [x] users
- [x] installations
- [x] repositories
- [x] repository settings
- [x] dependency edges
- [x] indexed files
- [x] index runs
- [x] review jobs
- [x] reviews
- [x] findings
- [x] agent runs
- [x] tool calls
- [x] webhook events
- [x] audit events

**Tests:**
- [x] CRUD
- [x] Foreign keys
- [x] Uniqueness
- [x] Cascading behaviour
- [x] Transaction behaviour

## Phase 3: GitHub App
**Goal:** receive events from GitHub and act on them securely.
- [x] GitHub App configuration (verified live on a throwaway repo, 2026-09-24)
- [x] App authentication
- [x] Installation authentication
- [x] Webhook signature validation
- [x] Webhook parsing
- [x] Installation event
- [x] Pull request event
- [x] Push event
- [x] Issue comment event
- [x] PR metadata retrieval
- [x] PR file retrieval
- [x] File content retrieval
- [x] Review publishing

**Security:**
- [x] Private key protection
- [x] Least privilege
- [x] Event idempotency
- [x] Rate-limit handling

## Phase 4: Basic diff reviewer
**Goal:** the simplest useful product, before the agent exists: PR → diff →
LLM → structured findings → GitHub review.
- [x] LLM abstraction
- [x] First provider adapter: Gemini (the spec said OpenAI; Gemini is the project's first provider)
- [x] Structured review schema
- [x] Finding validator
- [x] Line mapping
- [x] Summary generation
- [x] GitHub inline comments
- [x] Fallback PR comment

**Done when:** opening a PR produces a real AI review. This proves the basic
loop.

## Phase 5: Repository configuration
**Goal:** repos control how they're reviewed.
- [x] VERIX.md-compatible loader (plus CODEREXIC.md, ranked first)
- [x] Fallback rules files (CODEREXIC.md, VERIX.md, .verix.md, CLAUDE.md, AGENTS.md, .cursorrules)
- [x] .verix.yml-compatible config (plus .coderexic.yml, ranked first)
- [x] Ignore patterns (DB `ignore_patterns` rows + yml `ignore`, combined;
      applied both to file selection and to findings before placement)
- [x] Minimum severity
- [x] Language hint (passed into the review prompt)
- [x] Model override (validated against supported providers - Gemini only
      today; an unsupported value is dropped with a warning, not an error.
      A real provider switch arrives with Phase 10's provider factory.)
- [x] Max agent files (`max_files`, parsed and clamped; no consumer until
      Phase 8's tool executor)
- [x] Max depth (`depth`, parsed and clamped; no consumer until Phase 9's
      agent loop)

**Security:**
- [x] Rules treated as untrusted input (fenced in the prompt, system prompt
      states it can never override instructions; fence delimiters in the
      content itself are neutralized so it can't forge its own close)
- [x] Rules can't override system security (same fencing; config numeric
      fields are clamped to system-wide caps, never trusted verbatim)

## Phase 6: Dependency graph
**Goal:** understand how the repo's files relate.
- [x] Repository tree crawler - `buildRepositoryIndex` walks the recursive git tree via `GitHubClient.getRepositoryTree`, capped at `DEFAULT_MAX_FILES=3000` with a `truncated` flag surfaced rather than silently dropped
- [x] Supported-extension detection - `graph/languages.ts`'s `LANGUAGE_BY_EXTENSION`/`isSupportedPath`; unsupported files are counted as seen but never fetched or parsed
- [x] TypeScript/JavaScript parser - `ts.preProcessFile` (real TS compiler API, not a hand-rolled regex) captures ES imports, `export ... from`, dynamic `import()`, and CommonJS `require()` in one pass
- [x] Python parser - regex-based; `import x.y`, `from x.y import a, b`, and relative `from .[.]* import a, b` (each imported name tried as a submodule)
- [x] Go parser - regex-based; only imports under the repo's own `go.mod` module prefix are resolved (directory-suffix heuristic, marked `resolved: false`), everything else (stdlib/third-party) dropped
- [x] Rust parser - regex-based; `mod foo;` declarations only, resolved via the `mod.rs`/`lib.rs`/`main.rs` filename convention
- [x] Java parser - regex-based; resolves against `src/main/java|src/test/java|src`, static imports try both the full path and the member-stripped path, wildcard imports dropped
- [x] Ruby parser - regex-based; `require_relative` (directory-relative) and `require` (lib/-rooted; external gems dropped)
- [x] Local import resolver - `resolveAgainstFiles` (extension/index-file candidate matching against the real file set); every extractor only emits an edge for a file that actually exists in the tree
- [x] Alias resolver - `graph/tsconfig.ts` parses `tsconfig.json` (via `ts.parseConfigFileTextToJson`, JSONC-tolerant) for `baseUrl`/`paths`; `extends` chains are an explicit known limitation (would require fetching an arbitrary chain of other repo files)
- [x] Forward graph - `getForwardEdges`
- [x] Reverse graph - `getReverseEdges`
- [x] DB persistence - `dependency_edges`/`indexed_files`/`index_runs` (already existed from the Phase 2 migration; no new migration needed for Phase 6)
- [x] Graph indexing - dedicated `index-runs` BullMQ queue + worker (mirrors the review-job queue's idempotency/claim/stale-sweep pattern exactly), triggered from `onPush` with zero extra GitHub calls since the commit sha is already in the webhook payload
- [x] Incremental update - `planIndex` diffs each file's current tree blob `sha` against the stored `indexed_files.sha`; only new-or-changed files are re-fetched/re-parsed, and `replaceDependencyEdges` only touches the source paths that were actually re-parsed or removed in that run

**Fixture repos covering:**
- [x] Direct imports
- [x] Indirect imports
- [x] Aliases
- [x] Index files
- [x] Renamed files - falls out naturally as a remove (old path) + add (new path, different blob sha)
- [x] Deleted files
- [x] Circular dependencies
- [x] Unresolved imports
- [x] External packages

Proven live end-to-end against the real GitHub App and the real installed
repository (`PranavTJ-05/throwaway-test-repo`, a Next.js app) via
`pnpm graph:index --repo owner/name`: 23 files seen, 7 supported source
files parsed, correctly extracting a real `app/layout.tsx -> app/globals.css`
import edge - in addition to 264 unit + integration tests (181 unit, 83
integration, including a real-Redis `createIndexWorker` round trip). (An
earlier run against the same repo before it had real source content only
exercised the tree-fetch/persistence plumbing, not parsing - correcting
that here.)

## Phase 7: Context engine
**Goal:** give reviews relevant context.
- [x] Direct import retrieval - `buildReviewContext` re-extracts a PR's
      changed files' imports from their *head* content (the stored graph
      only reflects the indexed default branch, which doesn't see a PR's own
      new/edited imports), reusing the indexer's own `extractorFor`,
      `loadTsAliases`/`loadGoModule` manifest loading, and `allFiles` set.
- [x] Dependent retrieval - direct dependents (and a related-tests split of
      them, via a language-agnostic `isTestFile` heuristic) come from the
      stored graph via batched `getReverseEdgesForPaths`, including for a
      PR's *removed* paths, so a deletion's dependents still surface even
      though the deleted file itself is excluded from the result. An
      optional second hop (`depth >= 2`) adds one more level via
      `getForwardEdgesForPaths`/`getReverseEdgesForPaths` on the tier-1/2/3
      frontier; `depth` is clamped 1-5 but only ever does one extra hop, so
      3-5 behave the same as 2.
- [x] Changed-file filtering - changed, removed, and `ignoreGlobs`-matched
      paths (reusing `diff-filter.ts`'s `matchesGlob`) are excluded from
      every tier.
- [x] Context ranking - `context/rank.ts`: four tiers (`direct_import` >
      `direct_dependent` > `related_test` > `second_degree`), deduped to
      each path's best tier, sorted by tier then path.
- [x] Context token budget - `context/budget.ts`: `estimateTokens`,
      `TokenBudget`, `truncateToTokens` (a chars/4 heuristic, deliberately
      not a real tokenizer - see ARCHITECTURE.md §22 dependency-vetting
      note in the file). Built and unit-tested, but not yet called from
      `buildReviewContext` itself; its consumer is Phase 8/9's prompt
      assembly, once there's an actual prompt payload to budget.
- [x] File size limits - a related file over 256 KiB (from the indexed
      `sizeBytes` column) is dropped from the result rather than handed to
      the model, with a note explaining the exclusion.
- [x] Context cache - `context/cache.ts`'s `ReviewContextCache` dedupes the
      engine's own PR-head file fetches within one review, and
      `context/fetch-content.ts`'s `fetchCachedContent` (shared with Phase
      8's tool executor) never caches a transient fetch error as "file
      missing" - only a real 404 or a permanent per-file problem (binary,
      too large, a directory). Phase 8's `AgentToolExecutor` now reuses this
      same cache for its own GitHub-fetch dedup, but keeps a separate
      `deliveredFiles` set for "already shown to the model": a changed
      file's content the engine fetched here for import extraction has
      never reached the model, so `get_file_content` must not refuse it as
      a duplicate the first time the model actually asks for it.

**Done when:** the engine can answer what a changed file depends on, what
depends on it, and which files to inspect. Done - verified by 3 unit test
files (rank/budget/cache, 16 tests) and a dedicated integration test file
(`tests/integration/context-engine.test.ts`, 7 tests against a real
Postgres graph) covering: degraded/not-ready, tier classification, ignored
paths (with a control run proving the exclusion came from the glob, not
from the extractor failing to resolve), depth 1 vs 2, deleted-file
dependents, size-limit exclusion, and `maxFiles` truncation. `buildReviewContext`
is not yet called by `processReviewJob`; per the checklist above, Phase 7's
scope is the engine itself; wiring it into a request the review pipeline
actually assembles is Phase 8/9's job (the agent loop that decides what
context it needs). No live proof against a real repo for this phase -
verified by integration tests only.

## Phase 8: Agent tools
**Goal:** make the reviewer agentic.

**Tools:**
- [x] get_file_content - reads the PR head commit, fenced with a
      `<<<FILE`/`FILE>>>` delimiter (escaping any pre-existing occurrence of
      that sequence in the file itself, the same trick `llm/prompt.ts` uses
      for repo rules) so fetched content can never forge its own closing
      delimiter and read as instructions instead of data.
- [x] get_imports - re-extracts imports from the requested file's PR-head
      content (same extractor/manifest logic as the context engine and the
      indexer), not the stored graph, so it's accurate for a file the PR
      itself just edited.
- [x] get_dependents - reads the stored reverse dependency graph.
- [x] submit_review - schema-validates against the existing
      `modelReviewOutputSchema` (Phase 4), rejects a finding on a file
      outside the PR's changed files, and returns the validated payload
      (`ToolExecutionResult.output`) alongside `done: true`.

**Tasks:**
- [x] Tool schemas - `agent/tools.ts`'s `TOOL_DEFINITIONS`, provider-neutral
      JSON Schema (reuses the DB's `SEVERITIES`/`FIX_TYPES` enums).
- [x] Tool executor - `agent/executor.ts`'s `AgentToolExecutor`, one
      instance per review, repo/commit-scoped by construction.
- [x] Argument validation - zod per tool (`{path}` for three of the four,
      `modelReviewOutputSchema` for `submit_review`); accepts either a
      parsed object or a raw JSON string (some adapters hand tool arguments
      over as text).
- [x] Repo scoping - `repositoryId`/`ref`/`headSha` are fixed at
      construction; the model only ever supplies a path.
- [x] Path validation - `agent/path-validation.ts`: no absolute paths, no
      `..` segment.
- [x] Duplicate-call prevention - `deliveredFiles` (a get_file_content
      repeat gets `ALREADY_FETCHED_MESSAGE`, only set once a fetch actually
      completes, so a timed-out call can't poison a later retry) plus
      `ReviewContextCache`-backed caching of `get_imports`/`get_dependents`
      query results (AI_AGENT_SPEC.md §10's "cache identical graph
      queries").
- [x] Tool timeouts - each tool call races a configurable timer
      (`toolTimeoutMs`, default 15s) and returns a "timed out, you may
      retry" result rather than hanging. This only abandons the *wait*:
      `GitHubClient` takes no `AbortSignal`, so the underlying HTTP request
      itself isn't cancelled and its result is still cached if it later
      succeeds.
- [x] Result size limits - `maxToolResultBytes` (default 32 KiB). File
      content is truncated *before* fencing, not after, so a result over the
      limit still closes its `FILE>>>` delimiter rather than leaving the
      model with an unclosed fence.

A permanent per-file problem (binary, over the size limit, a directory -
`GitHubFileError`) is reported once as "unavailable" with no retry
suggestion and is cached, distinct from a transient error (network, rate
limit), which is never cached and is reported as retryable
(`context/fetch-content.ts`'s `fetchCachedContent`, shared with the context
engine - a gap fixed here that also applied to Phase 7's `buildReviewContext`,
which previously cached *any* fetch failure, including a transient one, as
"file missing" for the rest of the review).

ARCHITECTURE.md §14 also asks that a `submit_review` finding's line be "in
a reviewable part of the diff." The executor is repo/commit-scoped, not
diff-scoped - it has no patch context - so that check is deliberately left
to `review/findings.ts`'s existing `placeFindings`, which already demotes
an out-of-diff finding to summary-only downstream rather than rejecting it
here and forcing a retry.

**Done when:** the four tools work against a real review job's repo/commit
and enforce the security boundaries above. Nothing calls
`AgentToolExecutor` yet - wiring it into an actual tool-call loop is Phase
9's job. Verified by 2 unit test files (path-validation, tools; 6 tests) and
a dedicated integration test file (`tests/integration/agent-executor.test.ts`,
16 tests against a real Postgres graph) covering: fenced content and repeat-
fetch refusal, cache-vs-delivered independence, missing/invalid paths,
import extraction from PR head, stored-graph dependents and their query
caching, `submit_review` accept/off-path-reject/schema-reject, fence-safe
truncation, transient-vs-permanent fetch errors, timeout without poisoning a
retry, and JSON-string tool arguments. No live proof against a real repo for
this phase - verified by integration tests only.

## Phase 9: Agent loop
**Goal:** the model decides what context it needs.
- [x] System prompt - `agent/prompt.ts`'s `AGENT_SYSTEM_PROMPT` (AI_AGENT_SPEC.md
      §7, filled in with Phase 8's four tools) plus `buildAgentPrompt`, the
      loop's first user message: PR metadata, fenced repo rules (reusing
      `llm/prompt.ts`'s `escapeRulesFence`), the diff, and Phase 7's ranked
      related-file list as *paths and tiers only* - the agent fetches
      content itself, rather than the list being inlined for it.
- [x] Tool-call loop - `agent/loop.ts`'s `runAgentLoop`, following §9's
      pseudocode: `chat` -> if `submit_review` succeeded, stop; if no tool
      calls, attempt fallback parsing (below) or terminate; otherwise
      answer every tool call in the turn (even ones after a `submit_review`
      in the same batch) before checking whether any of them submitted.
- [x] Max turns - default 10, configurable. The loop's last turn appends an
      explicit "submit now" instruction before calling the model, so a run
      close to the limit doesn't waste it still investigating.
- [x] Max file fetches - default 12. Past the limit, `get_file_content` is
      rejected with a "stop investigating, submit now" message *without*
      dispatching to the executor, rather than ending the run outright -
      that would throw away the whole investigation. `MAX_FILE_FETCHES` is
      only recorded as the termination reason if the run then ends without
      a submission (a `MAX_TURNS`/`INVALID_OUTPUT` that happened to follow
      a limit hit is reclassified; a `TIMEOUT`/`MODEL_ERROR` is not, since
      those aren't really about the fetch limit).
- [x] Wall-clock timeout - `deadlineMs`, combined with any caller-supplied
      `AbortSignal` via `AbortSignal.any`. AI_AGENT_SPEC.md §14: "a timeout
      must never leave the review marked successful" - `agent_runs`/
      `reviews`/`review_jobs` all land on `TIMED_OUT`, never `SUCCEEDED`.
- [~] Cancellation - the loop accepts and checks an external `AbortSignal`
      (unit-tested), but nothing in the pipeline actually supplies one yet:
      neither `worker.stop()` nor a superseded PR aborts an in-flight run.
      That wiring is unbuilt.
- [x] Malformed tool-call handling - invalid JSON args, a bad/absent path,
      and unknown tool names are all rejected by the executor (Phase 8)
      without crashing the loop. A tool call with **no `args` at all**
      (Gemini can omit it) is stored as `{}` in `agent_tool_calls.arguments_json`
      (a NOT NULL jsonb column) rather than crashing the insert - a bug
      caught by the advisor after the first pass, since it would otherwise
      have left `reviews`/`agent_runs` rows stuck `RUNNING` forever.
      `runAgentBranch` also wraps its whole body in try/catch now, so *any*
      unexpected error (a DB error mid-loop, not just this one) finalizes
      both rows as `FAILED` instead of leaving them stuck.
- [x] Structured submission - `submit_review`'s validated `ModelReviewOutput`
      flows back through `ToolExecutionResult.output`, not just a done flag.
- [x] Fallback parsing - AI_AGENT_SPEC.md §9's fallback (distinct from §15's
      "fallback mode" below): a turn with no tool calls has its text
      stripped of a ```json fence and parsed, then routed through the same
      `submit_review` schema/changed-file validation as a real tool call.
      Failure - unparseable, or rejected by that validation - terminates
      the run immediately with `INVALID_OUTPUT`, per §9 ("otherwise
      terminate"), rather than giving the model another turn.
- [x] Agent run persistence - `db/store/agent-runs.ts`: `startReview` (the
      `reviews` row an agent run needs to exist before the loop finishes),
      `createAgentRun`, `recordAgentToolCall` (metadata only - never the
      tool result text or fetched file content, DATA_MODEL.md), and
      `completeAgentRun`. Not separately unit-tested; exercised through the
      pipeline integration tests below, which assert on the actual rows.

**Not done, despite being adjacent to this phase's scope:**
- AI_AGENT_SPEC.md §15's "fallback mode" (a one-shot prompt with
  *preselected* related context, for a provider that can't do tool
  calling) is **not** met by Phase 4's existing one-shot path: that path
  never calls the context engine at all. Phase 9's own fallback *parsing*
  (above) is a different thing - don't conflate the two.
- §17's context token budget: `context/budget.ts`'s `TokenBudget` and
  `truncateToTokens` still have no caller. Phase 7's ROADMAP entry said
  Phase 8/9 would consume them; neither did. Actually wiring them means
  budgeting the initial prompt and truncating tool results against what's
  left, which hasn't been built.
- A per-repo way to configure agent-loop limits (turns, file fetches,
  timeout) doesn't exist; only construction-time overrides for tests do.

**Wiring into the real worker (`apps/worker/src/index.ts`):** gated behind
a new `AGENT_LOOP_ENABLED` env var, **off by default** - the agent loop
makes far more model calls per review than the one-shot path, and this is
its first real-world exposure. `apps/worker/src/env.ts` parses it as an
explicit `'true'`/`'false'` enum, not `z.coerce.boolean()` (which would
treat the *string* `"false"` as truthy - a real bug caught by its own unit
test). With the flag off, `processReviewJob` behaves exactly as it did
before this phase. `maxReviewSeconds` (repo-configurable, default 60,
sized for one model call) gets a taller floor on the agent path -
`Math.max(configured, 180)` - since ten turns plus tool-call time can
easily exceed the one-shot default; a repo that explicitly configures
something larger than 180s still wins.

**Done when:** the agent goes diff → get_imports → get_dependents →
get_file_content → submit_review with no human intervention. Done, but
**only when `AGENT_LOOP_ENABLED=true`** - that's not the production default
yet. Verified by 3 new unit test files (loop, prompt, the Gemini agent
adapter's request/response translation; 26 tests) plus an env-parsing test
(4 tests) and a dedicated integration test file
(`tests/integration/agent-review-pipeline.test.ts`, 4 tests against a real
Postgres agent-run/tool-call trail) covering: the full scripted
diff→get_imports→get_dependents→get_file_content→submit_review path with
tool-call rows asserted in order, `MAX_TURNS` exhaustion, a malformed
(missing-`args`) tool call surviving instead of crashing the job, and a
real `TIMED_OUT` outcome across `review_jobs`/`reviews`/`agent_runs`.

**Live verification:** attempted against the real Gemini function-calling
API and the real installed `PranavTJ-05/throwaway-test-repo` (freshly
re-indexed: 23 files seen, 7 indexed, matching Phase 6/7's earlier live
runs). Turn 1 succeeded for real - the model called `get_file_content` on
`app/layout.tsx`, the executor fetched and fenced the real file content,
and the result round-tripped back to Gemini correctly. Turn 2 onward was
blocked by the API key's free-tier rate limit (repeated 429s that outlasted
several retries and waits, consistent with a daily quota rather than a
per-minute one) before it could exercise the later turns or the
final-turn/multi-tool-response translation live. The Gemini agent
adapter's request/response translation (tool declarations, multi-turn
history, batched `functionResponse` turns, the nullable-schema conversion)
is otherwise verified by unit tests against a fake `fetch` only, not a real
multi-turn conversation end to end.

## Phase 10: Multi-provider models
**Goal:** providers are interchangeable.
- [x] OpenAI - `llm/openai.ts`, on the shared `llm/openai-compatible.ts`
      adapter (see below).
- [x] Anthropic - `llm/anthropic.ts`, raw HTTP against the Messages API (no
      SDK, matching every other adapter here - ARCHITECTURE.md §22). Tool
      results for one assistant turn's `tool_use` blocks are batched into a
      single following `user` message (Anthropic's parallel-tool-use
      contract), the same way Gemini batches `functionResponse` parts. A
      `type: ['string','null']` schema field (`suggested_code`) becomes
      plain `'string'` - Anthropic has no `nullable` keyword, and the field
      is already outside `required`.
- [x] Gemini - unchanged from Phases 4/9, now one entry among several
      instead of the only one.
- [x] Groq - **added beyond the original checklist**, at the user's
      request (a free key was available for live verification). Groq's API
      is OpenAI-compatible, so `llm/groq.ts` is a ~30-line wrapper around
      the same `llm/openai-compatible.ts` adapter OpenAI uses - only
      `baseUrl`/default model differ.
- [ ] Ollama - **not built this phase.** No usable local instance was
      available (port 11434 empty, no `ollama` CLI; the only reachable
      Ollama was a *different* project's container with no tool-capable
      model pulled, and the user asked not to touch it). Adding it later is
      close to free: it's the same `llm/openai-compatible.ts` code path
      Groq already uses, pointed at Ollama's own OpenAI-compat endpoint.
- [x] Provider factory - `llm/provider-factory.ts`'s `buildProviderRegistry`:
      given whichever provider credentials a deployment actually has (each
      one optional), returns a `ReviewModel`/`AgentAdapter` pair per
      provider. Every provider *except* Gemini gets its one-shot
      `ReviewModel` for free via a new `llm/one-shot-from-agent.ts`, which
      composes one out of any `AgentAdapter`: a single `chat()` call with
      only the `submit_review` tool and a new `toolChoice` option forcing
      it (falling back to text-parsing if a provider ignores that) - so no
      provider needs its own separate one-shot request-building code, the
      way Gemini's dedicated `createGeminiAdapter` still has from Phase 4.
      Wired into `apps/worker/src/index.ts`: only providers with a key
      actually set get a registry entry, and a repo's `.coderexic.yml`
      `model:` field (an enum only - never a base URL or model string, since
      that's untrusted repo input and an arbitrary URL would be an SSRF)
      can pick among them per review, falling back to the deployment
      default with a config warning if it names one that isn't configured.
      A repo's provider choice can only swap *which* adapter runs within
      whichever mode (one-shot or agent-loop) this deployment is already
      in - it can never turn the agent loop on when `AGENT_LOOP_ENABLED` is
      off globally (a real bug during development: the first version let
      any configured provider's `agentAdapter` silently enable agent mode
      regardless of the flag - caught by the integration test below, which
      failed until the gate was fixed).
- [x] Provider health checks - `checkProviderHealth`: a no-token models-list
      GET per provider (`/models`, or Anthropic's `/v1/models`), run once at
      worker startup for the selected default provider. Logs a warning on
      failure; never crashes startup on a transient error. The same
      function doubles as Phase 11's "provider-specific credential
      validation" - a 401/403 there means the key itself is bad.
- [x] Timeout policy - `llm/http-policy.ts`'s `postJsonWithRetry`, shared by
      every raw-HTTP adapter (Gemini, OpenAI-compatible, Anthropic): a
      per-attempt `requestTimeoutMs` ceiling (default 60s,
      `DEFAULT_REQUEST_TIMEOUT_MS`) combined with the caller's own
      `AbortSignal` via `AbortSignal.any`, constructed fresh inside the
      retry loop rather than once outside it - an earlier version built one
      `AbortSignal.timeout` before the loop, which made it a single
      deadline for the *whole* call (including every retry's backoff wait)
      rather than a timeout on each attempt individually; a slow-but-alive
      provider on attempt 1 could burn through the deadline before attempt
      2 even started. `checkProviderHealth`'s own models-list call also
      gets a 5s timeout now, so a hung TCP connection can't block worker
      startup forever.
- [x] Retry policy - same shared helper: retries on 429/503 by default,
      Anthropic also retries its 529 ("overloaded"). Never includes a
      provider's response body in a thrown error, even for a non-retried
      failure (only the HTTP status) - a provider's 401 body can echo a
      fragment of the key that was sent, and error messages end up in
      `review_jobs.error_message` and in logs.
- [x] Usage tracking - every `AgentAdapter.chat()` result carries
      `usage.inputTokens`/`outputTokens` where the provider reports them;
      `runAgentLoop` accumulates it across turns, and the pipeline now
      threads it into `reviews.input_tokens`/`output_tokens` (bigint
      columns that existed since Phase 2 but were never populated before
      this). Agent-loop path only - the one-shot path's usage isn't
      wired, matching the fact that Phase 7's `TokenBudget` still has no
      caller either (see Phase 7's entry above, still true).

**Anthropic specifics, worth calling out since they came from a targeted
review rather than being obvious up front** (checked against the bundled
`claude-api` skill, not recalled from training):
- `DEFAULT_ANTHROPIC_MODEL` is `claude-opus-5`, not a cheaper tier - the
  skill is explicit that the default should never be downgraded for cost
  without being told to. Override with `ANTHROPIC_MODEL` if that's not
  what you want for an automated per-PR reviewer.
- `claude-sonnet-5`/`claude-opus-5` both run adaptive thinking by default
  whenever a request omits `thinking` entirely, which this adapter always
  does - so a response routinely includes `thinking` blocks. The adapter
  now stores the raw response `content` array in `providerData` and echoes
  it back verbatim for a later turn (the same pattern Gemini's adapter
  uses for its own provider-specific fields), instead of reconstructing
  the assistant turn from just the normalized text/`ToolCall[]` fields -
  which would have silently dropped every `thinking` block.
- `llm/one-shot-from-agent.ts`'s forced `toolChoice` is real for
  OpenAI/Groq but the Anthropic adapter never sends `tool_choice` at all,
  even when asked: forcing a specific tool is documented as incompatible
  with extended thinking, which (again) these models run by default here.
  The one-shot composer's existing text-parsing fallback (for a provider
  that ignores `toolChoice`) covers this - Anthropic still calls
  `submit_review` in practice, since with `tool_choice: auto` and only one
  tool offered it's the obvious choice, just not a guaranteed one.
- `max_tokens` is 16000 for a non-streaming request (the skill's own
  guidance), not the original 8192 - low enough that a `tool_use` block
  competing with thinking output risked truncation.

**Done when:** switching providers doesn't require any change to the review
engine. Done for the agent-loop path (every provider is an `AgentAdapter`,
and `runAgentLoop`/`AgentToolExecutor` are already fully provider-neutral)
and for the one-shot fallback path (every provider is also a `ReviewModel`,
real or composed). Verified by 6 new unit test files (openai, groq,
anthropic, one-shot-from-agent, provider-factory, http-policy - 46 tests)
plus new provider-switching tests in `env.test.ts` (4 new tests: booting on
Groq alone with no `GEMINI_API_KEY` set, rejecting a selected provider with
no key, rejecting an unrecognized provider name) and `config/schema.test.ts`
(the full provider catalog), and 3 new integration tests (2 in
`worker-pipeline.test.ts` for the one-shot path, 1 in
`agent-review-pipeline.test.ts` for the agent-loop path) proving a repo's
`.coderexic.yml` `model:` choice is actually honored, with a config warning
when it names an unconfigured provider - including the real bug above,
caught only because that agent-loop test failed against the first version
of the gating logic.

**Live verification:** Groq only, at the user's request (no OpenAI/
Anthropic keys, no usable local Ollama). Three runs against the real Groq
API and the real installed throwaway repo:
- A direct `GET /openai/v1/models` call found Groq's actual current
  tool-capable model catalog - `llama-3.3-70b-versatile` (an obvious
  first guess) turned out to no longer exist there at all, so
  `DEFAULT_GROQ_MODEL` is pinned to `openai/gpt-oss-20b` instead, checked
  live rather than guessed.
- A full `runAgentLoop` run against the real repo: turn 1 called
  `get_file_content` on `app/layout.tsx` (real fetch, real fenced content
  returned), turn 2 called `submit_review` with a real, coherent review
  (`NO_FINDINGS`, matching the trivial synthetic diff). This is the first
  real multi-turn proof of Phase 9's agent loop working end to end against
  any provider - the earlier Gemini live check (Phase 9) only ever reached
  turn 1 before hitting a rate limit.
- A `createOneShotFromAgentAdapter(createGroqAgentAdapter(...))` run - the
  actual production default path when `AGENT_LOOP_ENABLED=false` - also
  produced a real, coherent review against the same repo.
- OpenAI and Anthropic have no live verification at all this phase - their
  request/response translation is checked only against unit tests with a
  fake `fetch`, following the exact shapes documented for each provider's
  API (Anthropic's via the `claude-api` skill), never exercised against
  the real endpoints. `gpt-5.1` (OpenAI's default) is an unverified guess,
  unlike Groq's checked-live default - set `OPENAI_MODEL` if it's wrong.

## Phase 11: BYOK
**Goal:** users can bring their own model credentials.

Scoped to the DB + crypto layer only, per an explicit product decision: no
API endpoint exists yet (Phase 13's web app, with real auth, hasn't been
built), so this phase builds and fully tests the storage, crypto, and
resolution logic through direct store calls and unit/integration tests, not
through any HTTP surface.

- [x] Encrypted credential storage - `packages/core/src/crypto/credential-crypto.ts`
      (`encryptCredential`/`decryptCredential`, AES-256-GCM, random 12-byte IV,
      AAD binding to `user_id|repository_id|provider` so a ciphertext copied
      into another row fails to decrypt). Stored via
      `db/store/model-credentials.ts`'s `createModelCredential`/`replaceModelCredential`
      into `model_credentials.encrypted_secret`. Master keys come from
      `MODEL_CREDENTIALS_MASTER_KEYS` (`crypto/env.ts`), never the DB, and are
      validated to be exactly 32 bytes at load time.
- [x] Key versioning - `model_credentials.key_version` records which master-key
      version encrypted a row; `crypto/master-key.ts`'s `parseMasterKeyMap`
      supports multiple concurrent versions.
- [x] Key validation - `llm/provider-factory.ts`'s `validateModelCredential`
      (a no-token models-list call, reusing Phase 10's `checkProviderHealth`).
      Live-verified against a real Groq key (valid) and a garbage key (401 ->
      invalid); not live-verified for OpenAI/Anthropic/Gemini (no keys
      available this phase, same limitation as Phase 10).
- [x] Key rotation - `db/store/model-credentials.ts`'s `rotateModelCredential`
      (decrypts under the row's current version, re-encrypts under a new one,
      updates in place).
- [x] Key deletion - `deleteModelCredential`; both "replace" and "delete" are
      soft deletes (`deleted_at`), matching DATA_MODEL.md.
- [x] No-secret logging - `encryptedSecret`/`encrypted_secret`, `plaintext`,
      `masterKey`/`master_key` added to the logger's `SECRET_KEYS`
      (`packages/core/src/logger.ts`), redacted by key name at any object
      depth. `ResolvedCredential`'s `apiKey` field was already covered by the
      existing `apiKey` entry.
- [x] Provider-specific credential validation - same as "Key validation" above.

Uniqueness: `model_credentials` has two partial unique indexes (migration
`0001`/`0002`) - `(user_id, repository_id, provider) NULLS NOT DISTINCT WHERE
deleted_at IS NULL` for user-scoped credentials, and `(repository_id,
provider) WHERE repository_id IS NOT NULL AND deleted_at IS NULL` for
repo-scoped ones (a repo credential is shared by the whole repo regardless of
which user added it, so it needs its own exclusivity independent of
`user_id`). Drizzle-kit's `uniqueIndex` builder has no `NULLS NOT DISTINCT`
API, so the `0001` migration's SQL was hand-edited after generation; `0002`
(the second index) needed no hand-editing.

`llm/credential-resolution.ts`'s `resolveProviderEntry` composes the full
repo > user > system precedence into a single usable `ProviderEntry`: the two
DB tiers come from `db/store/model-credentials.ts`'s
`resolveDecryptedCredential` (the only function in the codebase that returns
plaintext), and the system tier is whatever this deployment already has
configured for that provider via Phase 10's `buildProviderRegistry`. This is
exercised directly by tests only - it is **not** wired into
`apps/worker/src/review/pipeline.ts`. A review job has no session-derived
user (no auth flow exists yet), so using the PR author's key would
incorrectly bill whoever opened the PR, including fork contributors. Wiring
even the repo tier into the pipeline is left to whichever phase adds a real
per-repo BYOK setting with its own authorization story.

**Audit:**
- [x] Plaintext never stored - `encryptCredential`'s output never contains the
      input plaintext (tested); the DB row only ever holds `encrypted_secret`.
- [x] Plaintext never returned - every CRUD function in
      `db/store/model-credentials.ts` returns `ModelCredentialMetadata` (no
      `encryptedSecret` field); only `resolveDecryptedCredential` returns
      plaintext, and it's documented as the sole exception.
- [x] Plaintext never logged - see "No-secret logging" above; tested end to
      end (`tests/integration/db/model-credentials.test.ts`) by resolving a
      real credential, logging the resolved object through the shared logger
      config, and asserting the plaintext never reaches the log sink while a
      positive control confirms the sink did capture the log line.

**Done when:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`
(305 tests), `pnpm test:integration` (136 tests, including 19 new tests in
`tests/integration/db/model-credentials.test.ts`), and `pnpm build` all pass.
New unit tests: 13 in `crypto/credential-crypto.test.ts`, 5 in
`crypto/env.test.ts`, 3 in `llm/provider-factory.test.ts` (`validateModelCredential`).

## Phase 12: Re-review
**Goal:** developers can trigger a new review by hand.
- [x] Issue comment webhook - `apps/api/src/webhooks/handlers.ts`'s `onIssueComment`,
      registered in the existing `HANDLERS` table (was already a stub since
      Phase 3). Only `action: 'created'` is handled - edits never re-trigger.
- [x] Command parser - `packages/core/src/github/commands.ts`'s
      `hasReviewCommand` (9 unit tests). Matches an unquoted, unfenced
      `/review review` line, case-insensitive; skips `>`-quoted reply lines
      and fenced code blocks (so quoting or documenting the command doesn't
      trigger it).
- [x] `/review review` - the only recognized command this phase.
- [x] Authorization - `comment.author_association` (added to
      `issueCommentEventSchema` as `.optional()`; confirmed present on real
      GitHub comment payloads via `gh api`) allow-listed to `OWNER`, `MEMBER`,
      `COLLABORATOR`. A missing association and a `Bot` comment author (so
      the app itself, or another bot, can never trigger it) are both treated
      as unauthorized. Rejections are **silent** (`ignored`, logged, no
      reply) - see "Status reporting" below for why.
- [x] Duplicate prevention - `db/store/review-jobs.ts`'s `findActiveReviewJob`
      covers two cases beyond the existing per-head-sha idempotency key
      (which only dedupes automatic-vs-automatic):
      1. A second `/review review` while one is already PENDING/RUNNING for
         the same PR is ignored at the webhook handler (no job created).
      2. A manual job and an automatic job can still race to the same real
         head sha (comment, then push, before the comment's job resolves
         its placeholder sha) - `apps/worker/src/review/pipeline.ts` checks
         again once each job's real head sha is known and cancels the loser
         (`DUPLICATE_ACTIVE_REVIEW`).
      Both checks are bounded by `ACTIVE_JOB_WINDOW_MS` (30 minutes) so a
      row a crashed worker never reached a terminal status for doesn't
      block re-review on that PR forever.
      **Known residual race (accepted, not fixed):** two comments landing
      in the same instant can both pass the webhook handler's check before
      either creates its job, since there's no DB-level lock across it -
      closing that needs a stronger primitive than this phase's checks.
- [x] New review record - a manual job never reuses an automatic job's
      idempotency key (`manual:<delivery id>` vs. `automatic:<repo>:<PR>:<head
      sha>`), so each `/review review` creates its own `review_jobs` row per
      PRODUCT_SPEC.md §14, even for a head sha already reviewed
      automatically.
- [x] Status reporting - **by explicit product decision, no extra GitHub
      comments this phase**, made on a premise that turned out to be wrong
      and was corrected after the fact: `POST
      /repos/{owner}/{repo}/issues/{issue_number}/comments` (create an
      issue comment) is listed under GitHub's docs **both** as an "Issues"
      permission endpoint and as a "Pull requests" permission endpoint, so
      the existing `Pull requests: write` permission (already granted,
      PRODUCT_SPEC §7.1) is actually enough to post a plain comment on a
      PR - no `Issues: write` upgrade needed, and no re-accept required on
      any installation. A successful manual review posts as a normal PR
      review either way (existing `Pull requests: write` permission).
      Rejections and failures are visible in `webhook_events` and
      `review_jobs` (and Phase 13's dashboard, eventually) but nothing is
      posted back to the PR for them.

**Manual-trigger specifics** (`apps/worker/src/review/pipeline.ts`):
- A manual job is created with a placeholder head sha (`ZERO_SHA`, an
  all-zero 40-hex sha - the webhook handler that creates it never calls the
  GitHub API), overwritten via `updateReviewJobHeadSha` once the worker
  fetches the real pull request.
- Manual jobs **skip the superseded and draft checks** an automatic job
  goes through - a deliberate choice: an explicit `/review review` beats
  the automatic-trigger policy those checks exist for. A closed pull
  request is still rejected either way (checked again at both the webhook
  handler and the worker).

**Done when:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`
(316 tests: +9 for `hasReviewCommand`, +2 for the fenced-code-block cases),
`pnpm test:integration` (150 tests: the `issue_comment` suite grew from 1 to
11 tests, +4 new tests in `tests/integration/worker-pipeline.test.ts` for
the manual-trigger path), and `pnpm build` all pass.

## Phase 13: Web application
**Goal:** the hosted product experience.

**Pages:**
- [ ] Landing page
- [ ] GitHub login
- [ ] Onboarding
- [ ] Repository installation
- [ ] Dashboard
- [ ] Repository page
- [ ] Review history
- [ ] Settings
- [ ] Model settings
- [ ] Review rules
- [ ] Usage

**UX:** a user can go Login → Install App → Select repo → Configure model →
Open PR → Receive review, without reading developer docs.

## Phase 14: Observability
**Goal:** understand the system in production.
- [ ] Structured logs
- [ ] Request IDs
- [ ] Review IDs
- [ ] Webhook metrics
- [ ] Queue metrics
- [ ] Agent metrics
- [ ] Model usage
- [ ] Latency metrics
- [ ] Error tracking
- [ ] Health checks

## Phase 15: Evaluation system
**Goal:** measure review quality.
- [ ] Fixture repos
- [ ] Known-bug PRs
- [ ] False-positive cases
- [ ] Expected findings
- [ ] Automated evaluation runner
- [ ] Precision
- [ ] Recall
- [ ] Line accuracy
- [ ] Severity accuracy
- [ ] Cost per review
- [ ] Latency

Start with 25–50 cases. Never claim the reviewer is good based on a handful
of personal PRs.

## Phase 16: Security hardening
**Goal:** ready for real repos.
- [ ] Webhook security audit
- [ ] GitHub permission audit
- [ ] Secret scanning
- [ ] Path traversal tests
- [ ] Repo isolation tests
- [ ] Prompt injection tests
- [ ] Tool abuse tests
- [ ] Resource exhaustion tests
- [ ] Rate-limit tests
- [ ] Dependency audit
- [ ] Container hardening

**Production blocker:** no unresolved critical security issue.

## Phase 17: Reliability
- [ ] Retry policies
- [ ] Dead-letter jobs
- [ ] Duplicate webhook handling
- [ ] Stuck-job recovery
- [ ] Model timeout handling
- [ ] GitHub timeout handling
- [ ] DB retry
- [ ] Graceful shutdown
- [ ] Worker concurrency controls

## Phase 18: Production deployment
Domain → reverse proxy/LB → API → Queue → Workers → PostgreSQL.
- [ ] Production Docker image
- [ ] Secrets management
- [ ] TLS
- [ ] DB backups
- [ ] Migrations
- [ ] Monitoring
- [ ] Alerting
- [ ] CI/CD
- [ ] Rollback strategy
- [ ] Health checks

## Phase 19: Beta
**Goal:** real users, on 5–10 repos.

**Track:**
- review latency
- false positives
- useful and dismissed findings
- model cost
- failures
- developer feedback

Don't add major features without user evidence.

## Phase 20: Productization (only after real usage)
- [ ] Organizations
- [ ] Team members
- [ ] Billing
- [ ] Usage limits
- [ ] Analytics
- [ ] Custom review policies
- [ ] Team-wide rules
- [ ] Audit logs
- [ ] SSO
- [ ] Enterprise deployment

## Phase 21: Advanced review (future)
- [ ] Semantic code search
- [ ] Symbol graph
- [ ] Test-aware reasoning
- [ ] Security-specific analyzers
- [ ] Static-analysis integration
- [ ] Dependency vulnerability integration
- [ ] Commit history context
- [ ] Cross-PR regression detection
- [ ] Automatic test suggestions
- [ ] Patch generation
- [ ] Optional fix branch creation

No autonomous code changes until the review-only product is trustworthy.

## Phase 22: Scaling (only when required)
Webhook API → job queue → review, index and evaluation workers. Possible
infrastructure: Redis, PostgreSQL, object storage, managed queues and
container orchestration.

## Definition of production
The chain works reliably across repeated real-world PRs:

GitHub App → webhook → queue → worker → PR diff → dependency graph → agent →
validated findings → GitHub inline review

It also needs:
- no critical security issues
- repo isolation verified
- secrets protected
- observable failures
- automated tests passing
- an evaluation benchmark
- reproducible deploys
- possible rollback
- real users who have used it successfully
