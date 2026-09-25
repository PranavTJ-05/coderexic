import {
  createIndexQueue,
  createReviewQueue,
  createReviewQueueWorker,
  enqueueReviewJob,
  findStalePendingReviewJobs,
  type AgentAdapter,
  type Database,
  type GitHubApp,
  type IndexQueueJob,
  type Logger,
  type ReviewModel,
  type ReviewQueueJob,
} from '@coderexic/core';
import type { ConnectionOptions, Job, Queue, Worker as BullWorker } from 'bullmq';
import { processReviewJob } from './review/pipeline.js';

export interface ReviewWorkerDeps {
  logger: Logger;
  db: Database;
  connection: ConnectionOptions;
  githubApp: GitHubApp;
  model: ReviewModel;
  /** When set, reviews run through the Phase 9 agent loop instead of the one-shot `model` path. */
  agentAdapter?: AgentAdapter;
  provider: string;
  modelName: string;
  concurrency?: number;
  /** How often the stale-job sweep runs. */
  sweepIntervalMs?: number;
  /** A PENDING job older than this is considered stuck and re-enqueued. */
  staleAfterMs?: number;
}

export interface Worker {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly running: boolean;
}

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;
const DEFAULT_STALE_AFTER_MS = 5 * 60_000;

/**
 * Consumes review jobs from Redis and runs them through the review
 * pipeline. Also sweeps for PENDING review_jobs rows with no matching queue
 * entry (an enqueue that failed after its webhook transaction committed)
 * and re-enqueues them; enqueueReviewJob's jobId makes this a no-op for
 * jobs that are already queued or already finished.
 */
export function createReviewWorker(deps: ReviewWorkerDeps): Worker {
  let running = false;
  let queue: Queue<ReviewQueueJob> | undefined;
  let indexQueue: Queue<IndexQueueJob> | undefined;
  let consumer: BullWorker<ReviewQueueJob> | undefined;
  let sweepInterval: NodeJS.Timeout | undefined;

  const sweep = async (): Promise<void> => {
    const olderThan = new Date(Date.now() - (deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS));
    const stale = await findStalePendingReviewJobs(deps.db, olderThan);
    if (stale.length === 0 || !queue) return;
    for (const job of stale) await enqueueReviewJob(queue, job.id);
    deps.logger.warn({ count: stale.length }, 'stale-job sweep re-enqueued pending review jobs');
  };

  return {
    get running() {
      return running;
    },
    async start() {
      if (running) return;
      running = true;
      queue = createReviewQueue(deps.connection);
      indexQueue = createIndexQueue(deps.connection);
      consumer = createReviewQueueWorker(
        deps.connection,
        (job) =>
          processReviewJob(
            {
              db: deps.db,
              githubApp: deps.githubApp,
              model: deps.model,
              provider: deps.provider,
              modelName: deps.modelName,
              logger: deps.logger,
              ...(indexQueue !== undefined && { indexQueue }),
              ...(deps.agentAdapter !== undefined && { agentAdapter: deps.agentAdapter }),
            },
            job.reviewJobId,
          ),
        { ...(deps.concurrency !== undefined && { concurrency: deps.concurrency }) },
      );
      consumer.on('failed', (job: Job<ReviewQueueJob> | undefined, err: Error) => {
        deps.logger.error({ reviewJobId: job?.data.reviewJobId, err }, 'review job attempt failed');
      });
      await sweep().catch((err: unknown) => {
        deps.logger.error({ err }, 'startup sweep failed');
      });
      sweepInterval = setInterval(() => {
        void sweep().catch((err: unknown) => {
          deps.logger.error({ err }, 'sweep failed');
        });
      }, deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
      deps.logger.info('worker started');
    },
    async stop() {
      if (!running) return;
      running = false;
      clearInterval(sweepInterval);
      sweepInterval = undefined;
      await consumer?.close();
      await queue?.close();
      await indexQueue?.close();
      consumer = undefined;
      queue = undefined;
      indexQueue = undefined;
      deps.logger.info('worker stopped');
    },
  };
}
