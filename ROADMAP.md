# Roadmap --- Context-Aware Agentic GitHub Code Review Platform

## Guiding Principle

Every phase must leave the repository in a working state.

A phase is not complete because code was written.

A phase is complete only when:

-   implementation exists;
-   tests exist;
-   tests pass;
-   lint passes;
-   type checks pass;
-   documentation is updated;
-   the feature can actually be exercised.

------------------------------------------------------------------------

# Phase 0 --- Product and Architecture

## Goal

Turn the idea into an executable engineering specification.

### Tasks

-   [x] Product specification
-   [x] Architecture
-   [x] Data model
-   [x] Agent specification
-   [x] Roadmap
-   [x] AGENTS.md
-   [ ] threat model
-   [ ] initial evaluation strategy

### Definition of done

The entire team/agent can explain:

``` text
GitHub event
→ review job
→ repository context
→ agent
→ findings
→ GitHub comments
```

without ambiguity.

------------------------------------------------------------------------

# Phase 1 --- Repository Foundation

## Goal

Create a clean production-oriented TypeScript repository.

### Tasks

-   [x] pnpm setup
-   [x] TypeScript strict mode
-   [x] workspace structure
-   [x] linting
-   [x] formatting
-   [x] Vitest
-   [x] environment validation
-   [x] Docker
-   [x] PostgreSQL
-   [x] health endpoint
-   [x] structured logging
-   [x] CI
-   [x] README
-   [x] AGENTS.md

### Definition of done

``` bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
docker compose up
```

all work successfully.

------------------------------------------------------------------------

# Phase 2 --- Database

## Goal

Implement persistent application state.

### Tasks

-   [ ] migration system
-   [ ] users
-   [ ] installations
-   [ ] repositories
-   [ ] repository settings
-   [ ] dependency edges
-   [ ] indexed files
-   [ ] index runs
-   [ ] review jobs
-   [ ] reviews
-   [ ] findings
-   [ ] agent runs
-   [ ] tool calls
-   [ ] webhook events
-   [ ] audit events

### Tests

-   [ ] CRUD
-   [ ] foreign keys
-   [ ] uniqueness
-   [ ] cascading behavior
-   [ ] transaction behavior

------------------------------------------------------------------------

# Phase 3 --- GitHub App

## Goal

Receive and interact with GitHub securely.

### Tasks

-   [ ] GitHub App configuration
-   [ ] App authentication
-   [ ] installation authentication
-   [ ] webhook signature validation
-   [ ] webhook parsing
-   [ ] installation event
-   [ ] pull request event
-   [ ] push event
-   [ ] issue comment event
-   [ ] PR metadata retrieval
-   [ ] PR file retrieval
-   [ ] file content retrieval
-   [ ] review publishing

### Security

-   [ ] private key protection
-   [ ] least privilege
-   [ ] event idempotency
-   [ ] rate-limit handling

------------------------------------------------------------------------

# Phase 4 --- Basic Diff Reviewer

## Goal

Create the simplest useful product before building the agent.

### Flow

``` text
PR
→ diff
→ LLM
→ structured findings
→ GitHub review
```

### Tasks

-   [ ] LLM abstraction
-   [ ] OpenAI adapter
-   [ ] structured review schema
-   [ ] finding validator
-   [ ] line mapping
-   [ ] summary generation
-   [ ] GitHub inline comments
-   [ ] fallback PR comment

### Definition of done

Opening a PR produces a real AI review.

This phase proves the basic product loop.

------------------------------------------------------------------------

# Phase 5 --- Repository Configuration

## Goal

Allow repositories to control review behavior.

### Tasks

-   [ ] VERIX.md-compatible loader
-   [ ] fallback rules files
-   [ ] .verix.yml-compatible config
-   [ ] ignore patterns
-   [ ] minimum severity
-   [ ] language hint
-   [ ] model override
-   [ ] max agent files
-   [ ] max depth

### Security

-   [ ] rules treated as untrusted input
-   [ ] rules cannot override system security

------------------------------------------------------------------------

# Phase 6 --- Dependency Graph

## Goal

Understand repository relationships.

### Tasks

-   [ ] repository tree crawler
-   [ ] supported-extension detection
-   [ ] TypeScript/JavaScript parser
-   [ ] Python parser
-   [ ] Go parser
-   [ ] Rust parser
-   [ ] Java parser
-   [ ] Ruby parser
-   [ ] local import resolver
-   [ ] alias resolver
-   [ ] forward graph
-   [ ] reverse graph
-   [ ] database persistence
-   [ ] graph indexing
-   [ ] incremental update

### Tests

Create fixture repositories containing:

-   [ ] direct imports
-   [ ] indirect imports
-   [ ] aliases
-   [ ] index files
-   [ ] renamed files
-   [ ] deleted files
-   [ ] circular dependencies
-   [ ] unresolved imports
-   [ ] external packages

------------------------------------------------------------------------

# Phase 7 --- Context Engine

## Goal

Give reviews relevant repository context.

### Tasks

-   [ ] direct import retrieval
-   [ ] dependent retrieval
-   [ ] changed-file filtering
-   [ ] context ranking
-   [ ] context token budget
-   [ ] file size limits
-   [ ] context cache

### Definition of done

The review engine can answer:

``` text
What does this changed file depend on?
What depends on this changed file?
Which files should be inspected?
```

------------------------------------------------------------------------

# Phase 8 --- Agent Tools

## Goal

Turn the reviewer into an agentic reviewer.

### Tools

-   [ ] get_file_content
-   [ ] get_imports
-   [ ] get_dependents
-   [ ] submit_review

### Tasks

-   [ ] tool schemas
-   [ ] tool executor
-   [ ] argument validation
-   [ ] repository scoping
-   [ ] path validation
-   [ ] duplicate tool-call prevention
-   [ ] tool timeouts
-   [ ] result size limits

------------------------------------------------------------------------

# Phase 9 --- Agent Loop

## Goal

Allow the model to decide what context it needs.

### Tasks

-   [ ] system prompt
-   [ ] tool-call loop
-   [ ] max turns
-   [ ] max file fetches
-   [ ] wall-clock timeout
-   [ ] cancellation
-   [ ] malformed tool-call handling
-   [ ] structured submission
-   [ ] fallback parsing
-   [ ] agent run persistence

### Definition of done

The agent can perform:

``` text
diff
→ get_imports
→ get_dependents
→ get_file_content
→ submit_review
```

without human intervention.

------------------------------------------------------------------------

# Phase 10 --- Multi-Provider Models

## Goal

Make model providers interchangeable.

### Tasks

-   [ ] OpenAI
-   [ ] Anthropic
-   [ ] Gemini
-   [ ] Ollama
-   [ ] provider factory
-   [ ] provider health checks
-   [ ] timeout policy
-   [ ] retry policy
-   [ ] usage tracking

### Definition of done

Changing the provider does not require changing the review engine.

------------------------------------------------------------------------

# Phase 11 --- BYOK

## Goal

Allow users to provide model credentials.

### Tasks

-   [ ] encrypted credential storage
-   [ ] key versioning
-   [ ] key validation
-   [ ] key rotation
-   [ ] key deletion
-   [ ] no-secret logging
-   [ ] provider-specific credential validation

### Security audit

-   [ ] plaintext never stored
-   [ ] plaintext never returned
-   [ ] plaintext never logged

------------------------------------------------------------------------

# Phase 12 --- Re-review

## Goal

Allow developers to manually trigger a new review.

### Tasks

-   [ ] issue comment webhook
-   [ ] command parser
-   [ ] `/review review`
-   [ ] authorization
-   [ ] duplicate prevention
-   [ ] new review record
-   [ ] status reporting

------------------------------------------------------------------------

# Phase 13 --- Web Application

## Goal

Create the hosted product experience.

### Pages

-   [ ] landing page
-   [ ] GitHub login
-   [ ] onboarding
-   [ ] repository installation
-   [ ] dashboard
-   [ ] repository page
-   [ ] review history
-   [ ] settings
-   [ ] model settings
-   [ ] review rules
-   [ ] usage

### UX

User should be able to:

``` text
Login
→ Install App
→ Select repository
→ Configure model
→ Open PR
→ Receive review
```

without reading developer documentation.

------------------------------------------------------------------------

# Phase 14 --- Observability

## Goal

Understand the system in production.

### Tasks

-   [ ] structured logs
-   [ ] request IDs
-   [ ] review IDs
-   [ ] webhook metrics
-   [ ] queue metrics
-   [ ] agent metrics
-   [ ] model usage
-   [ ] latency metrics
-   [ ] error tracking
-   [ ] health checks

------------------------------------------------------------------------

# Phase 15 --- Evaluation System

## Goal

Measure review quality.

### Tasks

-   [ ] fixture repositories
-   [ ] known-bug PRs
-   [ ] false-positive cases
-   [ ] expected findings
-   [ ] automated evaluation runner
-   [ ] precision metric
-   [ ] recall metric
-   [ ] line accuracy
-   [ ] severity accuracy
-   [ ] cost per review
-   [ ] latency

### Minimum benchmark

Start with 25--50 cases.

Do not claim the reviewer is good based on a handful of personal PRs.

------------------------------------------------------------------------

# Phase 16 --- Security Hardening

## Goal

Prepare for real repositories.

### Tasks

-   [ ] webhook security audit
-   [ ] GitHub permission audit
-   [ ] secret scanning
-   [ ] path traversal tests
-   [ ] repository isolation tests
-   [ ] prompt injection tests
-   [ ] tool abuse tests
-   [ ] resource exhaustion tests
-   [ ] rate-limit tests
-   [ ] dependency audit
-   [ ] container hardening

### Production blocker

No unresolved critical security issue.

------------------------------------------------------------------------

# Phase 17 --- Reliability

### Tasks

-   [ ] retry policies
-   [ ] dead-letter jobs
-   [ ] duplicate webhook handling
-   [ ] stuck-job recovery
-   [ ] model timeout handling
-   [ ] GitHub timeout handling
-   [ ] database retry
-   [ ] graceful shutdown
-   [ ] worker concurrency controls

------------------------------------------------------------------------

# Phase 18 --- Production Deployment

## Initial deployment

``` text
Domain
  |
Reverse proxy / Load balancer
  |
API
  |
Queue
  |
Workers
  |
PostgreSQL
```

### Tasks

-   [ ] production Docker image
-   [ ] secrets management
-   [ ] TLS
-   [ ] database backups
-   [ ] migrations
-   [ ] monitoring
-   [ ] alerting
-   [ ] CI/CD
-   [ ] rollback strategy
-   [ ] health checks

------------------------------------------------------------------------

# Phase 19 --- Beta

## Goal

Get real users.

Target:

``` text
5–10 repositories
```

Track:

-   review latency;
-   false positives;
-   useful findings;
-   dismissed findings;
-   model cost;
-   failures;
-   developer feedback.

Do not add major features unless user evidence supports them.

------------------------------------------------------------------------

# Phase 20 --- Productization

Only after real usage.

Potential features:

-   [ ] organizations
-   [ ] team members
-   [ ] billing
-   [ ] usage limits
-   [ ] analytics
-   [ ] custom review policies
-   [ ] team-wide rules
-   [ ] audit logs
-   [ ] SSO
-   [ ] enterprise deployment

------------------------------------------------------------------------

# Phase 21 --- Advanced Review

Future possibilities:

-   [ ] semantic code search
-   [ ] symbol graph
-   [ ] test-aware reasoning
-   [ ] security-specific analyzers
-   [ ] static-analysis integration
-   [ ] dependency vulnerability integration
-   [ ] commit history context
-   [ ] cross-PR regression detection
-   [ ] automatic test suggestions
-   [ ] patch generation
-   [ ] optional fix branch creation

Do not build autonomous code changes until the review-only product is
trustworthy.

------------------------------------------------------------------------

# Phase 22 --- Scaling

Only when required.

Potential split:

``` text
Webhook API
      |
      v
Job Queue
      |
      +---- Review Workers
      |
      +---- Index Workers
      |
      +---- Evaluation Workers
```

Possible infrastructure:

-   Redis;
-   PostgreSQL;
-   object storage;
-   managed queues;
-   container orchestration.

------------------------------------------------------------------------

# Definition of Production

The product is production-ready when:

``` text
GitHub App
     ↓
Webhook
     ↓
Queue
     ↓
Worker
     ↓
PR diff
     ↓
Dependency graph
     ↓
Agent
     ↓
Validated findings
     ↓
GitHub inline review
```

works reliably across repeated real-world PRs.

Additionally:

-   no critical security issues;
-   repository isolation verified;
-   secrets protected;
-   failures observable;
-   automated tests pass;
-   evaluation benchmark exists;
-   deployment is reproducible;
-   rollback is possible;
-   real users have successfully used it.
