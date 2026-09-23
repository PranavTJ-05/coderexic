# Architecture --- Context-Aware Agentic GitHub Code Review Platform

## 1. Architectural Principles

1.  GitHub is the source of truth for repository state.
2.  The database stores application state and an indexed dependency
    graph, not an authoritative copy of source code.
3.  AI is an analysis component, not the system of record.
4.  Agent tools are explicit and allowlisted.
5.  External providers are behind interfaces.
6.  Webhooks enqueue work; workers perform long-running analysis.
7.  Every external input is untrusted.
8.  Every expensive operation has a budget.
9.  Every major capability must be independently testable.
10. Start as a modular monolith and split services only when scale
    requires it.

------------------------------------------------------------------------

# 2. High-Level Architecture

``` text
                         GitHub
                           |
                    Webhook / API
                           |
                           v
                +---------------------+
                |   API / Webhook     |
                |       Server        |
                +----------+----------+
                           |
                    create job
                           |
                           v
                +---------------------+
                |       Queue         |
                +----------+----------+
                           |
                           v
                +---------------------+
                |   Review Worker     |
                +----------+----------+
                           |
             +-------------+-------------+
             |             |             |
             v             v             v
        GitHub API    Repository DB   Config Loader
             |             |             |
             +-------------+-------------+
                           |
                           v
                 +-------------------+
                 | Context / Graph   |
                 |     Engine        |
                 +---------+---------+
                           |
                           v
                  +----------------+
                  |  Review Agent  |
                  +-------+--------+
                          |
               +----------+----------+
               |          |          |
               v          v          v
           imports   dependents   file content
               |          |          |
               +----------+----------+
                          |
                          v
                     LLM Provider
                          |
                          v
                  Structured Review
                          |
                          v
                  Validation Layer
                          |
                          v
                     GitHub API
                          |
                          v
                    PR Comments
```

------------------------------------------------------------------------

# 3. Recommended Repository Architecture

Use a monorepo initially:

``` text
reviewgraph/
├── apps/
│   ├── api/
│   │   └── src/
│   ├── worker/
│   │   └── src/
│   └── web/
│       └── src/
│
├── packages/
│   ├── core/
│   ├── github/
│   ├── agent/
│   ├── llm/
│   ├── indexer/
│   ├── config/
│   ├── database/
│   ├── security/
│   ├── observability/
│   └── shared/
│
├── tests/
│   ├── fixtures/
│   ├── integration/
│   └── evaluation/
│
├── infra/
│   ├── docker/
│   └── deployment/
│
├── docs/
├── .env.example
├── docker-compose.yml
├── AGENTS.md
├── PRODUCT_SPEC.md
├── ARCHITECTURE.md
├── DATA_MODEL.md
├── AI_AGENT_SPEC.md
└── ROADMAP.md
```

A smaller first implementation may use one TypeScript application with
modules. Do not introduce a network boundary between every package.

------------------------------------------------------------------------

# 4. Runtime Components

## API server

Responsibilities:

-   health checks;
-   GitHub OAuth if hosted UI exists;
-   GitHub webhook handling;
-   installation callbacks;
-   user settings;
-   review status APIs.

It must NOT execute long-running agent reviews directly.

------------------------------------------------------------------------

## Worker

Responsibilities:

-   consume review jobs;
-   fetch PR data;
-   load configuration;
-   ensure dependency graph is current;
-   execute agent;
-   validate findings;
-   publish GitHub review;
-   persist result.

------------------------------------------------------------------------

## Queue

Recommended initial options:

-   Redis + BullMQ;
-   PostgreSQL-backed job queue for a very small deployment;
-   SQS for AWS production.

Choose one. Do not build a custom queue.

------------------------------------------------------------------------

## PostgreSQL

Stores:

-   users;
-   GitHub installations;
-   repositories;
-   repository settings;
-   dependency edges;
-   review jobs;
-   reviews;
-   findings;
-   provider configuration metadata;
-   encrypted credentials;
-   audit events.

------------------------------------------------------------------------

# 5. GitHub Integration

Create a dedicated `GitHubClient` abstraction.

``` ts
interface GitHubClient {
  getPullRequest(...): Promise<PullRequest>;
  getPullRequestFiles(...): Promise<PRFile[]>;
  getFileContent(...): Promise<string>;
  getRepositoryTree(...): Promise<TreeEntry[]>;
  createReview(...): Promise<void>;
  createIssueComment(...): Promise<void>;
}
```

The rest of the application must not depend on Octokit request details.

------------------------------------------------------------------------

# 6. Webhook Flow

``` text
POST /webhooks/github
        |
        v
Read raw request body
        |
        v
Verify X-Hub-Signature-256
        |
        v
Parse event
        |
        v
Check event type/action
        |
        v
Resolve installation
        |
        v
Create idempotency key
        |
        v
Persist job
        |
        v
Return 2xx quickly
```

Idempotency key:

``` text
installation_id + repository_id + event_id
```

For review execution, also prevent duplicate processing of:

``` text
repository + pull_request + head_sha
```

------------------------------------------------------------------------

# 7. Review Pipeline

``` text
ReviewJob
   |
   v
Load PR
   |
   v
Load repository config
   |
   v
Load changed files
   |
   v
Filter ignored paths
   |
   v
Resolve repository graph
   |
   v
Create AgentContext
   |
   v
Run Agent
   |
   v
Validate ReviewFinding[]
   |
   v
Apply severity filter
   |
   v
Map findings to GitHub lines
   |
   v
Create GitHub review
   |
   v
Persist results
```

------------------------------------------------------------------------

# 8. Dependency Graph

The graph contains:

``` text
forward:
A -> [B, C]

reverse:
B -> [A]
C -> [A]
```

The database should store edges as:

``` text
repository_id
source_path
target_path
commit_sha
```

Indexes:

``` text
(repository_id, source_path)
(repository_id, target_path)
```

This permits:

``` text
get_imports(A)
get_dependents(B)
```

------------------------------------------------------------------------

# 9. Indexing Strategy

## Initial indexing

When a repository is installed:

1.  Fetch repository tree at default branch.
2.  Filter supported source files.
3.  Fetch source contents.
4.  Parse imports.
5.  Resolve local imports.
6.  Store edges.
7.  Mark repository indexed at commit SHA.

## Incremental indexing

On push:

1.  Compare old SHA and new SHA.
2.  Identify changed source files.
3.  Remove stale edges originating from changed files.
4.  Re-parse changed files.
5.  Update affected reverse relationships.
6.  Update indexed SHA.

If incremental logic becomes unreliable, fall back to a complete
rebuild.

Correctness is more important than optimization.

------------------------------------------------------------------------

# 10. Import Resolution

The resolver should support:

### JavaScript / TypeScript

-   relative imports;
-   `.js` -\> `.ts`/`.tsx` convention;
-   extensionless imports;
-   `index.ts`;
-   common aliases such as `@/` and `~/`;
-   package imports excluded from repository graph.

### Python

-   relative imports;
-   module path mapping;
-   package `__init__` resolution.

### Go

-   local module packages;
-   standard/external packages ignored unless repository-local.

### Rust

-   `crate::`;
-   `mod`;
-   local module relationships.

### Java

-   package/import relationships.

### Ruby

-   `require`;
-   `require_relative`.

The graph should distinguish:

``` text
resolved local dependency
external dependency
unresolved import
```

------------------------------------------------------------------------

# 11. Context Selection

The agent should not receive the entire repository.

Start with:

``` text
changed files
+
direct imports
+
direct dependents
```

Then let the agent explore further.

Potential future ranking:

``` text
score =
  direct_dependency_weight
  + direct_dependent_weight
  + changed_file_proximity
  + symbol_match
  + test_relationship
  + path relevance
```

------------------------------------------------------------------------

# 12. LLM Adapter Architecture

``` ts
interface AgentModel {
  chat(
    messages: AgentMessage[],
    tools: ToolDefinition[]
  ): Promise<AgentResponse>;
}
```

Implement:

``` text
OpenAIAdapter
AnthropicAdapter
GeminiAdapter
OllamaAdapter
```

Provider-specific message/tool translation stays inside adapters.

Agent logic never imports provider SDKs.

------------------------------------------------------------------------

# 13. Security Boundary

The highest-risk boundary is:

``` text
untrusted repository
        +
untrusted repository instructions
        +
LLM
```

Never allow repository files to redefine:

-   system safety rules;
-   tool permissions;
-   filesystem boundaries;
-   network access;
-   secrets;
-   agent limits.

Repository instructions are treated as policy hints only.

------------------------------------------------------------------------

# 14. Agent Tool Security

Every tool must validate:

### get_file_content

-   path is repository-relative;
-   no `..`;
-   no absolute paths;
-   file belongs to the target repository;
-   content is fetched from the intended commit/ref.

### get_imports / get_dependents

-   repository ID is fixed by server-side context;
-   path is validated;
-   no user/model supplied repository identifier.

### submit_review

-   schema validation;
-   file must be changed file;
-   line must be in a reviewable diff;
-   severity must be allowed;
-   suggested code must be bounded in size.

------------------------------------------------------------------------

# 15. GitHub Comment Architecture

The agent produces internal findings.

A separate publisher translates:

``` text
ReviewFinding
        |
        v
GitHubReviewComment
```

This separation prevents the LLM from directly controlling GitHub API
payloads.

------------------------------------------------------------------------

# 16. Configuration Architecture

Load:

``` text
application defaults
        |
        v
user configuration
        |
        v
repository .verix.yml
        |
        v
repository rules file
```

Validate configuration with a schema.

Do not use a home-grown YAML parser in the production architecture.

------------------------------------------------------------------------

# 17. Failure Handling

## GitHub failure

Retry transient errors with exponential backoff.

Do not retry permanent 4xx errors indefinitely.

## Model failure

Retry limited times.

Then mark review:

``` text
FAILED_MODEL
```

## Agent timeout

Mark:

``` text
TIMED_OUT
```

Do not publish partial findings unless explicitly supported.

## Index failure

Review may fall back to diff-only mode with a visible status.

------------------------------------------------------------------------

# 18. State Machine

Review job:

``` text
PENDING
  |
  v
RUNNING
  |
  +----> SUCCEEDED
  |
  +----> FAILED
  |
  +----> TIMED_OUT
  |
  +----> CANCELLED
```

Index job:

``` text
PENDING
  |
  v
INDEXING
  |
  +----> READY
  |
  +----> FAILED
```

------------------------------------------------------------------------

# 19. Deployment

Initial production:

``` text
                 Internet
                    |
                 Nginx/LB
                    |
              API container
                    |
             PostgreSQL
                    |
              Redis/Queue
                    |
              Worker container
```

Optional:

``` text
Object storage
```

for large artifacts/logs later.

Docker Compose is sufficient for early deployment.

Kubernetes is not required initially.

------------------------------------------------------------------------

# 20. Scaling Path

Stage 1:

``` text
1 API
1 Worker
1 Postgres
1 Redis
```

Stage 2:

``` text
multiple workers
```

Stage 3:

``` text
separate indexing workers
review workers
webhook API
```

Stage 4:

``` text
multi-region / enterprise infrastructure
```

Do not start with Stage 4.

------------------------------------------------------------------------

# 21. Recommended Initial Technology

Because the target product is similar to the existing TypeScript
implementation, use:

-   TypeScript;
-   Node.js;
-   Fastify or Express;
-   Octokit;
-   PostgreSQL;
-   Redis + BullMQ;
-   pnpm;
-   Zod;
-   Vitest;
-   Docker;
-   OpenTelemetry-compatible logging/metrics.

Frontend:

-   Next.js;
-   Tailwind CSS;
-   shadcn/ui.

Use a modular monolith before splitting services.

------------------------------------------------------------------------

# 22. Architecture Decision Rules

When the agent proposes a new technology, it must answer:

1.  What problem does it solve?
2.  Why can't the existing stack solve it?
3.  What operational cost does it add?
4.  How does it affect local development?
5.  How does it affect production?
6.  Can we remove it later?

No dependency should be added merely because it is fashionable.
