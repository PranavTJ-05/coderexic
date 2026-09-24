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

**Decision:** Coderexic uses the lean variant. It has `apps/api` and
`apps/worker` (with `apps/web` in Phase 13), and one `packages/core` split
into folders.

## 4. Runtime components
- **API:**
  - health checks
  - GitHub OAuth (if there's a hosted UI)
  - webhooks and install callbacks
  - user settings
  - review-status APIs
  - It never runs agent reviews itself.
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
