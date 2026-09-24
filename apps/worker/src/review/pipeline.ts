import {
  buildReview,
  cancelReviewJob,
  claimReviewJob,
  completeReview,
  DEFAULT_DIFF_BUDGET,
  dedupeFindings,
  failReviewJob,
  filterBySeverity,
  findInstallationById,
  findRepositoryById,
  getRepositorySettings,
  hasReviewMarker,
  ModelError,
  ModelInvalidOutputError,
  ModelTimeoutError,
  placeFindings,
  selectReviewableFiles,
  type Database,
  type DiffBudget,
  type GitHubApp,
  type Logger,
  type ReviewModel,
} from '@coderexic/core';
import { publishReview } from './publish.js';

export interface ReviewPipelineDeps {
  db: Database;
  githubApp: GitHubApp;
  model: ReviewModel;
  /** Stored on the review row; identifies what actually produced it. */
  provider: string;
  modelName: string;
  logger: Logger;
  diffBudget?: DiffBudget;
}

/** Non-error termination reasons stored as review_jobs.error_code. */
const SKIP_REASON = {
  repositoryRemoved: 'REPOSITORY_REMOVED',
  superseded: 'SUPERSEDED_BY_NEWER_COMMIT',
  draft: 'DRAFT_PULL_REQUEST',
  closed: 'PULL_REQUEST_CLOSED',
} as const;

/**
 * Runs one review job end to end: claim, fetch the PR, ask the model,
 * publish, persist. Safe to call more than once for the same job (BullMQ
 * retries, or the stale-job sweep re-enqueuing): claimReviewJob only lets
 * one call past PENDING, and a job that already has a posted review is
 * detected and completed without posting again.
 */
export async function processReviewJob(
  deps: ReviewPipelineDeps,
  reviewJobId: string,
): Promise<void> {
  const { db, githubApp, model, provider, modelName, logger } = deps;
  const budget = deps.diffBudget ?? DEFAULT_DIFF_BUDGET;
  const log = logger.child({ reviewJobId });
  const startedAt = Date.now();

  const claimed = await claimReviewJob(db, reviewJobId);
  if (!claimed) {
    log.info('job is not pending (already claimed, completed, or missing); skipping');
    return;
  }

  try {
    const [repository, installation] = await Promise.all([
      findRepositoryById(db, claimed.repositoryId),
      findInstallationById(db, claimed.installationId),
    ]);
    if (!repository || !installation) {
      await failReviewJob(db, reviewJobId, 'FAILED', 'REPOSITORY_NOT_FOUND');
      return;
    }
    if (repository.removedAt ?? installation.removedAt) {
      await cancelReviewJob(db, reviewJobId, SKIP_REASON.repositoryRemoved);
      return;
    }

    const client = await githubApp.getInstallationClient(installation.githubInstallationId);
    const ref = { owner: repository.ownerLogin, repo: repository.name };

    const pr = await client.getPullRequest(ref, claimed.pullRequestNumber);
    if (pr.headSha !== claimed.headSha) {
      // A newer push already created (or will create) the job that covers it.
      await cancelReviewJob(db, reviewJobId, SKIP_REASON.superseded);
      return;
    }
    if (pr.draft) {
      await cancelReviewJob(db, reviewJobId, SKIP_REASON.draft);
      return;
    }
    if (pr.state !== 'open') {
      await cancelReviewJob(db, reviewJobId, SKIP_REASON.closed);
      return;
    }

    const reviewBodies = await client.listReviewBodies(ref, pr.number);
    if (reviewBodies.some((body) => hasReviewMarker(body, reviewJobId))) {
      log.info('a review for this job was already posted; completing without posting again');
      await completeReview(db, {
        reviewJobId,
        jobStatus: 'SUCCEEDED',
        review: {
          provider,
          model: modelName,
          status: 'SUCCEEDED',
          summary: 'Review already posted (recovered after a retry).',
          filesConsidered: 0,
          filesFetched: 0,
          agentTurns: 0,
          toolCalls: 0,
          durationMs: Date.now() - startedAt,
        },
        findings: [],
      });
      return;
    }

    const settings = await getRepositorySettings(db, repository.id);
    const minimumSeverity = settings?.minimumSeverity ?? 'low';
    const maxReviewSeconds = settings?.maxReviewSeconds ?? 60;

    const files = await client.getPullRequestFiles(ref, pr.number);
    const selection = selectReviewableFiles(files, { budget });
    log.info(
      {
        changedFiles: files.length,
        reviewed: selection.files.length,
        skipped: selection.skipped.length,
      },
      'selected files for review',
    );

    if (selection.files.length === 0) {
      await completeReview(db, {
        reviewJobId,
        jobStatus: 'SUCCEEDED',
        review: {
          provider,
          model: modelName,
          status: 'SUCCEEDED',
          summary: 'No reviewable files in this diff.',
          filesConsidered: files.length,
          filesFetched: 0,
          agentTurns: 0,
          toolCalls: 0,
          durationMs: Date.now() - startedAt,
        },
        findings: [],
      });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, maxReviewSeconds * 1000);
    try {
      const output = await model.generateReview(
        {
          repositoryFullName: repository.fullName,
          pullRequestTitle: pr.title,
          pullRequestBody: pr.body,
          files: selection.files.map(({ filename, status, patch }) => ({
            filename,
            status,
            patch,
          })),
        },
        { signal: controller.signal },
      );

      const deduped = dedupeFindings(filterBySeverity(output.reviews, minimumSeverity));
      const filesByPath = new Map(selection.files.map((file) => [file.filename, file.patch]));
      const processed = placeFindings(deduped, filesByPath);
      const built = buildReview(processed);

      const publishError = await publishReview(
        client,
        ref,
        pr,
        reviewJobId,
        output.summary,
        built,
        log,
      );

      await completeReview(db, {
        reviewJobId,
        jobStatus: publishError ? 'FAILED' : 'SUCCEEDED',
        review: {
          provider,
          model: modelName,
          status: publishError ? 'FAILED' : 'SUCCEEDED',
          summary: output.summary,
          filesConsidered: files.length,
          filesFetched: selection.files.length,
          agentTurns: 1,
          toolCalls: 0,
          durationMs: Date.now() - startedAt,
        },
        findings: built.dbFindings,
        ...(publishError && {
          errorCode: 'GITHUB_PUBLISH_ERROR',
          errorMessage: publishError.slice(0, 1000),
        }),
      });
      if (publishError) log.error({ publishError }, 'review job completed with a publish failure');
    } catch (err) {
      if (err instanceof ModelTimeoutError) {
        await failReviewJob(db, reviewJobId, 'TIMED_OUT', 'TIMEOUT', err.message);
      } else if (err instanceof ModelInvalidOutputError) {
        await failReviewJob(db, reviewJobId, 'FAILED', 'INVALID_OUTPUT', err.message);
      } else if (err instanceof ModelError) {
        await failReviewJob(db, reviewJobId, 'FAILED', 'MODEL_ERROR', err.message);
      } else {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    log.error({ err }, 'review job failed unexpectedly');
    await failReviewJob(
      db,
      reviewJobId,
      'FAILED',
      'UNEXPECTED_ERROR',
      err instanceof Error ? err.message : 'unknown error',
    ).catch((markErr: unknown) => {
      log.error({ err: markErr }, 'failed to mark job failed');
    });
    // Rethrow so BullMQ records the attempt as failed and applies its retry policy.
    throw err;
  }
}
