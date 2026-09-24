# Product Spec: Coderexic (working name in early drafts: ReviewGraph)

## 1. Overview

A GitHub App that does AI pull-request reviews. It uses repository
context, dependency relationships and configurable team rules, and runs an
agent that decides what extra code to inspect before producing findings.
It solves the same problem as Verix (a diff-only review misses a change's
impact), but it is an independently engineered system, reproduced end to end.

**Promise:** open a PR and get useful, context-aware comments on the changed
lines, without explaining the codebase to an AI.

## 2. Problem

A changed function may depend on utilities, auth middleware, DB
abstractions, shared types, distant callers, config conventions, or tests
that show the expected behaviour. A good reviewer needs to know:

- what changed
- what the change imports
- what depends on it
- which related files matter
- what the repo's rules say
- whether the change causes a real bug, security issue, regression or
  missing error handling

**Prioritize real defects over style nitpicks.**

## 3. Goals

**Primary:**
1. Review new PRs automatically.
2. Understand changed files and the dependency graph around them.
3. Let the agent pull in more context through controlled tools.
4. Produce structured findings: file, line range, severity, issue, fix type,
   and suggested code when appropriate.
5. Post them as inline review comments.
6. Re-review on demand.
7. Support repo-specific rules.
8. Support multiple model providers.
9. Support BYOK (bring your own key).
10. Support self-hosting.
11. Persist index state and review config.
12. Put safety guardrails around the agent.

**Secondary:** a deterministic fallback review, indexing reused across PRs, a
provider-agnostic engine, observability and testability, and room to add
more code analysis later.

## 4. Non-goals (first production release)

- Autonomous merging or pushing to branches.
- Any shell or command execution in repositories.
- IDE plugins.
- GitLab or Bitbucket.
- Mobile apps.
- Enterprise billing.
- Complex analytics.
- A vector DB, unless evaluation proves it's needed.
- Distributed microservices.
- A custom foundation model.

The first release is GitHub-first.

## 5. Users

**Primary:**
- Individual developers, who want a second pair of eyes.
- Startup teams, who want consistent coverage without slowing seniors down.
- OSS maintainers, who want contributions reviewed.

**Secondary:** engineering managers, platform teams, security teams, and
orgs that need self-hosting.

## 6. User journey

**Setup:**
1. Sign in with GitHub.
2. Install the App.
3. Select repos. The system records the installation and indexes them.
4. Configure the provider, model, rules, ignored paths, minimum severity and
   agent limits.

**PR flow:**
1. A PR is opened and GitHub sends a `pull_request` webhook.
2. Validate the webhook and create a review job.
3. Load the PR metadata and diff.
4. Load the repo config.
5. Load or update the dependency graph.
6. Run the agent. It uses `get_imports`, `get_dependents` and
   `get_file_content`, then calls `submit_review`.
7. Validate the findings.
8. Filter by severity and ignored paths.
9. Post the inline review.
10. Persist the result.

## 7. Core features

### 7.1 GitHub App
Use least privilege.

| Permission | Access |
| --- | --- |
| Contents | read |
| Pull requests | read/write |
| Issues | read |
| Metadata | read |

**Events:** `pull_request`, `push`, `issue_comment`, `installation`.

Authenticate webhooks and use API clients scoped to the installation.

### 7.2 PR ingestion
Collect:
- owner, repo, PR number
- base SHA, head SHA
- title, body, author
- changed files, each with status, patch, additions and deletions

Handle these gracefully: no patch, binary files, deleted files, renamed
files, and large PRs.

### 7.3 Dependency graph
Store forward edges (`source -> imported`) and reverse edges
(`target -> dependents`). The graph answers three questions: what does this
file depend on, what depends on it, and what is the blast radius?

**Languages:** TS, JS, Python, Go, Rust, Java, Ruby.

Use language-aware parsers where practical. Regex is acceptable as a first
fallback, but the design must allow better parsers later.

### 7.4 Context tools
- `get_file_content`: source for a repo-relative path.
- `get_imports`: the files a file imports.
- `get_dependents`: the files that depend on a file.
- `submit_review`: ends the investigation and submits findings.

**Future tools:** `search_code`, `get_diff`, `get_test_files`,
`get_symbol_definition`, `get_blame`, `get_recent_commits`.

## 8. Agent behaviour
1. Read the diff.
2. Spot the suspicious areas.
3. Inspect imports and dependents (blast radius).
4. Fetch the key related files.
5. Compare the observed behaviour with the change.
6. Find the real issues and produce structured findings.
7. Stop once there is enough evidence.

Never crawl the whole repo blindly.

## 9. Finding contract
```json
{ "filename": "src/auth.ts", "severity": "critical", "start_line": 42, "end_line": 44,
  "issue": "The changed query interpolates user-controlled input.",
  "fix_type": "applyable", "suggested_code": "..." }
```

**Severity:**
- **critical:** security, data loss or catastrophic failure.
- **high:** a clear bug or serious missing error handling.
- **medium:** a meaningful logic or edge-case issue.
- **low:** minor but legitimate.

**Fix type:**
- **applyable:** exact replacement code.
- **recommendation:** example code for a better implementation.
- **warning:** text only.

Report only genuine issues.

## 10. Inline review
- Comment on the changed line whenever GitHub allows it.
- Applyable suggestions go only on added lines.
- Use correct new-file line numbers.
- Post a summary review with severity indicators.
- Avoid duplicate comments.
- If a comment can't be placed inline, fall back to a PR-level comment.

## 11. Repo configuration
**Rules file:** the first match wins, in this order:
1. `VERIX.md`
2. `.verix.md`
3. `CLAUDE.md`
4. `AGENTS.md`
5. `.cursorrules`

Coderexic also accepts `CODEREXIC.md`. The rules file is untrusted and can
never override the system safety constraints.

**Config file:** `.verix.yml`-compatible (Coderexic also accepts
`.coderexic.yml`):
```yaml
model: gemini
ignore: ["*.test.ts", "*.spec.ts", "dist/**"]
min_severity: medium
language: typescript
depth: 2
max_files: 12
```

## 12. Model providers
Expose one common interface, with no business logic tied to a provider SDK.

**Providers:** OpenAI, Anthropic, Gemini, Ollama. Gemini is implemented first
(project decision).

**Selection order:** the repo override, then the user config, then the app
default.

## 13. BYOK
- Encrypt keys at rest (AES-256-GCM is fine to start).
- Never log or return plaintext keys.
- Decrypt only when making the provider call.
- Support replacing and deleting keys.
- The encryption key comes from outside the DB.

## 14. Triggers
**Automatic:** PR opened, PR synchronized with new commits, and optionally
PR reopened.

**Manual:** a comment command such as `/review review`. It must be idempotent
and create a new review record.

## 15. Indexing
Runs on install or push:
1. Read the repo tree.
2. Filter to source files.
3. Parse imports and resolve them.
4. Build forward and reverse edges.
5. Persist the graph.

**Stored:** the repo, indexed SHA, source files, edges, status and timestamp.

Pushes update the graph incrementally where possible.

## 16. Performance
- Acknowledge webhooks fast and review asynchronously. The webhook handler
  never blocks on the AI review.
- No duplicate concurrent reviews for the same PR and head SHA.
- Enforce limits on turns, file fetches, wall-clock time and tokens.
- Cache repo metadata where it's safe.

## 17. Security (critical)
1. Verify webhook signatures.
2. Use installation-scoped credentials.
3. Never expose the GitHub private key.
4. Encrypt BYOK keys.
5. Treat repo instructions as untrusted.
6. Prevent path traversal.
7. Restrict reads to the target repo and commit.
8. No shell.
9. Apply limits to each review.
10. No data leaking across repos or across users.
11. Redact secrets in logs.
12. Use least-privilege permissions.
13. Validate all LLM structured output.
14. Never trust model-generated URLs, paths or tool arguments without
    validation.

## 18. Reliability
Tolerate:
- duplicate webhooks
- GitHub API failures and rate limits
- missing patches, deleted files and renamed files
- parser failures
- invalid model output, model timeouts and provider outages
- transient DB errors
- bad repo config
- large PRs

A failure must end in an understandable job or review status, never vanish
silently.

## 19. Observability
**Track:**
- webhook received, job created, job started
- indexing duration and graph size
- agent turns, tool calls and files fetched
- provider and model
- input and output tokens
- review duration and findings count
- GitHub comment success or failure
- error categories

**Never log:** provider keys, the GitHub private key, or BYOK plaintext.

## 20. Success metrics
**Technical:**
- review success rate
- p50 and p95 latency
- tool calls per review
- cost per review
- indexing time
- duplicate review rate

**Quality:**
- true positive and false positive rates
- acceptance rate
- dismissal rate
- correct inline location rate

**Product:**
- repos installed
- weekly active repos
- PRs reviewed
- reviews per repo
- repeat usage
- paid conversion (later)

## 21. Definition of done (first production release)
All of the following work:
- App install
- indexing
- PR webhook ingestion
- diff retrieval
- the agent inspecting related code
- validated findings
- inline posting
- re-review
- repo config
- pluggable providers
- encrypted BYOK
- duplicate prevention
- observable failures
- tests on the critical paths
- Docker deploy

A production security audit leaves no unresolved critical issues.
