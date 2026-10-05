import {
  ACTIVE_JOB_WINDOW_MS,
  createIndexQueue,
  createNoopMetrics,
  createReviewQueue,
  createReviewQueueWorker,
  enqueueReviewJob,
  findStalePendingReviewJobs,
  findStaleRunningReviewJobs,
  releaseReviewJob,
  type AgentAdapter,
  type Database,
  type GitHubApp,
  type IndexQueueJob,
  type Logger,
  type MasterKeyMap,
  type Metrics,
  type ProviderRegistry,
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
  /** Every provider this deployment has a key for (ROADMAP.md Phase 10), for a repo's `.coderexic.yml` `model:` override. */
  providers?: ProviderRegistry;
  /**
   * When set, a repository's own BYOK credential (Phase 11's
   * `model_credentials`, repo-scoped rows only - there's no acting user at
   * review time) is resolved and used ahead of this deployment's own key
   * for whichever provider the review ends up using (Phase 13c). When
   * unset, BYOK resolution is skipped entirely and every review uses this
   * deployment's own configured providers, exactly as before Phase 13c.
   */
  masterKeys?: MasterKeyMap;
  /** ROADMAP.md Phase 14. Defaults to a no-op instance. */
  metrics?: Metrics;
  concurrency?: number;
  /** How often the stale-job sweep runs. */
  sweepIntervalMs?: number;
  /** A PENDING job older than this is considered stuck and re-enqueued. */
  staleAfterMs?: number;
  /**
   * A RUNNING job whose `startedAt` is older than this is considered
   * orphaned (its worker crashed outright) and, once confirmed against
   * BullMQ's own job state, reset to PENDING and re-enqueued. Defaults to
   * `ACTIVE_JOB_WINDOW_MS` (30 min) - well past any realistic review
   * duration, since a row that's genuinely still being worked on is also
   * RUNNING.
   */
  stuckRunningAfterMs?: number;
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
 * pipeline. Also runs two recovery sweeps: PENDING review_jobs rows with no
 * matching queue entry (an enqueue that failed after its webhook transaction
 * committed), re-enqueued directly; and RUNNING rows whose worker crashed
 * outright before reaching a terminal status, confirmed against BullMQ's own
 * job state before being reset to PENDING and re-enqueued.
 * `enqueueReviewJob`'s jobId makes a plain re-enqueue a no-op for a job
 * that's already queued or already finished.
 */
export function createReviewWorker(deps: ReviewWorkerDeps): Worker {
  let running = false;
  let queue: Queue<ReviewQueueJob> | undefined;
  let indexQueue: Queue<IndexQueueJob> | undefined;
  let consumer: BullWorker<ReviewQueueJob> | undefined;
  let sweepInterval: NodeJS.Timeout | undefined;

  const sweepStuckRunning = async (): Promise<void> => {
    if (!queue) return;
    const olderThan = new Date(Date.now() - (deps.stuckRunningAfterMs ?? ACTIVE_JOB_WINDOW_MS));
    const stuck = await findStaleRunningReviewJobs(deps.db, olderThan);
    let recovered = 0;
    for (const job of stuck) {
      try {
        const existing = await queue.getJob(job.id);
        if (existing) {
          // A worker may genuinely still hold this job (a long review, not a
          // crash) - the DB row being RUNNING is then correct, not stale.
          if (await existing.isActive()) continue;
          // BullMQ ignores `add()` for a jobId that still exists in any
          // state (completed and failed included), so a stale leftover must
          // be removed first. `remove()` itself throws if the job became
          // active/locked since the check above - caught below, which
          // correctly skips this job for this cycle rather than risking a
          // double-processed job.
          await existing.remove();
        }
        await releaseReviewJob(deps.db, job.id);
        await enqueueReviewJob(queue, job.id);
        recovered++;
      } catch (err) {
        deps.logger.warn(
          { err, reviewJobId: job.id },
          'stuck-job sweep could not recover a job this cycle',
        );
      }
    }
    if (recovered > 0) {
      deps.logger.warn(
        { count: recovered },
        'stuck-job sweep recovered orphaned running review jobs',
      );
    }
  };

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
      const metrics = deps.metrics ?? createNoopMetrics();
      metrics.registerQueue('review-jobs', queue);
      metrics.registerQueue('index-runs', indexQueue);
      consumer = createReviewQueueWorker(
        deps.connection,
        (job, attempt) =>
          processReviewJob(
            {
              db: deps.db,
              githubApp: deps.githubApp,
              model: deps.model,
              provider: deps.provider,
              modelName: deps.modelName,
              logger: deps.logger,
              metrics,
              ...(indexQueue !== undefined && { indexQueue }),
              ...(deps.agentAdapter !== undefined && { agentAdapter: deps.agentAdapter }),
              ...(deps.providers !== undefined && { providers: deps.providers }),
              ...(deps.masterKeys !== undefined && { masterKeys: deps.masterKeys }),
            },
            job.reviewJobId,
            attempt,
          ),
        { ...(deps.concurrency !== undefined && { concurrency: deps.concurrency }) },
      );
      consumer.on('failed', (job: Job<ReviewQueueJob> | undefined, err: Error) => {
        // attemptsMade is already bumped by the time this fires (BullMQ records
        // the failed attempt before emitting the event), so attemptsMade >=
        // opts.attempts means nothing is left to retry: the job is dead-lettered
        // (processReviewJob already marks the review_jobs row terminal for this
        // case - see its isTransientError/isLastAttempt handling).
        const exhausted = job !== undefined && job.attemptsMade >= (job.opts.attempts ?? 1);
        deps.logger.error(
          { reviewJobId: job?.data.reviewJobId, attemptsMade: job?.attemptsMade, exhausted, err },
          exhausted
            ? 'review job dead-lettered: all attempts exhausted'
            : 'review job attempt failed',
        );
      });
      const runSweeps = async (): Promise<void> => {
        await sweep().catch((err: unknown) => {
          deps.logger.error({ err }, 'stale-pending sweep failed');
        });
        await sweepStuckRunning().catch((err: unknown) => {
          deps.logger.error({ err }, 'stuck-running sweep failed');
        });
      };
      await runSweeps();
      sweepInterval = setInterval(() => {
        void runSweeps();
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
