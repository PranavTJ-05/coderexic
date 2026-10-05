import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { z } from 'zod';

/** One queue for review jobs; the worker adds indexing queues in later phases. */
export const REVIEW_QUEUE_NAME = 'review-jobs';

export const reviewQueueJobSchema = z.object({
  /** Matches review_jobs.id. Used as the BullMQ job ID, so re-enqueuing the
   * same review job is a no-op instead of creating a duplicate. */
  reviewJobId: z.uuid(),
});
export type ReviewQueueJob = z.infer<typeof reviewQueueJobSchema>;

export function createReviewQueue(connection: ConnectionOptions): Queue<ReviewQueueJob> {
  return new Queue<ReviewQueueJob>(REVIEW_QUEUE_NAME, { connection });
}

/**
 * Enqueues a review job for processing. Idempotent: calling this again for
 * the same reviewJobId (a retried enqueue, a redelivered webhook, or the
 * stale-job sweep) does not create a second queue entry.
 */
export async function enqueueReviewJob(
  queue: Queue<ReviewQueueJob>,
  reviewJobId: string,
  options: { attempts?: number; backoffMs?: number } = {},
): Promise<void> {
  await queue.add(
    'review',
    { reviewJobId },
    {
      jobId: reviewJobId,
      attempts: options.attempts ?? 3,
      backoff: { type: 'exponential', delay: options.backoffMs ?? 5000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  );
}

export interface ReviewQueueWorkerOptions {
  concurrency?: number;
}

/**
 * `job.attemptsMade` only counts attempts BullMQ has already finished
 * (0 during the very first run); it has not yet counted the attempt
 * currently in progress. `maxAttempts` is whatever `attempts` enqueueReviewJob
 * set (defaulting to 1 if the queue somehow omitted it, which is the safe
 * reading: "no further attempts configured," never "assume there are more").
 */
export interface ReviewJobAttempt {
  attemptsMade: number;
  maxAttempts: number;
}

/**
 * Consumes REVIEW_QUEUE_NAME, validating each job's data before it reaches
 * `handler`. BullMQ's own `attempts`/`backoff` (set when the job was
 * enqueued) apply automatically when `handler` throws. `handler` also gets
 * this attempt's position in that sequence, so it can tell a retryable
 * failure (give the review_jobs row back to PENDING, rethrow) from the last
 * chance (mark it terminal).
 */
export function createReviewQueueWorker(
  connection: ConnectionOptions,
  handler: (job: ReviewQueueJob, attempt: ReviewJobAttempt) => Promise<void>,
  options: ReviewQueueWorkerOptions = {},
): Worker<ReviewQueueJob> {
  return new Worker<ReviewQueueJob>(
    REVIEW_QUEUE_NAME,
    async (job) => {
      await handler(reviewQueueJobSchema.parse(job.data), {
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts ?? 1,
      });
    },
    { connection, concurrency: options.concurrency ?? 2 },
  );
}
