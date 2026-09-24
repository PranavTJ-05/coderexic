import {
  automaticReviewKey,
  completeReview,
  createReviewJob,
  findInstallationByGithubId,
  getRepositorySettings,
  IdempotencyConflictError,
  manualReviewKey,
  markInstallationRemoved,
  markRepositoriesRemoved,
  markWebhookEvent,
  recordWebhookEvent,
  repositories,
  reviewFindings,
  reviewJobs,
  reviews,
  upsertInstallation,
  upsertRepository,
} from '@coderexic/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { useTestDatabase } from '../helpers/db.js';
import { makeInstallation, makeRepository, makeReviewJob } from './fixtures.js';

describe('store', () => {
  const { db } = useTestDatabase();

  describe('installations', () => {
    it('upserts by GitHub installation ID and restores a removed installation', async () => {
      const first = await upsertInstallation(db, {
        githubInstallationId: 77,
        ownerType: 'User',
        ownerLogin: 'old-login',
      });
      await markInstallationRemoved(db, 77);
      const again = await upsertInstallation(db, {
        githubInstallationId: 77,
        ownerType: 'User',
        ownerLogin: 'new-login',
      });
      expect(again.id).toBe(first.id);
      expect(again).toMatchObject({ ownerLogin: 'new-login', removedAt: null });
    });

    it('removal soft-removes the installation and all its repositories together', async () => {
      const installation = await makeInstallation(db);
      await makeRepository(db, installation.id);
      await makeRepository(db, installation.id);

      await markInstallationRemoved(db, installation.githubInstallationId);

      const stored = await findInstallationByGithubId(db, installation.githubInstallationId);
      expect(stored!.removedAt).toBeInstanceOf(Date);
      const repos = await db
        .select()
        .from(repositories)
        .where(eq(repositories.installationId, installation.id));
      expect(repos).toHaveLength(2);
      expect(repos.every((r) => r.removedAt !== null)).toBe(true);
    });
  });

  describe('repositories', () => {
    it('creates default settings with the repository', async () => {
      const repo = await makeRepository(db);
      expect(await getRepositorySettings(db, repo.id)).toMatchObject({
        minimumSeverity: 'low',
        maxAgentTurns: 10,
        maxFileFetches: 12,
        maxReviewSeconds: 60,
      });
    });

    it('upsert keeps one row and one settings row, and restores a removed repository', async () => {
      const repo = await makeRepository(db);
      await markRepositoriesRemoved(db, repo.installationId, [repo.githubRepositoryId]);
      const again = await upsertRepository(db, {
        installationId: repo.installationId,
        githubRepositoryId: repo.githubRepositoryId,
        fullName: 'octocat/renamed',
        ownerLogin: 'octocat',
        name: 'renamed',
      });
      expect(again.id).toBe(repo.id);
      expect(again).toMatchObject({
        fullName: 'octocat/renamed',
        removedAt: null,
        defaultBranch: 'main',
      });
    });

    it('rolls back the repository if creating its settings fails', async () => {
      const installation = await makeInstallation(db);
      await expect(
        db.transaction(async (tx) => {
          await upsertRepository(tx, {
            installationId: installation.id,
            githubRepositoryId: 424242,
            fullName: 'o/r',
            ownerLogin: 'o',
            name: 'r',
          });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await db.select().from(repositories)).toEqual([]);
    });
  });

  describe('review jobs', () => {
    it('creates one automatic job per repository, PR and head SHA', async () => {
      const repo = await makeRepository(db);
      const input = {
        repositoryId: repo.id,
        installationId: repo.installationId,
        pullRequestNumber: 3,
        headSha: 'abc',
        triggerType: 'automatic' as const,
        idempotencyKey: automaticReviewKey(repo.id, 3, 'abc'),
      };
      const first = await createReviewJob(db, input);
      const second = await createReviewJob(db, input);
      expect(first.created).toBe(true);
      expect(second).toEqual({ job: first.job, created: false });
      expect(first.job.status).toBe('PENDING');
    });

    it('rejects an idempotency key reused for a different commit', async () => {
      const { repository } = await makeReviewJob(db, 'abc');
      await expect(
        createReviewJob(db, {
          repositoryId: repository.id,
          installationId: repository.installationId,
          pullRequestNumber: 7,
          headSha: 'def',
          triggerType: 'automatic',
          idempotencyKey: automaticReviewKey(repository.id, 7, 'abc'),
        }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it('lets a manual re-review create a new job for the same commit', async () => {
      const { repository, job } = await makeReviewJob(db, 'abc');
      const manual = await createReviewJob(db, {
        repositoryId: repository.id,
        installationId: repository.installationId,
        pullRequestNumber: 7,
        headSha: 'abc',
        triggerType: 'manual',
        idempotencyKey: manualReviewKey('delivery-1'),
        githubEventId: 'delivery-1',
      });
      expect(manual.created).toBe(true);
      expect(manual.job.id).not.toBe(job.id);
    });

    it('completes a review with its findings and job status atomically', async () => {
      const { job } = await makeReviewJob(db);
      const result = await completeReview(db, {
        reviewJobId: job.id,
        jobStatus: 'SUCCEEDED',
        review: { provider: 'gemini', model: 'gemini-2.5-pro', status: 'SUCCEEDED', summary: 'ok' },
        findings: [
          {
            filename: 'a.ts',
            severity: 'high',
            startLine: 1,
            endLine: 2,
            issue: 'bug',
            fixType: 'warning',
          },
        ],
      });
      expect(result.findings).toHaveLength(1);
      const [stored] = await db.select().from(reviewJobs).where(eq(reviewJobs.id, job.id));
      expect(stored).toMatchObject({ status: 'SUCCEEDED' });
      expect(stored!.completedAt).toBeInstanceOf(Date);
    });

    it('replaces findings instead of duplicating them when completion is retried', async () => {
      const { job } = await makeReviewJob(db);
      const finding = {
        filename: 'a.ts',
        severity: 'high' as const,
        startLine: 1,
        endLine: 2,
        issue: 'bug',
        fixType: 'warning' as const,
      };
      const input = {
        reviewJobId: job.id,
        jobStatus: 'SUCCEEDED' as const,
        review: { provider: 'gemini', model: 'm', status: 'SUCCEEDED' as const },
        findings: [finding, { ...finding, startLine: 5, endLine: 5 }],
      };
      const first = await completeReview(db, input);
      const retry = await completeReview(db, input);
      expect(retry.review.id).toBe(first.review.id);
      expect(await db.select().from(reviews)).toHaveLength(1);
      expect(await db.select().from(reviewFindings)).toHaveLength(2);
    });

    it('rolls back the review and findings when a finding is invalid', async () => {
      const { job } = await makeReviewJob(db);
      await expect(
        completeReview(db, {
          reviewJobId: job.id,
          jobStatus: 'SUCCEEDED',
          review: { provider: 'gemini', model: 'm', status: 'SUCCEEDED' },
          findings: [
            {
              filename: 'a.ts',
              severity: 'high',
              startLine: 1,
              endLine: 1,
              issue: 'ok',
              fixType: 'warning',
            },
            {
              filename: 'a.ts',
              severity: 'high',
              startLine: 5,
              endLine: 2,
              issue: 'bad',
              fixType: 'warning',
            },
          ],
        }),
      ).rejects.toThrow();
      expect(await db.select().from(reviews)).toEqual([]);
      expect(await db.select().from(reviewFindings)).toEqual([]);
      const [stored] = await db.select().from(reviewJobs).where(eq(reviewJobs.id, job.id));
      expect(stored!.status).toBe('PENDING');
    });

    it('rolls back when the review job does not exist', async () => {
      await expect(
        completeReview(db, {
          reviewJobId: '00000000-0000-4000-8000-000000000000',
          jobStatus: 'FAILED',
          review: { provider: 'gemini', model: 'm', status: 'FAILED' },
          findings: [],
        }),
      ).rejects.toThrow();
      expect(await db.select().from(reviews)).toEqual([]);
    });
  });

  describe('webhook events', () => {
    it('records a delivery once and reports redeliveries', async () => {
      const first = await recordWebhookEvent(db, {
        githubEventId: 'delivery-7',
        eventName: 'pull_request',
        action: 'opened',
      });
      const again = await recordWebhookEvent(db, {
        githubEventId: 'delivery-7',
        eventName: 'pull_request',
      });
      expect(first.created).toBe(true);
      expect(again).toMatchObject({
        created: false,
        event: { id: first.event.id, action: 'opened' },
      });

      await markWebhookEvent(db, first.event.id, 'PROCESSED');
      const { event } = await recordWebhookEvent(db, {
        githubEventId: 'delivery-7',
        eventName: 'x',
      });
      expect(event.deliveryStatus).toBe('PROCESSED');
      expect(event.processedAt).toBeInstanceOf(Date);
    });
  });
});
