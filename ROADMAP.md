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
- [ ] GitHub App configuration (code and docs done; live check with a registered App pending)
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
- [ ] LLM abstraction
- [ ] First provider adapter (the spec said OpenAI; we're doing Gemini first)
- [ ] Structured review schema
- [ ] Finding validator
- [ ] Line mapping
- [ ] Summary generation
- [ ] GitHub inline comments
- [ ] Fallback PR comment

**Done when:** opening a PR produces a real AI review. This proves the basic
loop.

## Phase 5: Repository configuration
**Goal:** repos control how they're reviewed.
- [ ] VERIX.md-compatible loader (plus CODEREXIC.md)
- [ ] Fallback rules files
- [ ] .verix.yml-compatible config (plus .coderexic.yml)
- [ ] Ignore patterns
- [ ] Minimum severity
- [ ] Language hint
- [ ] Model override
- [ ] Max agent files
- [ ] Max depth

**Security:**
- [ ] Rules treated as untrusted input
- [ ] Rules can't override system security

## Phase 6: Dependency graph
**Goal:** understand how the repo's files relate.
- [ ] Repository tree crawler
- [ ] Supported-extension detection
- [ ] TypeScript/JavaScript parser
- [ ] Python parser
- [ ] Go parser
- [ ] Rust parser
- [ ] Java parser
- [ ] Ruby parser
- [ ] Local import resolver
- [ ] Alias resolver
- [ ] Forward graph
- [ ] Reverse graph
- [ ] DB persistence
- [ ] Graph indexing
- [ ] Incremental update

**Fixture repos covering:**
- [ ] Direct imports
- [ ] Indirect imports
- [ ] Aliases
- [ ] Index files
- [ ] Renamed files
- [ ] Deleted files
- [ ] Circular dependencies
- [ ] Unresolved imports
- [ ] External packages

## Phase 7: Context engine
**Goal:** give reviews relevant context.
- [ ] Direct import retrieval
- [ ] Dependent retrieval
- [ ] Changed-file filtering
- [ ] Context ranking
- [ ] Context token budget
- [ ] File size limits
- [ ] Context cache

**Done when:** the engine can answer what a changed file depends on, what
depends on it, and which files to inspect.

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
