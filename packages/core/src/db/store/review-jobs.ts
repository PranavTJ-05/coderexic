import { and, eq, lt, sql } from 'drizzle-orm';
import type { Executor } from '../client.js';
import {
  reviewFindings,
  reviewJobs,
  reviews,
  type ReviewJobStatus,
  type ReviewStatus,
  type ReviewTrigger,
} from '../schema.js';

export type ReviewJob = typeof reviewJobs.$inferSelect;
export type Review = typeof reviews.$inferSelect;
export type ReviewFinding = typeof reviewFindings.$inferSelect;
export type NewReviewFinding = Omit<
  typeof reviewFindings.$inferInsert,
  'id' | 'reviewId' | 'createdAt'
>;

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
