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
      engine's own PR-head file fetches within one review. Also designed to
      be shared with Phase 8's tool executor for cross-tool duplicate-call
      prevention, but that reuse hasn't happened yet - the executor doesn't
      exist yet, and when it's built, its "already fetched" dedup logic
      needs its own tracking of what's actually been delivered *to the
      model*, separate from this cache's fetch-content reuse (a changed
      file's content the engine fetched for import extraction has never
      been shown to the model, so it must never be refused as a duplicate).

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
- [ ] get_file_content
- [ ] get_imports
- [ ] get_dependents
- [ ] submit_review

**Tasks:**
- [ ] Tool schemas
- [ ] Tool executor
- [ ] Argument validation
- [ ] Repo scoping
- [ ] Path validation
- [ ] Duplicate-call prevention
- [ ] Tool timeouts
- [ ] Result size limits

## Phase 9: Agent loop
**Goal:** the model decides what context it needs.
- [ ] System prompt
- [ ] Tool-call loop
- [ ] Max turns
- [ ] Max file fetches
- [ ] Wall-clock timeout
- [ ] Cancellation
- [ ] Malformed tool-call handling
- [ ] Structured submission
- [ ] Fallback parsing
- [ ] Agent run persistence

**Done when:** the agent goes diff → get_imports → get_dependents →
get_file_content → submit_review with no human intervention.

## Phase 10: Multi-provider models
**Goal:** providers are interchangeable.
- [ ] OpenAI
- [ ] Anthropic
- [ ] Gemini
- [ ] Ollama
- [ ] Provider factory
- [ ] Provider health checks
- [ ] Timeout policy
- [ ] Retry policy
- [ ] Usage tracking

**Done when:** switching providers doesn't require any change to the review
engine.

## Phase 11: BYOK
**Goal:** users can bring their own model credentials.
- [ ] Encrypted credential storage
- [ ] Key versioning
- [ ] Key validation
- [ ] Key rotation
- [ ] Key deletion
- [ ] No-secret logging
- [ ] Provider-specific credential validation

**Audit:**
- [ ] Plaintext never stored
- [ ] Plaintext never returned
- [ ] Plaintext never logged

## Phase 12: Re-review
**Goal:** developers can trigger a new review by hand.
- [ ] Issue comment webhook
- [ ] Command parser
- [ ] `/review review`
- [ ] Authorization
- [ ] Duplicate prevention
- [ ] New review record
- [ ] Status reporting

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
