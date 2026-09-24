# Data Model: Coderexic

## 1. Rules
- **Database:** PostgreSQL, via Drizzle and drizzle-kit (a decision).
- **IDs:**
  - App entities use UUID primary keys.
  - GitHub IDs are external identifiers, never primary keys.
- **Migrations:**
  - Every schema change is a migration.
  - App startup never silently mutates the prod schema.
- **Timestamps:** `created_at`, `updated_at` and similar are `TIMESTAMPTZ`
  unless noted otherwise.
- **Notation:** `?` means nullable and `FK x` means a foreign key to `x`. PK is
  `id UUID` unless noted otherwise.

## 2. Relationships
```text
users ─< installations ─< repositories ─< {dependency_edges, repository_settings, review_jobs, index_runs}
review_jobs ─< reviews ─< review_findings
review_jobs ─< agent_runs ─< agent_tool_calls
users ─< model_credentials
```

## 3. Tables

### users
GitHub-authenticated users.

| Column | Type / notes |
| --- | --- |
| github_user_id | BIGINT UNIQUE NOT NULL |
| login | TEXT NOT NULL, indexed |
| display_name | |
| avatar_url | |
| email? | |
| created_at, updated_at, last_login_at | |

Never store OAuth tokens in plaintext.

### installations
A GitHub App installation, which has many repos.

| Column | Type / notes |
| --- | --- |
| github_installation_id | BIGINT UNIQUE NOT NULL |
| owner_type | |
| owner_login | |
| created_by_user_id | FK users |
| created_at, updated_at | |
| removed_at? | |

### repositories
| Column | Type / notes |
| --- | --- |
| installation_id | FK |
| github_repository_id | BIGINT NOT NULL |
| full_name | NOT NULL, indexed |
| owner_login | NOT NULL |
| name | NOT NULL |
| default_branch | |
| head_sha | |
| index_status | |
| indexed_sha? | |
| indexed_at? | |
| created_at, updated_at | |

UNIQUE(installation_id, github_repository_id).

### repository_settings
| Column | Type / notes |
| --- | --- |
| repository_id | UNIQUE, FK |
| model_provider? | |
| model_name? | |
| minimum_severity | default `'low'` |
| max_agent_turns | default 10 |
| max_file_fetches | default 12 |
| max_review_seconds | default 60 |
| max_context_tokens | INT |
| language_hint? | |
| created_at, updated_at | |

### repository_rules
| Column | Type / notes |
| --- | --- |
| repository_id | FK |
| source_filename | |
| content | |
| commit_sha | |
| loaded_at | |

Keep history only if auditing needs it. Otherwise keep just the latest
effective rules.

### ignore_patterns
| Column | Type / notes |
| --- | --- |
| repository_id | FK |
| pattern | NOT NULL |
| created_at | |

UNIQUE(repository_id, pattern).

### model_credentials
Never store raw keys.

| Column | Type / notes |
| --- | --- |
| user_id | FK |
| repository_id? | FK |
| provider | |
| encrypted_secret | NOT NULL |
| key_version | INT NOT NULL |
| created_at, updated_at | |
| deleted_at? | |

- **Precedence:** a repo credential overrides a user credential, which
  overrides the system credential.
- **Encryption:** AES-256-GCM. The master key comes from a secret manager or
  the environment, never from the DB.

### dependency_edges
| Column | Type / notes |
| --- | --- |
| repository_id | FK |
| source_path | NOT NULL |
| target_path | NOT NULL |
| commit_sha | NOT NULL |
| relation_type | default `'import'` |
| resolved | BOOL, default TRUE |
| created_at | |

- **PK:** (repository_id, source_path, target_path).
- **Indexes:** (repository_id, source_path) and (repository_id, target_path),
  which serve `get_imports` and `get_dependents`.

### indexed_files
Recommended for prod. Records which files are in the current graph.

| Column | Type / notes |
| --- | --- |
| repository_id | FK |
| path | NOT NULL |
| sha | |
| language | |
| size_bytes | BIGINT |
| is_supported | BOOL |
| last_indexed_at | |

UNIQUE(repository_id, path).

### index_runs
| Column | Type / notes |
| --- | --- |
| repository_id | FK |
| commit_sha | NOT NULL |
| status | `PENDING`, `RUNNING`, `SUCCEEDED` or `FAILED` |
| files_seen | INT |
| files_indexed | INT |
| edges_created | INT |
| duration_ms | BIGINT |
| error_message? | |
| started_at | |
| completed_at? | |

### review_jobs
Asynchronous review work.

| Column | Type / notes |
| --- | --- |
| repository_id | FK |
| installation_id | FK |
| pull_request_number | INT NOT NULL |
| head_sha | NOT NULL |
| base_sha | |
| trigger_type | |
| github_event_id? | |
| status | |
| attempt_count | default 0 |
| created_at | |
| started_at? | |
| completed_at? | |
| error_code? | |
| error_message? | |

- **Idempotency key:** (repository_id, pull_request_number, head_sha,
  trigger_type).
- If the same PR and head must be manually re-reviewed, use a separate
  idempotency table.

### reviews
| Column | Type / notes |
| --- | --- |
| review_job_id | UNIQUE, FK |
| provider | |
| model | |
| summary | |
| status | `RUNNING`, `SUCCEEDED`, `FAILED` or `TIMED_OUT` |
| files_considered | INT |
| files_fetched | INT |
| agent_turns | INT |
| tool_calls | INT |
| input_tokens? | BIGINT |
| output_tokens? | BIGINT |
| duration_ms | BIGINT |
| created_at | |

### review_findings
| Column | Type / notes |
| --- | --- |
| review_id | FK |
| filename | NOT NULL |
| severity | NOT NULL |
| start_line | INT NOT NULL |
| end_line | INT NOT NULL |
| issue | NOT NULL |
| fix_type | NOT NULL |
| suggested_code? | |
| confidence? | NUMERIC |
| github_comment_id? | BIGINT |
| published | BOOL, default FALSE |
| created_at | |

**CHECK constraints:**
- `severity IN ('critical','high','medium','low')`
- `fix_type IN ('applyable','recommendation','warning')`
- `start_line >= 1`
- `end_line >= start_line`

### agent_runs
| Column | Type / notes |
| --- | --- |
| review_id | FK |
| status | |
| turn_count | |
| file_fetch_count | |
| started_at | |
| completed_at? | |
| termination_reason? | `SUBMITTED`, `TIMEOUT`, `MAX_TURNS`, `MODEL_ERROR` or `VALIDATION_ERROR` |

### agent_tool_calls
| Column | Type / notes |
| --- | --- |
| agent_run_id | FK |
| turn_number | |
| tool_name | |
| arguments_json | JSONB |
| result_size_bytes | INT |
| duration_ms | BIGINT |
| status | |
| error_message? | |
| created_at | |

Never store secrets here. Don't store full source content unless that's
explicitly enabled.

### webhook_events
Required for prod idempotency: duplicate deliveries must not create
duplicate jobs.

| Column | Type / notes |
| --- | --- |
| github_event_id | UNIQUE NOT NULL |
| installation_id? | |
| event_name | NOT NULL |
| action? | |
| delivery_status | |
| received_at | |
| processed_at? | |

### audit_events
| Column | Type / notes |
| --- | --- |
| user_id? | |
| repository_id? | |
| event_type | NOT NULL |
| metadata | JSONB, never containing secrets |
| created_at | |

## 3a. Decisions made while implementing (Phase 2)
The schema lives in `packages/core/src/db/schema.ts`. Migrations are in
`packages/core/drizzle/`.

**Spec conflicts, resolved with the user:**
- `agent_runs` belongs to `reviews` (`review_id`), as the table says. The
  relationship diagram showed it under `review_jobs`.
- **Status values:**

  | Column | Values |
  | --- | --- |
  | `repositories.index_status` | `PENDING`, `INDEXING`, `READY`, `FAILED` |
  | `index_runs.status` | `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED` |
  | `review_jobs.status` | `PENDING`, `RUNNING`, `SUCCEEDED`, `FAILED`, `TIMED_OUT`, `CANCELLED` |
  | `agent_runs.termination_reason` | the full AI_AGENT_SPEC §14 list |

- `review_jobs.idempotency_key` (UNIQUE) replaces the unique constraint on
  (repo, PR, head, trigger), so a manual re-review can add a new job for the
  same commit:
  - automatic jobs use the key `automatic:<repo id>:<PR>:<head sha>`
  - manual jobs use `manual:<delivery id>`
- `trigger_type` is `automatic` or `manual`.
- `repository_rules`, `ignore_patterns` and `model_credentials` were built
  now, ahead of Phases 5 and 11.

**Additions to the spec:**
- `repositories.removed_at` allows soft removal, the same way installations
  are removed, so review history survives a deselected repo.
- Named status sets:
  - `reviews.status`
  - `agent_runs.status`: `RUNNING`, `SUCCEEDED`, `FAILED`, `TIMED_OUT`
  - `agent_tool_calls.status`: `SUCCEEDED`, `FAILED`, `REJECTED`
  - `webhook_events.delivery_status`: `RECEIVED`, `PROCESSED`, `IGNORED`,
    `FAILED`
- CHECK constraints enforce every status set, plus:
  - positive agent limits
  - `pull_request_number > 0`
  - `confidence` between 0 and 1
- `dependency_edges` has no separate (repo, source) index, because its
  primary key already begins with those columns.

**`ON DELETE` rules:**
- **Cascade:** the rows under a repository, and everything under a review job.
- **Set null:** `installations.created_by_user_id`,
  `webhook_events.installation_id`, `audit_events.user_id` and
  `audit_events.repository_id`.
- **Cascade from the user:** `model_credentials`.

## 4. Retention
| Data | Kept for |
| --- | --- |
| Webhook events | 30–90 days |
| Agent tool metadata | 30 days |
| Reviews | per the product plan |
| Source code | not permanently, unless necessary |
| Encrypted keys | until the user deletes them |

Prefer fetching source from GitHub at the needed commit over building a
source warehouse.

## 5. Transactions
**Use a transaction for:**
- installation removal
- creating a repo together with its settings
- creating a review together with its idempotency record
- completing a review together with persisting its findings

**Never hold a transaction open during** LLM calls, GitHub calls or indexing.

## 6. Isolation
Scope every repo-data query by repository ID. `repository_id`,
`installation_id` and `user_id` always come from the server-side context,
never from LLM tool arguments.

## 7. Future tables (only when needed)
`organizations`, `organization_members`, `subscriptions`, `usage_events`,
`billing_accounts`, `evaluation_cases`, `evaluation_runs`.

No billing tables before billing exists.
