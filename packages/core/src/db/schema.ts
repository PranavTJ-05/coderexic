/**
 * Postgres schema (DATA_MODEL.md). drizzle-kit reads this file to generate
 * SQL migrations in packages/core/drizzle/, so it only imports drizzle-orm.
 *
 * Conventions:
 * - UUID primary keys; GitHub IDs are external identifiers (BIGINT, fit in a JS number).
 * - Status and enum-like columns are TEXT with CHECK constraints, which are
 *   cheaper to evolve than Postgres enums.
 * - Rows owned by a repository cascade when it is deleted. Installations and
 *   repositories are normally soft-removed (`removed_at`) to keep history.
 */
import { sql, type SQL } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export const FIX_TYPES = ['applyable', 'recommendation', 'warning'] as const;
export const INDEX_STATUSES = ['PENDING', 'INDEXING', 'READY', 'FAILED'] as const;
export const INDEX_RUN_STATUSES = ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED'] as const;
export const REVIEW_JOB_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
] as const;
export const REVIEW_TRIGGERS = ['automatic', 'manual'] as const;
export const REVIEW_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT'] as const;
export const AGENT_RUN_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT'] as const;
export const AGENT_TERMINATION_REASONS = [
  'SUBMITTED',
  'NO_FINDINGS',
  'MAX_TURNS',
  'MAX_FILE_FETCHES',
  'TIMEOUT',
  'MODEL_ERROR',
  'INVALID_OUTPUT',
] as const;
export const TOOL_CALL_STATUSES = ['SUCCEEDED', 'FAILED', 'REJECTED'] as const;
export const WEBHOOK_DELIVERY_STATUSES = ['RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED'] as const;

export type Severity = (typeof SEVERITIES)[number];
export type FixType = (typeof FIX_TYPES)[number];
export type IndexStatus = (typeof INDEX_STATUSES)[number];
export type IndexRunStatus = (typeof INDEX_RUN_STATUSES)[number];
export type ReviewJobStatus = (typeof REVIEW_JOB_STATUSES)[number];
export type ReviewTrigger = (typeof REVIEW_TRIGGERS)[number];
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];
export type AgentTerminationReason = (typeof AGENT_TERMINATION_REASONS)[number];
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/** `column IN ('a','b')`, built from one of the value lists above. */
function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  return sql`${column} IN (${sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `,
  )})`;
}

const id = () => uuid('id').primaryKey().defaultRandom();
const githubId = (name: string) => bigint(name, { mode: 'number' });
const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => timestamptz('created_at').notNull().defaultNow();
const updatedAt = () =>
  timestamptz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const users = pgTable(
  'users',
  {
    id: id(),
    githubUserId: githubId('github_user_id').notNull().unique(),
    login: text('login').notNull(),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),
    email: text('email'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastLoginAt: timestamptz('last_login_at'),
  },
  (t) => [index('users_login_idx').on(t.login)],
);

export const installations = pgTable('installations', {
  id: id(),
  githubInstallationId: githubId('github_installation_id').notNull().unique(),
  ownerType: text('owner_type').notNull(),
  ownerLogin: text('owner_login').notNull(),
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  removedAt: timestamptz('removed_at'),
});

export const repositories = pgTable(
  'repositories',
  {
    id: id(),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => installations.id, { onDelete: 'cascade' }),
    githubRepositoryId: githubId('github_repository_id').notNull(),
    fullName: text('full_name').notNull(),
    ownerLogin: text('owner_login').notNull(),
    name: text('name').notNull(),
    defaultBranch: text('default_branch'),
    headSha: text('head_sha'),
    indexStatus: text('index_status').$type<IndexStatus>().notNull().default('PENDING'),
    indexedSha: text('indexed_sha'),
    indexedAt: timestamptz('indexed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    removedAt: timestamptz('removed_at'),
  },
  (t) => [
    unique('repositories_installation_github_repo_uq').on(t.installationId, t.githubRepositoryId),
    index('repositories_full_name_idx').on(t.fullName),
    check('repositories_index_status_ck', oneOf(t.indexStatus, INDEX_STATUSES)),
  ],
);

export const repositorySettings = pgTable(
  'repository_settings',
  {
    id: id(),
    repositoryId: uuid('repository_id')
      .notNull()
      .unique()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    modelProvider: text('model_provider'),
    modelName: text('model_name'),
    minimumSeverity: text('minimum_severity').$type<Severity>().notNull().default('low'),
    maxAgentTurns: integer('max_agent_turns').notNull().default(10),
    maxFileFetches: integer('max_file_fetches').notNull().default(12),
    maxReviewSeconds: integer('max_review_seconds').notNull().default(60),
    maxContextTokens: integer('max_context_tokens'),
    languageHint: text('language_hint'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('repository_settings_minimum_severity_ck', oneOf(t.minimumSeverity, SEVERITIES)),
    check(
      'repository_settings_limits_ck',
      sql`${t.maxAgentTurns} > 0 AND ${t.maxFileFetches} >= 0 AND ${t.maxReviewSeconds} > 0`,
    ),
  ],
);

export const repositoryRules = pgTable(
  'repository_rules',
  {
    id: id(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    sourceFilename: text('source_filename').notNull(),
    content: text('content').notNull(),
    commitSha: text('commit_sha').notNull(),
    loadedAt: timestamptz('loaded_at').notNull().defaultNow(),
  },
  (t) => [index('repository_rules_repository_idx').on(t.repositoryId)],
);

export const ignorePatterns = pgTable(
  'ignore_patterns',
  {
    id: id(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    pattern: text('pattern').notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique('ignore_patterns_repository_pattern_uq').on(t.repositoryId, t.pattern)],
);

/** Encrypted BYOK keys (Phase 11). Plaintext never reaches this table. */
export const modelCredentials = pgTable(
  'model_credentials',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repositoryId: uuid('repository_id').references(() => repositories.id, {
      onDelete: 'cascade',
    }),
    provider: text('provider').notNull(),
    encryptedSecret: text('encrypted_secret').notNull(),
    keyVersion: integer('key_version').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamptz('deleted_at'),
  },
  (t) => [
    index('model_credentials_user_idx').on(t.userId),
    // One live credential per (user, repository, provider): repositoryId is
    // nullable for a user-level (non-repo-scoped) credential, so this needs
    // NULLS NOT DISTINCT (drizzle-kit's `uniqueIndex` builder has no method
    // for that yet - hand-added to the generated migration SQL instead; see
    // the migration file's comment). Scoped to `deleted_at is null` so a
    // soft-deleted row (replace/delete both soft-delete) never blocks a
    // fresh credential for the same tuple.
    uniqueIndex('model_credentials_live_unique_idx')
      .on(t.userId, t.repositoryId, t.provider)
      .where(sql`${t.deletedAt} is null`),
    // A repo-scoped credential (repository_id set) is shared by the whole
    // repo regardless of which user added it, so it needs its own
    // exclusivity: without this, two different users could each hold a
    // live repo-scoped credential for the same (repository, provider), and
    // which one resolveDecryptedCredential's repo-tier lookup returns would
    // be arbitrary. No NULLS NOT DISTINCT needed here - the WHERE clause
    // already excludes every null repository_id.
    uniqueIndex('model_credentials_live_repo_unique_idx')
      .on(t.repositoryId, t.provider)
      .where(sql`${t.repositoryId} is not null and ${t.deletedAt} is null`),
  ],
);

/** Primary key (repository, source, target) also serves get_imports lookups. */
export const dependencyEdges = pgTable(
  'dependency_edges',
  {
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    sourcePath: text('source_path').notNull(),
    targetPath: text('target_path').notNull(),
    commitSha: text('commit_sha').notNull(),
    relationType: text('relation_type').notNull().default('import'),
    resolved: boolean('resolved').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({
      name: 'dependency_edges_pk',
      columns: [t.repositoryId, t.sourcePath, t.targetPath],
    }),
    index('dependency_edges_target_idx').on(t.repositoryId, t.targetPath),
  ],
);

export const indexedFiles = pgTable(
  'indexed_files',
  {
    id: id(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    sha: text('sha'),
    language: text('language'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    isSupported: boolean('is_supported').notNull().default(false),
    lastIndexedAt: timestamptz('last_indexed_at'),
  },
  (t) => [unique('indexed_files_repository_path_uq').on(t.repositoryId, t.path)],
);

export const indexRuns = pgTable(
  'index_runs',
  {
    id: id(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    commitSha: text('commit_sha').notNull(),
    status: text('status').$type<IndexRunStatus>().notNull().default('PENDING'),
    filesSeen: integer('files_seen').notNull().default(0),
    filesIndexed: integer('files_indexed').notNull().default(0),
    edgesCreated: integer('edges_created').notNull().default(0),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    errorMessage: text('error_message'),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    completedAt: timestamptz('completed_at'),
  },
  (t) => [
    index('index_runs_repository_started_idx').on(t.repositoryId, t.startedAt),
    check('index_runs_status_ck', oneOf(t.status, INDEX_RUN_STATUSES)),
  ],
);

/**
 * `idempotency_key` replaces the spec's (repo, PR, head, trigger) uniqueness
 * so a manual re-review of the same commit can create a new job:
 * automatic jobs key on repo + PR + head SHA, manual jobs on the comment event.
 */
export const reviewJobs = pgTable(
  'review_jobs',
  {
    id: id(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => installations.id, { onDelete: 'cascade' }),
    pullRequestNumber: integer('pull_request_number').notNull(),
    headSha: text('head_sha').notNull(),
    baseSha: text('base_sha'),
    triggerType: text('trigger_type').$type<ReviewTrigger>().notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    githubEventId: text('github_event_id'),
    status: text('status').$type<ReviewJobStatus>().notNull().default('PENDING'),
    attemptCount: integer('attempt_count').notNull().default(0),
    createdAt: createdAt(),
    startedAt: timestamptz('started_at'),
    completedAt: timestamptz('completed_at'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
  },
  (t) => [
    index('review_jobs_repository_pr_idx').on(t.repositoryId, t.pullRequestNumber),
    index('review_jobs_status_idx').on(t.status),
    check('review_jobs_status_ck', oneOf(t.status, REVIEW_JOB_STATUSES)),
    check('review_jobs_trigger_type_ck', oneOf(t.triggerType, REVIEW_TRIGGERS)),
    check('review_jobs_pull_request_number_ck', sql`${t.pullRequestNumber} > 0`),
  ],
);

export const reviews = pgTable(
  'reviews',
  {
    id: id(),
    reviewJobId: uuid('review_job_id')
      .notNull()
      .unique()
      .references(() => reviewJobs.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    summary: text('summary'),
    status: text('status').$type<ReviewStatus>().notNull().default('RUNNING'),
    filesConsidered: integer('files_considered').notNull().default(0),
    filesFetched: integer('files_fetched').notNull().default(0),
    agentTurns: integer('agent_turns').notNull().default(0),
    toolCalls: integer('tool_calls').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }),
    outputTokens: bigint('output_tokens', { mode: 'number' }),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    createdAt: createdAt(),
  },
  (t) => [check('reviews_status_ck', oneOf(t.status, REVIEW_STATUSES))],
);

export const reviewFindings = pgTable(
  'review_findings',
  {
    id: id(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    severity: text('severity').$type<Severity>().notNull(),
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
    issue: text('issue').notNull(),
    fixType: text('fix_type').$type<FixType>().notNull(),
    suggestedCode: text('suggested_code'),
    confidence: numeric('confidence', { mode: 'number' }),
    githubCommentId: githubId('github_comment_id'),
    published: boolean('published').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('review_findings_review_idx').on(t.reviewId),
    check('review_findings_severity_ck', oneOf(t.severity, SEVERITIES)),
    check('review_findings_fix_type_ck', oneOf(t.fixType, FIX_TYPES)),
    check('review_findings_lines_ck', sql`${t.startLine} >= 1 AND ${t.endLine} >= ${t.startLine}`),
    check(
      'review_findings_confidence_ck',
      sql`${t.confidence} IS NULL OR (${t.confidence} >= 0 AND ${t.confidence} <= 1)`,
    ),
  ],
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: id(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    status: text('status').$type<AgentRunStatus>().notNull().default('RUNNING'),
    turnCount: integer('turn_count').notNull().default(0),
    fileFetchCount: integer('file_fetch_count').notNull().default(0),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    completedAt: timestamptz('completed_at'),
    terminationReason: text('termination_reason').$type<AgentTerminationReason>(),
  },
  (t) => [
    index('agent_runs_review_idx').on(t.reviewId),
    check('agent_runs_status_ck', oneOf(t.status, AGENT_RUN_STATUSES)),
    check(
      'agent_runs_termination_reason_ck',
      sql`${t.terminationReason} IS NULL OR ${oneOf(t.terminationReason, AGENT_TERMINATION_REASONS)}`,
    ),
  ],
);

/** Tool call metadata only: never secrets, and no full source content by default. */
export const agentToolCalls = pgTable(
  'agent_tool_calls',
  {
    id: id(),
    agentRunId: uuid('agent_run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    turnNumber: integer('turn_number').notNull(),
    toolName: text('tool_name').notNull(),
    argumentsJson: jsonb('arguments_json').notNull(),
    resultSizeBytes: integer('result_size_bytes'),
    durationMs: bigint('duration_ms', { mode: 'number' }),
    status: text('status').$type<ToolCallStatus>().notNull(),
    errorMessage: text('error_message'),
    createdAt: createdAt(),
  },
  (t) => [
    index('agent_tool_calls_run_idx').on(t.agentRunId),
    check('agent_tool_calls_status_ck', oneOf(t.status, TOOL_CALL_STATUSES)),
  ],
);

/** One row per GitHub delivery (X-GitHub-Delivery); the unique key drops redeliveries. */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: id(),
    githubEventId: text('github_event_id').notNull().unique(),
    installationId: uuid('installation_id').references(() => installations.id, {
      onDelete: 'set null',
    }),
    eventName: text('event_name').notNull(),
    action: text('action'),
    deliveryStatus: text('delivery_status')
      .$type<WebhookDeliveryStatus>()
      .notNull()
      .default('RECEIVED'),
    receivedAt: timestamptz('received_at').notNull().defaultNow(),
    processedAt: timestamptz('processed_at'),
  },
  (t) => [
    index('webhook_events_received_idx').on(t.receivedAt),
    check('webhook_events_delivery_status_ck', oneOf(t.deliveryStatus, WEBHOOK_DELIVERY_STATUSES)),
  ],
);

/** Metadata must never contain secrets. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    repositoryId: uuid('repository_id').references(() => repositories.id, {
      onDelete: 'set null',
    }),
    eventType: text('event_type').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('audit_events_created_idx').on(t.createdAt)],
);
