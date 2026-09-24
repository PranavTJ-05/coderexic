import {
  createLogger,
  createReviewQueue,
  ModelHttpError,
  reviewFindings,
  reviewJobs,
  reviews,
  type CreateReviewInput,
  type GitHubApp,
  type GitHubClient,
  type ModelReviewOutput,
  type PullRequest,
  type ReviewModel,
} from '@coderexic/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { processReviewJob } from '../../apps/worker/src/review/pipeline.js';
import { createReviewWorker } from '../../apps/worker/src/worker.js';
import { makeReviewJob } from './db/fixtures.js';
import { useTestDatabase } from './helpers/db.js';
import { useTestRedis } from './helpers/redis.js';

const logger = createLogger({ name: 'worker-pipeline-test', level: 'silent' });

const PATCH =
  '@@ -1,2 +1,3 @@\n context\n+const query = `SELECT * FROM users WHERE id = ${id}`;\n context';

function basePullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    title: 'Add user lookup',
    body: 'Adds a lookup by id.',
    author: 'octocat',
    state: 'open',
    draft: false,
    baseSha: 'b'.repeat(40),
    headSha: 'a'.repeat(40),
    baseRef: 'main',
    headRef: 'feature',
    additions: 3,
    deletions: 0,
    changedFiles: 1,
    ...overrides,
  };
}

interface FakeClient extends GitHubClient {
  createReviewCalls: CreateReviewInput[];
  createIssueCommentCalls: { issueNumber: number; body: string }[];
}

function fakeClient(
  overrides: { pullRequest?: Partial<PullRequest>; reviewBodies?: (string | null)[] } = {},
): FakeClient {
  const createReviewCalls: CreateReviewInput[] = [];
  const createIssueCommentCalls: { issueNumber: number; body: string }[] = [];
  return {
    createReviewCalls,
    createIssueCommentCalls,
    getPullRequest: () => Promise.resolve(basePullRequest(overrides.pullRequest)),
    getPullRequestFiles: () =>
      Promise.resolve([
        {
          filename: 'src/user.ts',
          previousFilename: null,
          status: 'modified',
          additions: 1,
          deletions: 0,
          patch: PATCH,
        },
      ]),
    getFileContent: () => Promise.reject(new Error('not used in this test')),
    getRepositoryTree: () => Promise.reject(new Error('not used in this test')),
    listReviewBodies: () => Promise.resolve(overrides.reviewBodies ?? []),
    createReview: (_ref, input) => {
      createReviewCalls.push(input);
      return Promise.resolve(999);
    },
    createIssueComment: (_ref, issueNumber, body) => {
      createIssueCommentCalls.push({ issueNumber, body });
      return Promise.resolve(1000);
    },
  };
}

function fakeGithubApp(client: GitHubClient): GitHubApp {
  return {
    getInstallationClient: () => Promise.resolve(client),
    getRepositoryInstallationId: () => Promise.reject(new Error('not used in this test')),
  };
}

function fakeModel(output: ModelReviewOutput | (() => ModelReviewOutput)): ReviewModel {
  return {
    generateReview: () => Promise.resolve(typeof output === 'function' ? output() : output),
  };
}

function throwingModel(error: Error): ReviewModel {
  return { generateReview: () => Promise.reject(error) };
}

const FINDING_OUTPUT: ModelReviewOutput = {
  summary: 'Found a SQL injection risk.',
  reviews: [
    {
      filename: 'src/user.ts',
      severity: 'critical',
      start_line: 2,
      end_line: 2,
      issue: 'User-controlled id is interpolated directly into a SQL query.',
      fix_type: 'warning',
      suggested_code: null,
    },
  ],
};

describe('worker: processReviewJob', () => {
  const { db } = useTestDatabase();

  it('publishes findings, persists them and marks the job SUCCEEDED', async () => {
    const { job } = await makeReviewJob(db);
    const client = fakeClient();
    const deps = {
      db,
      githubApp: fakeGithubApp(client),
      model: fakeModel(FINDING_OUTPUT),
      provider: 'test-provider',
      modelName: 'test-model',
      logger,
    };

    await processReviewJob(deps, job.id);

    expect(client.createReviewCalls).toHaveLength(1);
    expect(client.createReviewCalls[0]).toMatchObject({
      body: expect.stringContaining('Found a SQL injection risk.') as string,
      comments: [{ path: 'src/user.ts', line: 2 }],
    });
    expect(client.createReviewCalls[0]!.body).toContain(`<!-- coderexic:review-job:${job.id} -->`);

    const [storedJob] = await db.select().from(reviewJobs).where(eq(reviewJobs.id, job.id));
    expect(storedJob).toMatchObject({ status: 'SUCCEEDED' });
    const [storedReview] = await db.select().from(reviews).where(eq(reviews.reviewJobId, job.id));
    expect(storedReview).toMatchObject({
      provider: 'test-provider',
      model: 'test-model',
      status: 'SUCCEEDED',
    });
    const findings = await db
      .select()
      .from(reviewFindings)
      .where(eq(reviewFindings.reviewId, storedReview!.id));
    expect(findings).toMatchObject([
      { filename: 'src/user.ts', severity: 'critical', published: true },
    ]);
  });

  it('is a no-op for a job that is not PENDING (already claimed or finished)', async () => {
    const { job } = await makeReviewJob(db);
    const client = fakeClient();
    const model = fakeModel(FINDING_OUTPUT);
    const generateReview = vi.spyOn(model, 'generateReview');
    const deps = {
      db,
      githubApp: fakeGithubApp(client),
      model,
      provider: 'test',
      modelName: 'm',
      logger,
    };

    await processReviewJob(deps, job.id);
    expect(client.createReviewCalls).toHaveLength(1);

    // A retried delivery, or the stale-job sweep, calling the same job again.
    await processReviewJob(deps, job.id);
    expect(client.createReviewCalls).toHaveLength(1);
    expect(generateReview).toHaveBeenCalledTimes(1);
  });

  it('detects a review already posted (by marker) and completes without posting again', async () => {
    const { job } = await makeReviewJob(db);
    const client = fakeClient({
      reviewBodies: [`Old summary\n\n<!-- coderexic:review-job:${job.id} -->`],
    });
    const model = fakeModel(FINDING_OUTPUT);
    const generateReview = vi.spyOn(model, 'generateReview');
    const deps = {
      db,
      githubApp: fakeGithubApp(client),
      model,
      provider: 'test',
      modelName: 'm',
      logger,
    };

    await processReviewJob(deps, job.id);

    expect(client.createReviewCalls).toHaveLength(0);
    expect(generateReview).not.toHaveBeenCalled();
    const [storedJob] = await db.select().from(reviewJobs).where(eq(reviewJobs.id, job.id));
    expect(storedJob).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('cancels the job when the pull request is a draft', async () => {
    const { job } = await makeReviewJob(db);
    const client = fakeClient({ pullRequest: { draft: true } });
    const deps = {
      db,
      githubApp: fakeGithubApp(client),
      model: fakeModel(FINDING_OUTPUT),
      provider: 'test',
      modelName: 'm',
      logger,
    };

    await processReviewJob(deps, job.id);

    expect(client.createReviewCalls).toHaveLength(0);
    const [storedJob] = await db.select().from(reviewJobs).where(eq(reviewJobs.id, job.id));
    expect(storedJob).toMatchObject({ status: 'CANCELLED', errorCode: 'DRAFT_PULL_REQUEST' });
  });

  it('cancels the job when the head commit has moved on (superseded by a newer push)', async () => {
    const { job } = await makeReviewJob(db);
    const client = fakeClient({ pullRequest: { headSha: 'c'.repeat(40) } });
    const deps = {
      db,
      githubApp: fakeGithubApp(client),
      model: fakeModel(FINDING_OUTPUT),
      provider: 'test',
      modelName: 'm',
      logger,
    };

    await processReviewJob(deps, job.id);

    const [storedJob] = await db.select().from(reviewJobs).where(eq(reviewJobs.id, job.id));
    expect(storedJob).toMatchObject({
      status: 'CANCELLED',
      errorCode: 'SUPERSEDED_BY_NEWER_COMMIT',
    });
  });

  it('marks the job FAILED with a MODEL_ERROR code when the model call fails', async () => {
    const { job } = await makeReviewJob(db);
    const client = fakeClient();
    const deps = {
      db,
      githubApp: fakeGithubApp(client),
      model: throwingModel(new ModelHttpError('quota exceeded', 429)),
      provider: 'test',
      modelName: 'm',
      logger,
    };

    await processReviewJob(deps, job.id);

    expect(client.createReviewCalls).toHaveLength(0);
    const [storedJob] = await db.select().from(reviewJobs).where(eq(reviewJobs.id, job.id));
    expect(storedJob).toMatchObject({ status: 'FAILED', errorCode: 'MODEL_ERROR' });
  });

  it('completes with no comments when the diff has no reviewable files', async () => {
    const { job } = await makeReviewJob(db);
    const client: FakeClient = { ...fakeClient(), getPullRequestFiles: () => Promise.resolve([]) };
    const deps = {
      db,
      githubApp: fakeGithubApp(client),
      model: fakeModel(FINDING_OUTPUT),
      provider: 'test',
      modelName: 'm',
      logger,
    };

    await processReviewJob(deps, job.id);

    expect(client.createReviewCalls).toHaveLength(0);
    const [storedJob] = await db.select().from(reviewJobs).where(eq(reviewJobs.id, job.id));
    expect(storedJob).toMatchObject({ status: 'SUCCEEDED' });
  });
});

describe('worker: createReviewWorker end to end', () => {
  const { db } = useTestDatabase();
  const redis = useTestRedis();

  it('picks a job up from the real Redis queue and processes it', async () => {
    const { job } = await makeReviewJob(db);
    const client = fakeClient();
    const worker = createReviewWorker({
      logger,
      db,
      connection: redis,
      githubApp: fakeGithubApp(client),
      model: fakeModel(FINDING_OUTPUT),
      provider: 'test-provider',
      modelName: 'test-model',
      concurrency: 1,
      sweepIntervalMs: 3_600_000,
      staleAfterMs: 3_600_000,
    });
    const producer = createReviewQueue(redis);

    try {
      await worker.start();
      await producer.add('review', { reviewJobId: job.id }, { jobId: job.id });

      const deadline = Date.now() + 10_000;
      let status: string | undefined;
      while (Date.now() < deadline) {
        const [row] = await db.select().from(reviewJobs).where(eq(reviewJobs.id, job.id));
        status = row?.status;
        if (status && status !== 'PENDING' && status !== 'RUNNING') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(status).toBe('SUCCEEDED');
      expect(client.createReviewCalls).toHaveLength(1);
    } finally {
      await worker.stop();
      await producer.obliterate({ force: true }).catch(() => undefined);
      await producer.close();
    }
  }, 15_000);
});
