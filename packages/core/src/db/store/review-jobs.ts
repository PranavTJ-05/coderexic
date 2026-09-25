import { and, desc, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm';
import type { Executor } from '../client.js';
import {
  reviewFindings,
  reviewJobs,
  reviews,
  type ReviewJobStatus,
  type ReviewStatus,
  type ReviewTrigger,
} from '../schema.js';

/** One row of `listReviewJobsForRepository` - the dashboard/review-history read model. */
export interface ReviewJobSummary {
  job: ReviewJob;
  review: Review | null;
  findingsCount: number;
}

export type ReviewJob = typeof reviewJobs.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type ReviewFinding = typeof reviewFindings.$inferSelect;
export type NewReviewFinding = Omit<
  typeof reviewFindings.$inferInsert,
  'id' | 'reviewId' | 'createdAt'
>;

/**
 * Placeholder `head_sha` for a manual review job at creation time: the
 * webhook handler that creates it (`issue_comment`) never calls the GitHub
 * API (webhook handlers only write to the database), so the real head sha
 * isn't known yet. The worker overwrites it via `updateReviewJobHeadSha`
 * once it fetches the pull request.
 */
export const ZERO_SHA = '0'.repeat(40);

/** One automatic review per repository, pull request and head commit. */
export function automaticReviewKey(
  repositoryId: string,
  pullRequestNumber: number,
  headSha: string,
): string {
  return `automatic:${repositoryId}:${pullRequestNumber}:${headSha}`;
}

/** One manual review per triggering GitHub delivery. */
export function manualReviewKey(githubEventId: string): string {
  return `manual:${githubEventId}`;
}

/** An idempotency key was reused for a different pull request or commit. */
export class IdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`review job idempotency key reused for a different job: ${idempotencyKey}`);
    this.name = 'IdempotencyConflictError';
  }
}

export interface ReviewJobInput {
  repositoryId: string;
  installationId: string;
  pullRequestNumber: number;
  headSha: string;
  baseSha?: string | null;
  triggerType: ReviewTrigger;
  idempotencyKey: string;
  githubEventId?: string | null;
}

/**
 * Inserts a review job unless one with the same idempotency key exists.
 * Returns the stored job and whether this call created it. Throws
 * IdempotencyConflictError if the existing job has a different identity.
 */
export async function createReviewJob(
  db: Executor,
  input: ReviewJobInput,
): Promise<{ job: ReviewJob; created: boolean }> {
  const { baseSha, githubEventId, ...rest } = input;
  const values = {
    ...rest,
    ...(baseSha !== undefined && { baseSha }),
    ...(githubEventId !== undefined && { githubEventId }),
  };
  const [inserted] = await db.insert(reviewJobs).values(values).onConflictDoNothing().returning();
  if (inserted) return { job: inserted, created: true };
  const [existing] = await db
    .select()
    .from(reviewJobs)
    .where(eq(reviewJobs.idempotencyKey, input.idempotencyKey));
  if (!existing) throw new Error('createReviewJob: conflicting job not found');
  const sameIdentity =
    existing.repositoryId === input.repositoryId &&
    existing.installationId === input.installationId &&
    existing.pullRequestNumber === input.pullRequestNumber &&
    existing.headSha === input.headSha &&
    existing.triggerType === input.triggerType;
  if (!sameIdentity) throw new IdempotencyConflictError(input.idempotencyKey);
  return { job: existing, created: false };
}

/**
 * Atomically marks a PENDING job RUNNING and bumps its attempt count.
 * Returns undefined if another worker already claimed it (or it was not
 * PENDING), so exactly one worker ever processes a given attempt.
 */
export async function claimReviewJob(
  db: Executor,
  reviewJobId: string,
): Promise<ReviewJob | undefined> {
  const [row] = await db
    .update(reviewJobs)
    .set({
      status: 'RUNNING',
      attemptCount: sql`${reviewJobs.attemptCount} + 1`,
      startedAt: new Date(),
    })
    .where(and(eq(reviewJobs.id, reviewJobId), eq(reviewJobs.status, 'PENDING')))
    .returning();
  return row;
}

export async function findReviewJobById(db: Executor, id: string): Promise<ReviewJob | undefined> {
  const [row] = await db.select().from(reviewJobs).where(eq(reviewJobs.id, id));
  return row;
}

/**
 * Generous upper bound on "a review might still be in flight", for
 * `findActiveReviewJob` below - well past any realistic `maxReviewSeconds`
 * ceiling, so a row a crashed worker never reached a terminal status for
 * doesn't block re-review on that PR forever. The worker itself always
 * reaches a terminal status on every non-crash path (see pipeline.ts).
 */
export const ACTIVE_JOB_WINDOW_MS = 30 * 60 * 1000;

/**
 * A PENDING or RUNNING job for this (repository, PR) - optionally narrowed
 * to a specific head sha, and excluding a given job id - created more
 * recently than `since`. Implements PRODUCT_SPEC.md §16's "no duplicate
 * concurrent reviews for the same PR and head SHA" for two cases the
 * per-head-sha idempotency key alone doesn't cover:
 *
 * 1. A manual command must not start a second review while one is already
 *    in flight for the same PR (checked with no `headSha`, before the
 *    manual job's own placeholder sha is resolved).
 * 2. A manual job and an automatic job can race to the same real head sha
 *    (comment, then push, before the comment's job claims) - each job
 *    checks for the other (with `headSha` and `excludeId: <its own id>`)
 *    once its own head sha is known, and whichever loses cancels itself.
 */
export async function findActiveReviewJob(
  db: Executor,
  repositoryId: string,
  pullRequestNumber: number,
  since: Date,
  options: { headSha?: string; excludeId?: string } = {},
): Promise<ReviewJob | undefined> {
  const conditions = [
    eq(reviewJobs.repositoryId, repositoryId),
    eq(reviewJobs.pullRequestNumber, pullRequestNumber),
    inArray(reviewJobs.status, ['PENDING', 'RUNNING']),
    gt(reviewJobs.createdAt, since),
  ];
  if (options.headSha !== undefined) conditions.push(eq(reviewJobs.headSha, options.headSha));
  if (options.excludeId !== undefined) conditions.push(ne(reviewJobs.id, options.excludeId));
  const [row] = await db
    .select()
    .from(reviewJobs)
    .where(and(...conditions));
  return row;
}

/**
 * Overwrites a job's head/base sha once the worker has actually fetched the
 * pull request - needed for a manual trigger, whose row is created with a
 * placeholder sha (the webhook handler that creates it never calls the
 * GitHub API; see `ZERO_SHA` in `apps/worker/src/review/pipeline.ts`).
 */
export async function updateReviewJobHeadSha(
  db: Executor,
  reviewJobId: string,
  headSha: string,
  baseSha: string,
): Promise<void> {
  await db.update(reviewJobs).set({ headSha, baseSha }).where(eq(reviewJobs.id, reviewJobId));
}

/** PENDING jobs older than `olderThan`, for the worker's stale-job sweep. */
export async function findStalePendingReviewJobs(
  db: Executor,
  olderThan: Date,
  limit = 50,
): Promise<ReviewJob[]> {
  return db
    .select()
    .from(reviewJobs)
    .where(and(eq(reviewJobs.status, 'PENDING'), lt(reviewJobs.createdAt, olderThan)))
    .limit(limit);
}

/**
 * Marks a job FAILED or TIMED_OUT with no review record, for failures before
 * any review data exists to persist (e.g. the PR or repository could not be
 * fetched). When review data exists, use completeReview instead.
 */
export async function failReviewJob(
  db: Executor,
  reviewJobId: string,
  status: Extract<ReviewJobStatus, 'FAILED' | 'TIMED_OUT'>,
  errorCode: string,
  errorMessage?: string,
): Promise<void> {
  await db
    .update(reviewJobs)
    .set({
      status,
      errorCode,
      ...(errorMessage !== undefined && { errorMessage }),
      completedAt: new Date(),
    })
    .where(eq(reviewJobs.id, reviewJobId));
}

/**
 * Marks a job CANCELLED with no review record: a legitimate skip rather
 * than a failure (e.g. the pull request turned into a draft before the
 * worker got to it).
 */
export async function cancelReviewJob(
  db: Executor,
  reviewJobId: string,
  reason: string,
): Promise<void> {
  await db
    .update(reviewJobs)
    .set({ status: 'CANCELLED', errorCode: reason, completedAt: new Date() })
    .where(eq(reviewJobs.id, reviewJobId));
}

export interface CompleteReviewInput {
  reviewJobId: string;
  jobStatus: Extract<ReviewJobStatus, 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT'>;
  review: Omit<typeof reviews.$inferInsert, 'id' | 'reviewJobId' | 'createdAt' | 'status'> & {
    status: Exclude<ReviewStatus, 'RUNNING'>;
  };
  findings: readonly NewReviewFinding[];
  errorCode?: string;
  errorMessage?: string;
  completedAt?: Date;
}

/**
 * Persists a finished review, its findings and the job's final status in one
 * transaction, so a failure never leaves findings without a completed job.
 * Safe to retry: a repeated call replaces the review's findings rather than
 * adding to them.
 */
export async function completeReview(
  db: Executor,
  {
    reviewJobId,
    jobStatus,
    review,
    findings,
    errorCode,
    errorMessage,
    completedAt = new Date(),
  }: CompleteReviewInput,
): Promise<{ review: Review; findings: ReviewFinding[] }> {
  return db.transaction(async (tx) => {
    const [storedReview] = await tx
      .insert(reviews)
      .values({ ...review, reviewJobId })
      .onConflictDoUpdate({ target: reviews.reviewJobId, set: review })
      .returning();
    if (!storedReview) throw new Error('completeReview: review not stored');
    await tx.delete(reviewFindings).where(eq(reviewFindings.reviewId, storedReview.id));
    const storedFindings =
      findings.length === 0
        ? []
        : await tx
            .insert(reviewFindings)
            .values(findings.map((finding) => ({ ...finding, reviewId: storedReview.id })))
            .returning();
    const updated = await tx
      .update(reviewJobs)
      .set({
        status: jobStatus,
        completedAt,
        ...(errorCode !== undefined && { errorCode }),
        ...(errorMessage !== undefined && { errorMessage }),
      })
      .where(eq(reviewJobs.id, reviewJobId))
      .returning({ id: reviewJobs.id });
    if (updated.length === 0)
      throw new Error(`completeReview: review job ${reviewJobId} not found`);
    return { review: storedReview, findings: storedFindings };
  });
}

/** The most recently created review job for a repository, for the dashboard's per-repo status. */
export async function findLatestReviewJobForRepository(
  db: Executor,
  repositoryId: string,
): Promise<ReviewJobSummary | undefined> {
  const rows = await listReviewJobsForRepository(db, repositoryId, { limit: 1 });
  return rows[0];
}

/**
 * Review jobs for a repository, newest first, each paired with its review
 * (null until the worker finishes) and finding count - one query per page
 * rather than N+1 per job. `repositoryId` is caller-supplied and must
 * already be authorization-checked (see `findAuthorizedRepository`); this
 * function does not re-check it.
 */
export async function listReviewJobsForRepository(
  db: Executor,
  repositoryId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<ReviewJobSummary[]> {
  const { limit = 20, offset = 0 } = options;
  const rows = await db
    .select({
      job: reviewJobs,
      review: reviews,
      findingsCount: sql<number>`count(${reviewFindings.id})::int`,
    })
    .from(reviewJobs)
    .leftJoin(reviews, eq(reviews.reviewJobId, reviewJobs.id))
    .leftJoin(reviewFindings, eq(reviewFindings.reviewId, reviews.id))
    .where(eq(reviewJobs.repositoryId, repositoryId))
    .groupBy(reviewJobs.id, reviews.id)
    // id as a tiebreaker: two jobs can share a createdAt (same millisecond),
    // and ordering on createdAt alone would let offset-based pagination
    // skip or duplicate a row across pages when that happens.
    .orderBy(desc(reviewJobs.createdAt), desc(reviewJobs.id))
    .limit(limit)
    .offset(offset);
  return rows;
}

/** A review with its findings, for the review-detail page. Findings are ordered by file, then line. */
export async function findReviewWithFindings(
  db: Executor,
  reviewJobId: string,
): Promise<{ job: ReviewJob; review: Review; findings: ReviewFinding[] } | undefined> {
  const [job] = await db.select().from(reviewJobs).where(eq(reviewJobs.id, reviewJobId));
  if (!job) return undefined;
  const [review] = await db.select().from(reviews).where(eq(reviews.reviewJobId, reviewJobId));
  if (!review) return undefined;
  const findings = await db
    .select()
    .from(reviewFindings)
    .where(eq(reviewFindings.reviewId, review.id))
    .orderBy(reviewFindings.filename, reviewFindings.startLine);
  return { job, review, findings };
}

export interface RepositoryUsageSummary {
  reviewCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number;
  jobCountByStatus: Partial<Record<ReviewJobStatus, number>>;
}

/**
 * Token/duration sums and a job-status breakdown for a repository's whole
 * history (Phase 13c's usage page) - real data, not a placeholder: `reviews`
 * already stores `inputTokens`/`outputTokens`/`durationMs` per review (both
 * the one-shot and agent-loop paths set them when the model reports usage).
 * Token/duration sums only count reviews that actually reported usage
 * (`inputTokens`/`outputTokens`/`durationMs` all nullable) - a `SUCCEEDED`
 * count from `jobCountByStatus` can therefore exceed how many reviews
 * contributed to the token sums.
 */
export async function getRepositoryUsageSummary(
  db: Executor,
  repositoryId: string,
): Promise<RepositoryUsageSummary> {
  const [totals] = await db
    .select({
      reviewCount: sql<number>`count(${reviews.id})::int`,
      totalInputTokens: sql<number>`coalesce(sum(${reviews.inputTokens}), 0)::int`,
      totalOutputTokens: sql<number>`coalesce(sum(${reviews.outputTokens}), 0)::int`,
      totalDurationMs: sql<number>`coalesce(sum(${reviews.durationMs}), 0)::int`,
    })
    .from(reviews)
    .innerJoin(reviewJobs, eq(reviewJobs.id, reviews.reviewJobId))
    .where(eq(reviewJobs.repositoryId, repositoryId));

  const statusRows = await db
    .select({ status: reviewJobs.status, count: sql<number>`count(*)::int` })
    .from(reviewJobs)
    .where(eq(reviewJobs.repositoryId, repositoryId))
    .groupBy(reviewJobs.status);

  const jobCountByStatus: Partial<Record<ReviewJobStatus, number>> = {};
  for (const row of statusRows) jobCountByStatus[row.status] = row.count;

  return {
    reviewCount: totals?.reviewCount ?? 0,
    totalInputTokens: totals?.totalInputTokens ?? 0,
    totalOutputTokens: totals?.totalOutputTokens ?? 0,
    totalDurationMs: totals?.totalDurationMs ?? 0,
    jobCountByStatus,
  };
}
