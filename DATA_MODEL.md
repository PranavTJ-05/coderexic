# Data Model --- Context-Aware Agentic GitHub Code Review Platform

## 1. Database

Use PostgreSQL.

Use UUID primary keys for application entities.

Use GitHub IDs as external identifiers, not as internal primary keys.

All schema changes must be migrations.

Never rely on application startup to silently mutate production schema.

------------------------------------------------------------------------

# 2. Entity Relationship Overview

``` text
users
  |
  +----< installations
             |
             +----< repositories
                       |
                       +----< dependency_edges
                       |
                       +----< repository_settings
                       |
                       +----< review_jobs
                                  |
                                  +----< reviews
                                             |
                                             +----< review_findings

users
  |
  +----< model_credentials

repositories
  |
  +----< index_runs

review_jobs
  |
  +----< agent_runs
             |
             +----< agent_tool_calls
```

------------------------------------------------------------------------

# 3. users

Purpose: GitHub-authenticated product users.

Columns:

``` text
id                  UUID PK
github_user_id      BIGINT UNIQUE NOT NULL
login               TEXT NOT NULL
display_name        TEXT
avatar_url          TEXT
email               TEXT NULL
created_at          TIMESTAMPTZ
updated_at          TIMESTAMPTZ
last_login_at       TIMESTAMPTZ
```

Indexes:

``` text
github_user_id UNIQUE
login
```

Do not store GitHub OAuth access tokens in plaintext.

------------------------------------------------------------------------

# 4. installations

Represents a GitHub App installation.

``` text
id                  UUID PK
github_installation_id BIGINT UNIQUE NOT NULL
owner_type          TEXT
owner_login         TEXT
created_by_user_id  UUID FK users
created_at          TIMESTAMPTZ
updated_at          TIMESTAMPTZ
removed_at          TIMESTAMPTZ NULL
```

An installation may contain many repositories.

------------------------------------------------------------------------

# 5. repositories

``` text
id                  UUID PK
installation_id     UUID FK installations
github_repository_id BIGINT NOT NULL
full_name           TEXT NOT NULL
owner_login         TEXT NOT NULL
name                TEXT NOT NULL
default_branch      TEXT
head_sha            TEXT
index_status        TEXT
indexed_sha         TEXT NULL
indexed_at          TIMESTAMPTZ NULL
created_at          TIMESTAMPTZ
updated_at          TIMESTAMPTZ
```

Unique:

``` text
installation_id + github_repository_id
```

Index:

``` text
full_name
```

------------------------------------------------------------------------

# 6. repository_settings

``` text
id                  UUID PK
repository_id       UUID UNIQUE FK repositories
model_provider      TEXT NULL
model_name          TEXT NULL
minimum_severity    TEXT DEFAULT 'low'
max_agent_turns     INTEGER DEFAULT 10
max_file_fetches    INTEGER DEFAULT 12
max_review_seconds  INTEGER DEFAULT 60
max_context_tokens  INTEGER
language_hint       TEXT NULL
created_at          TIMESTAMPTZ
updated_at          TIMESTAMPTZ
```

------------------------------------------------------------------------

# 7. repository_rules

``` text
id                  UUID PK
repository_id       UUID FK repositories
source_filename     TEXT
content             TEXT
commit_sha          TEXT
loaded_at           TIMESTAMPTZ
```

Keep historical rule records only if auditability is needed.

Otherwise retain the latest effective rules.

------------------------------------------------------------------------

# 8. ignore_patterns

``` text
id                  UUID PK
repository_id       UUID FK repositories
pattern             TEXT NOT NULL
created_at          TIMESTAMPTZ
```

Unique:

``` text
repository_id + pattern
```

------------------------------------------------------------------------

# 9. model_credentials

Never store raw provider keys.

``` text
id                  UUID PK
user_id             UUID FK users
repository_id       UUID NULL FK repositories
provider            TEXT
encrypted_secret    TEXT NOT NULL
key_version         INTEGER NOT NULL
created_at          TIMESTAMPTZ
updated_at          TIMESTAMPTZ
deleted_at          TIMESTAMPTZ NULL
```

Scope rules:

``` text
repository-specific credential
    overrides
user credential
    overrides
system credential
```

Encryption:

``` text
AES-256-GCM
```

The encryption master key must come from a secret manager/environment,
never from the database.

------------------------------------------------------------------------

# 10. dependency_edges

``` text
repository_id       UUID FK repositories
source_path         TEXT NOT NULL
target_path         TEXT NOT NULL
commit_sha          TEXT NOT NULL
relation_type       TEXT DEFAULT 'import'
resolved            BOOLEAN DEFAULT TRUE
created_at          TIMESTAMPTZ
```

Primary key:

``` text
repository_id + source_path + target_path
```

Indexes:

``` text
repository_id + source_path
repository_id + target_path
```

This supports:

``` text
get_imports(source)
get_dependents(target)
```

------------------------------------------------------------------------

# 11. indexed_files

Recommended for the production version.

``` text
id                  UUID PK
repository_id       UUID FK repositories
path                TEXT NOT NULL
sha                 TEXT
language            TEXT
size_bytes          BIGINT
is_supported        BOOLEAN
last_indexed_at     TIMESTAMPTZ
```

Unique:

``` text
repository_id + path
```

This permits the system to know which files are part of the current
graph.

------------------------------------------------------------------------

# 12. index_runs

``` text
id                  UUID PK
repository_id       UUID FK repositories
commit_sha          TEXT NOT NULL
status              TEXT
files_seen          INTEGER
files_indexed       INTEGER
edges_created       INTEGER
duration_ms         BIGINT
error_message       TEXT NULL
started_at          TIMESTAMPTZ
completed_at        TIMESTAMPTZ NULL
```

Status:

``` text
PENDING
RUNNING
SUCCEEDED
FAILED
```

------------------------------------------------------------------------

# 13. review_jobs

Represents asynchronous review work.

``` text
id                  UUID PK
repository_id       UUID FK repositories
installation_id     UUID FK installations
pull_request_number INTEGER NOT NULL
head_sha            TEXT NOT NULL
base_sha            TEXT
trigger_type        TEXT
github_event_id     TEXT NULL
status              TEXT
attempt_count       INTEGER DEFAULT 0
created_at          TIMESTAMPTZ
started_at          TIMESTAMPTZ NULL
completed_at        TIMESTAMPTZ NULL
error_code          TEXT NULL
error_message       TEXT NULL
```

Idempotency:

``` text
repository_id + pull_request_number + head_sha + trigger_type
```

Use a separate unique/idempotency table if the same PR/head must be
manually re-reviewed.

------------------------------------------------------------------------

# 14. reviews

``` text
id                  UUID PK
review_job_id       UUID UNIQUE FK review_jobs
provider            TEXT
model               TEXT
summary             TEXT
status              TEXT
files_considered    INTEGER
files_fetched       INTEGER
agent_turns         INTEGER
tool_calls          INTEGER
input_tokens        BIGINT NULL
output_tokens       BIGINT NULL
duration_ms         BIGINT
created_at          TIMESTAMPTZ
```

Status:

``` text
RUNNING
SUCCEEDED
FAILED
TIMED_OUT
```

------------------------------------------------------------------------

# 15. review_findings

``` text
id                  UUID PK
review_id           UUID FK reviews
filename            TEXT NOT NULL
severity            TEXT NOT NULL
start_line          INTEGER NOT NULL
end_line            INTEGER NOT NULL
issue               TEXT NOT NULL
fix_type            TEXT NOT NULL
suggested_code      TEXT NULL
confidence          NUMERIC NULL
github_comment_id   BIGINT NULL
published           BOOLEAN DEFAULT FALSE
created_at          TIMESTAMPTZ
```

Constraints:

``` text
severity IN ('critical','high','medium','low')
fix_type IN ('applyable','recommendation','warning')
start_line >= 1
end_line >= start_line
```

------------------------------------------------------------------------

# 16. agent_runs

``` text
id                  UUID PK
review_id           UUID FK reviews
status              TEXT
turn_count          INTEGER
file_fetch_count    INTEGER
started_at          TIMESTAMPTZ
completed_at        TIMESTAMPTZ NULL
termination_reason  TEXT NULL
```

Termination reasons:

``` text
SUBMITTED
TIMEOUT
MAX_TURNS
MODEL_ERROR
VALIDATION_ERROR
```

------------------------------------------------------------------------

# 17. agent_tool_calls

``` text
id                  UUID PK
agent_run_id        UUID FK agent_runs
turn_number         INTEGER
tool_name           TEXT
arguments_json      JSONB
result_size_bytes   INTEGER
duration_ms         BIGINT
status              TEXT
error_message       TEXT NULL
created_at          TIMESTAMPTZ
```

Do not store secrets in arguments or results.

Potentially sensitive source-code content should not be stored in full
unless explicitly enabled.

------------------------------------------------------------------------

# 18. webhook_events

Required for production idempotency.

``` text
id                  UUID PK
github_event_id     TEXT UNIQUE NOT NULL
installation_id     UUID NULL
event_name          TEXT NOT NULL
action              TEXT NULL
delivery_status     TEXT
received_at         TIMESTAMPTZ
processed_at        TIMESTAMPTZ NULL
```

This prevents duplicate GitHub deliveries from creating duplicate jobs.

------------------------------------------------------------------------

# 19. audit_events

``` text
id                  UUID PK
user_id             UUID NULL
repository_id       UUID NULL
event_type          TEXT NOT NULL
metadata            JSONB
created_at          TIMESTAMPTZ
```

Never store secrets in metadata.

------------------------------------------------------------------------

# 20. Data retention

Default:

-   webhook events: 30--90 days;
-   agent tool metadata: 30 days;
-   review records: retained according to product plan;
-   source code: do not permanently store unless explicitly necessary;
-   encrypted API keys: until user deletes them.

The system should prefer fetching source code from GitHub at the
required commit instead of building a permanent source-code warehouse.

------------------------------------------------------------------------

# 21. Transaction Rules

Use transactions for:

-   installation removal;
-   repository creation + settings;
-   review creation + idempotency;
-   review completion + finding persistence.

Do not hold a database transaction open during:

-   LLM requests;
-   GitHub API requests;
-   repository indexing.

------------------------------------------------------------------------

# 22. Data isolation

Every query involving repository data must be scoped by repository ID.

Never trust:

`text repository_id installation_id user_id`

from LLM tool arguments.

Those values must come from server-side execution context.

------------------------------------------------------------------------

# 23. Future tables

Only add these when required:

``` text
organizations
organization_members
subscriptions
usage_events
billing_accounts
evaluation_cases
evaluation_runs
```

Do not add billing tables before billing exists.
