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
 * Consumes REVIEW_QUEUE_NAME, validating each job's data before it reaches
 * `handler`. BullMQ's own `attempts`/`backoff` (set when the job was
 * enqueued) apply automatically when `handler` throws.
 */
export function createReviewQueueWorker(
  connection: ConnectionOptions,
  handler: (job: ReviewQueueJob) => Promise<void>,
  options: ReviewQueueWorkerOptions = {},
): Worker<ReviewQueueJob> {
  return new Worker<ReviewQueueJob>(
    REVIEW_QUEUE_NAME,
    async (job) => {
      await handler(reviewQueueJobSchema.parse(job.data));
    },
    { connection, concurrency: options.concurrency ?? 2 },
  );
}
