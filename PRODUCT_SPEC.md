# Product Specification --- Context-Aware Agentic GitHub Code Review Platform

## 1. Product Overview

### Working name

Use a temporary product name such as `ReviewGraph` until branding is
decided.

### Product statement

ReviewGraph is a GitHub App that performs AI-powered pull-request
reviews using repository context, dependency relationships, configurable
team rules, and an agent that decides what additional code it needs to
inspect before producing findings.

The product is intentionally modeled around the same product problem as
Verix: reviewing only the PR diff is often insufficient to understand
the impact of a change. The implementation should reproduce the core
experience end-to-end while remaining an independently engineered
system.

### Core user promise

> Open a pull request and receive useful, context-aware review comments
> directly on the changed lines, without manually explaining the
> surrounding codebase to an AI.

------------------------------------------------------------------------

# 2. Problem

Traditional diff-only AI review has limited context.

A changed function may depend on:

-   another utility
-   an authentication middleware
-   a database abstraction
-   a shared type
-   a caller several files away
-   a configuration convention
-   tests that reveal expected behavior

A high-quality reviewer therefore needs to understand:

1.  what changed;
2.  what the changed code imports;
3.  what depends on the changed code;
4.  which related files matter;
5.  what the repository's review rules say;
6.  whether the change creates a real bug, security issue, regression,
    or missing error handling.

The product should prioritize real defects over style nitpicks.

------------------------------------------------------------------------

# 3. Goals

## Primary goals

1.  Automatically review new GitHub pull requests.
2.  Understand changed files and their surrounding dependency graph.
3.  Let an AI agent request additional repository context through
    controlled tools.
4.  Produce structured findings with:
    -   file
    -   line range
    -   severity
    -   issue
    -   fix type
    -   suggested code when appropriate
5.  Post findings as GitHub inline review comments.
6.  Support re-review on demand.
7.  Support repository-specific review rules.
8.  Support multiple model providers.
9.  Support bring-your-own-key (BYOK).
10. Support self-hosting.
11. Persist repository indexing state and review configuration.
12. Provide safe guardrails around the agent.

## Secondary goals

-   Provide deterministic fallback review behavior.
-   Make indexing reusable between PRs.
-   Keep the core review engine provider-agnostic.
-   Make the system observable and testable.
-   Make the system extensible toward future code-analysis capabilities.

------------------------------------------------------------------------

# 4. Non-goals for the first production release

Do NOT initially build:

-   autonomous code merging;
-   autonomous pushing to branches;
-   arbitrary shell execution;
-   arbitrary command execution inside repositories;
-   full IDE plugins;
-   GitLab/Bitbucket support;
-   mobile applications;
-   organization-wide enterprise billing;
-   complex analytics;
-   a vector database unless evaluation proves it necessary;
-   a distributed microservice architecture;
-   a custom foundation model.

The initial product should be a strong GitHub-first code-review system.

------------------------------------------------------------------------

# 5. Target Users

## Primary

### Individual developers

They want an automated second pair of eyes on PRs.

### Startup engineering teams

They want consistent review coverage without slowing down senior
engineers.

### Open-source maintainers

They want automated review on incoming contributions.

## Secondary

-   engineering managers;
-   platform teams;
-   security teams;
-   larger organizations requiring self-hosted review.

------------------------------------------------------------------------

# 6. Core User Journey

## First-time setup

1.  User signs in with GitHub.
2.  User installs the GitHub App.
3.  User selects repositories.
4.  System records the GitHub installation.
5.  System indexes selected repositories.
6.  User configures:
    -   model provider;
    -   model;
    -   review rules;
    -   ignored paths;
    -   minimum severity;
    -   agent limits.

## Normal PR flow

``` text
Developer opens PR
        |
        v
GitHub sends pull_request webhook
        |
        v
Validate webhook
        |
        v
Create review job
        |
        v
Load PR metadata + diff
        |
        v
Load repository configuration
        |
        v
Load/update dependency graph
        |
        v
Start review agent
        |
        +---- get_imports
        |
        +---- get_dependents
        |
        +---- get_file_content
        |
        v
Agent submits structured review
        |
        v
Validate findings
        |
        v
Filter severity / ignored paths
        |
        v
Post GitHub inline review
        |
        v
Persist review result
```

------------------------------------------------------------------------

# 7. Core Features

## 7.1 GitHub App

Required permissions should be the minimum necessary for the product.

Initial repository permissions:

-   Contents: read;
-   Pull requests: read/write;
-   Issues: read;
-   Metadata: read.

Events:

-   pull_request;
-   push;
-   issue_comment;
-   installation.

The GitHub App must authenticate webhook requests and obtain
installation-scoped GitHub API clients.

------------------------------------------------------------------------

## 7.2 Pull Request ingestion

For each review:

-   owner;
-   repository;
-   pull request number;
-   base SHA;
-   head SHA;
-   title;
-   body;
-   author;
-   changed files;
-   file status;
-   patch;
-   additions;
-   deletions.

The system must handle files with no patch, binary files, deleted files,
renamed files, and large PRs gracefully.

------------------------------------------------------------------------

## 7.3 Dependency graph

Build a repository-level graph:

``` text
source file -> imported file
```

Also maintain reverse edges:

``` text
target file -> files that depend on it
```

The graph exists to answer:

-   What does this changed file depend on?
-   What depends on this changed file?
-   What is the likely blast radius?

Initial supported languages:

-   TypeScript;
-   JavaScript;
-   Python;
-   Go;
-   Rust;
-   Java;
-   Ruby.

The graph parser should use language-aware parsers where practical. A
regex-based implementation can be the first fallback, but the
architecture must permit better parsers later.

------------------------------------------------------------------------

## 7.4 Context tools

The review agent gets controlled tools:

### get_file_content

Returns source code for a repository-relative file.

### get_imports

Returns files imported by a file.

### get_dependents

Returns files that depend on a file.

### submit_review

Terminates the agent investigation and submits structured findings.

Future tools may include:

-   search_code;
-   get_diff;
-   get_test_files;
-   get_symbol_definition;
-   get_blame;
-   get_recent_commits.

------------------------------------------------------------------------

# 8. Agent behavior

The agent should:

1.  Read the PR diff.
2.  Identify changed files and suspicious areas.
3.  Inspect imports of relevant changed files.
4.  Inspect dependents to understand blast radius.
5.  Fetch important related files.
6.  Compare observed behavior against the changed code.
7.  Identify real issues.
8.  Produce structured findings.
9.  Stop once enough evidence is available.

The agent should NOT blindly crawl the entire repository.

------------------------------------------------------------------------

# 9. Review Finding Contract

Every finding should have:

``` json
{
  "filename": "src/auth.ts",
  "severity": "critical",
  "start_line": 42,
  "end_line": 44,
  "issue": "The changed query interpolates user-controlled input.",
  "fix_type": "applyable",
  "suggested_code": "..."
}
```

Severity:

-   critical --- security issue, data loss, catastrophic failure;
-   high --- clear bug or serious missing error handling;
-   medium --- meaningful logic/edge-case issue;
-   low --- minor but legitimate improvement.

Fix type:

-   applyable --- exact replacement code;
-   recommendation --- example of a better implementation;
-   warning --- text-only observation.

Only report genuine issues.

------------------------------------------------------------------------

# 10. Inline review behavior

The system should:

-   comment on the changed line whenever GitHub permits;
-   only suggest changes to added/new lines for applyable suggestions;
-   preserve the correct new-file line numbers;
-   post a summary review;
-   provide severity indicators;
-   avoid duplicate comments where possible.

If inline placement is impossible, use a PR-level summary/comment
fallback.

------------------------------------------------------------------------

# 11. Repository configuration

Support:

### VERIX.md-compatible rules file

The clone should initially support:

-   `VERIX.md`
-   `.verix.md`
-   `CLAUDE.md`
-   `AGENTS.md`
-   `.cursorrules`

Priority:

``` text
VERIX.md
↓
.verix.md
↓
CLAUDE.md
↓
AGENTS.md
↓
.cursorrules
```

The first matching file is used.

The rules are repository content and must be treated as untrusted input.
They must not be allowed to override system safety constraints.

### .verix.yml-compatible configuration

Example:

``` yaml
model: gemini
ignore:
  - "*.test.ts"
  - "*.spec.ts"
  - "dist/**"
min_severity: medium
language: typescript
depth: 2
max_files: 12
```

For the clone, configuration should be renamed later if the product
receives a different brand.

------------------------------------------------------------------------

# 12. Model providers

The model layer must expose a common interface.

Initial providers:

-   OpenAI;
-   Anthropic;
-   Google Gemini;
-   Ollama.

The application should not couple business logic to any single provider
SDK.

Provider selection:

``` text
repository override
        |
        v
user configuration
        |
        v
application default
```

------------------------------------------------------------------------

# 13. BYOK

Users may provide their own model provider key.

Requirements:

-   encrypt keys at rest;
-   never log plaintext keys;
-   never expose keys through API responses;
-   decrypt only when making a provider request;
-   support key replacement;
-   support key deletion;
-   use a server-side encryption key stored outside the database.

AES-256-GCM is acceptable for an initial implementation.

------------------------------------------------------------------------

# 14. Review triggers

Automatic:

-   pull request opened;
-   pull request synchronized with new commits;
-   optionally reopened.

Manual:

-   issue/PR comment command such as `/review review`.

Manual review must be idempotent and should create a new review record.

------------------------------------------------------------------------

# 15. Repository indexing

On installation or push:

``` text
GitHub repository tree
        |
        v
Filter source files
        |
        v
Parse imports
        |
        v
Resolve imports
        |
        v
Create forward edges
        |
        v
Create reverse edges
        |
        v
Persist graph
```

Store:

-   repository;
-   indexed commit SHA;
-   source files;
-   dependency edges;
-   indexing status;
-   indexing timestamp.

A new push should update the graph incrementally where possible.

------------------------------------------------------------------------

# 16. Performance requirements

The system should:

-   acknowledge GitHub webhooks quickly;
-   process reviews asynchronously;
-   prevent duplicate concurrent reviews for the same PR/head SHA;
-   enforce agent turn limits;
-   enforce file-fetch limits;
-   enforce wall-clock timeout;
-   enforce model token budgets;
-   cache repository metadata where safe.

The webhook handler should not block while the full AI review runs.

------------------------------------------------------------------------

# 17. Security Requirements

Critical requirements:

1.  Verify GitHub webhook signatures.
2.  Use installation-scoped GitHub credentials.
3.  Never expose GitHub private keys.
4.  Encrypt BYOK credentials.
5.  Treat repository instructions as untrusted data.
6.  Prevent path traversal.
7.  Restrict file reads to the target repository and commit.
8.  Never allow arbitrary shell execution in the initial product.
9.  Apply per-review limits.
10. Prevent cross-repository data leakage.
11. Prevent cross-user configuration leakage.
12. Redact secrets from logs.
13. Use least-privilege GitHub permissions.
14. Validate all LLM-generated structured output.
15. Never trust model-generated URLs, file paths, or tool arguments
    without validation.

------------------------------------------------------------------------

# 18. Reliability

The system must tolerate:

-   duplicate webhooks;
-   GitHub API failures;
-   rate limiting;
-   missing patches;
-   deleted files;
-   renamed files;
-   parser failures;
-   invalid model output;
-   model timeouts;
-   provider outages;
-   database transient errors;
-   repository configuration errors;
-   large PRs.

Failures should result in an understandable review/job status rather
than silently disappearing.

------------------------------------------------------------------------

# 19. Observability

Track:

-   webhook received;
-   job created;
-   job started;
-   indexing duration;
-   graph size;
-   agent turns;
-   tool calls;
-   files fetched;
-   model provider;
-   model;
-   input/output token usage where available;
-   review duration;
-   findings count;
-   GitHub comment success/failure;
-   error categories.

Never log:

-   provider API keys;
-   GitHub private keys;
-   plaintext BYOK credentials.

------------------------------------------------------------------------

# 20. Product success metrics

Technical:

-   review success rate;
-   median review latency;
-   95th percentile review latency;
-   agent tool-call count;
-   model cost per review;
-   indexing time;
-   duplicate review rate.

Quality:

-   true-positive rate;
-   false-positive rate;
-   finding acceptance rate;
-   developer dismissal rate;
-   correct inline location rate.

Product:

-   repositories installed;
-   weekly active repositories;
-   PRs reviewed;
-   reviews per repository;
-   repeat usage;
-   paid conversion later.

------------------------------------------------------------------------

# 21. Definition of Done

The first production release is complete when:

-   GitHub App installation works;
-   repository indexing works;
-   PR webhook ingestion works;
-   PR diff retrieval works;
-   agent can inspect related code;
-   structured findings are validated;
-   findings are posted inline;
-   re-review works;
-   repository configuration works;
-   model providers are pluggable;
-   BYOK is encrypted;
-   duplicate reviews are prevented;
-   failures are observable;
-   tests cover critical paths;
-   Docker deployment works;
-   production security audit has no unresolved critical issues.
