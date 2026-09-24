import {
  createIndexQueue,
  createIndexQueueWorker,
  enqueueIndexRun,
  findStalePendingIndexRuns,
  type Database,
  type GitHubApp,
  type IndexQueueJob,
  type Logger,
} from '@coderexic/core';
import type { ConnectionOptions, Job, Queue, Worker as BullWorker } from 'bullmq';
import { processIndexRun } from './pipeline.js';

export interface IndexWorkerDeps {
  logger: Logger;
  db: Database;
  connection: ConnectionOptions;
  githubApp: GitHubApp;
  concurrency?: number;
  maxFiles?: number;
  sweepIntervalMs?: number;
  staleAfterMs?: number;
}

export interface Worker {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly running: boolean;
}

const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60_000;
const DEFAULT_STALE_AFTER_MS = 10 * 60_000;

/**
 * Consumes index runs from Redis, separately from the review queue so
 * indexing and review work fail and retry independently (ARCHITECTURE.md
 * §7-8). Mirrors `createReviewWorker`'s claim + stale-sweep pattern.
 */
export function createIndexWorker(deps: IndexWorkerDeps): Worker {
  let running = false;
  let queue: Queue<IndexQueueJob> | undefined;
  let consumer: BullWorker<IndexQueueJob> | undefined;
  let sweepInterval: NodeJS.Timeout | undefined;

  const sweep = async (): Promise<void> => {
    const olderThan = new Date(Date.now() - (deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS));
    const stale = await findStalePendingIndexRuns(deps.db, olderThan);
    if (stale.length === 0 || !queue) return;
    for (const run of stale) await enqueueIndexRun(queue, run.id);
    deps.logger.warn({ count: stale.length }, 'stale-run sweep re-enqueued pending index runs');
  };

  return {
    get running() {
      return running;
    },
    async start() {
      if (running) return;
      running = true;
      queue = createIndexQueue(deps.connection);
      consumer = createIndexQueueWorker(
        deps.connection,
        (job) =>
          processIndexRun(
            {
              db: deps.db,
              githubApp: deps.githubApp,
              logger: deps.logger,
              ...(deps.maxFiles !== undefined && { maxFiles: deps.maxFiles }),
            },
            job.indexRunId,
          ),
        { ...(deps.concurrency !== undefined && { concurrency: deps.concurrency }) },
      );
      consumer.on('failed', (job: Job<IndexQueueJob> | undefined, err: Error) => {
        deps.logger.error({ indexRunId: job?.data.indexRunId, err }, 'index run attempt failed');
      });
      await sweep().catch((err: unknown) => {
        deps.logger.error({ err }, 'startup sweep failed');
      });
      sweepInterval = setInterval(() => {
        void sweep().catch((err: unknown) => {
          deps.logger.error({ err }, 'sweep failed');
        });
      }, deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
      deps.logger.info('index worker started');
    },
    async stop() {
      if (!running) return;
      running = false;
      clearInterval(sweepInterval);
      sweepInterval = undefined;
      await consumer?.close();
      await queue?.close();
      consumer = undefined;
      queue = undefined;
      deps.logger.info('index worker stopped');
    },
  };
}
