import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { z } from 'zod';

/** Separate queue from REVIEW_QUEUE_NAME: indexing and review work fail and retry independently. */
export const INDEX_QUEUE_NAME = 'index-runs';

export const indexQueueJobSchema = z.object({
  /** Matches index_runs.id, used as the BullMQ job ID for the same reason as ReviewQueueJob. */
  indexRunId: z.uuid(),
});
export type IndexQueueJob = z.infer<typeof indexQueueJobSchema>;

export function createIndexQueue(connection: ConnectionOptions): Queue<IndexQueueJob> {
  return new Queue<IndexQueueJob>(INDEX_QUEUE_NAME, { connection });
}

/** Idempotent: re-enqueuing the same indexRunId does not create a second queue entry. */
export async function enqueueIndexRun(
  queue: Queue<IndexQueueJob>,
  indexRunId: string,
  options: { attempts?: number; backoffMs?: number } = {},
): Promise<void> {
  await queue.add(
    'index',
    { indexRunId },
    {
      jobId: indexRunId,
      attempts: options.attempts ?? 3,
      backoff: { type: 'exponential', delay: options.backoffMs ?? 5000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  );
}

export interface IndexQueueWorkerOptions {
  concurrency?: number;
}

export function createIndexQueueWorker(
  connection: ConnectionOptions,
  handler: (job: IndexQueueJob) => Promise<void>,
  options: IndexQueueWorkerOptions = {},
): Worker<IndexQueueJob> {
  return new Worker<IndexQueueJob>(
    INDEX_QUEUE_NAME,
    async (job) => {
      await handler(indexQueueJobSchema.parse(job.data));
    },
    { connection, concurrency: options.concurrency ?? 1 },
  );
}
