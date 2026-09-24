import {
  dependencyEdges,
  ignorePatterns,
  installations,
  modelCredentials,
  repositories,
  reviewFindings,
  reviews,
  users,
  webhookEvents,
} from '@coderexic/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PG, pgErrorCode, useTestDatabase } from '../helpers/db.js';
import { makeInstallation, makeRepository, makeReviewJob } from './fixtures.js';

describe('schema constraints', () => {
  const { db } = useTestDatabase();

  describe('CRUD', () => {
    it('creates, reads, updates and deletes a user', async () => {
      const [created] = await db
        .insert(users)
        .values({ githubUserId: 42, login: 'octocat' })
        .returning();
      expect(created).toMatchObject({ githubUserId: 42, login: 'octocat', email: null });
      expect(created!.id).toMatch(/^[0-9a-f-]{36}$/);

      const [updated] = await db
        .update(users)
        .set({ displayName: 'The Octocat' })
        .where(eq(users.id, created!.id))
        .returning();
      expect(updated!.displayName).toBe('The Octocat');
      expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(created!.updatedAt.getTime());

      await db.delete(users).where(eq(users.id, created!.id));
      expect(await db.select().from(users)).toEqual([]);
    });

    it('stores GitHub IDs above 2^31 as numbers', async () => {
      const [row] = await db
        .insert(installations)
        .values({
          githubInstallationId: 90_123_456_789,
          ownerType: 'Organization',
          ownerLogin: 'acme',
        })
        .returning();
      expect(row!.githubInstallationId).toBe(90_123_456_789);
    });
  });

  describe('uniqueness', () => {
    it('rejects a duplicate GitHub user', async () => {
      await db.insert(users).values({ githubUserId: 1, login: 'a' });
      expect(await pgErrorCode(db.insert(users).values({ githubUserId: 1, login: 'b' }))).toBe(
        PG.uniqueViolation,
      );
    });

    it('rejects the same GitHub repository twice in one installation', async () => {
      const repo = await makeRepository(db);
      const duplicate = db.insert(repositories).values({
        installationId: repo.installationId,
        githubRepositoryId: repo.githubRepositoryId,
        fullName: repo.fullName,
        ownerLogin: repo.ownerLogin,
        name: repo.name,
      });
      expect(await pgErrorCode(duplicate)).toBe(PG.uniqueViolation);
    });

    it('rejects a duplicate dependency edge and ignore pattern', async () => {
      const repo = await makeRepository(db);
      const edge = {
        repositoryId: repo.id,
        sourcePath: 'a.ts',
        targetPath: 'b.ts',
        commitSha: 'c1',
      };
      await db.insert(dependencyEdges).values(edge);
      expect(await pgErrorCode(db.insert(dependencyEdges).values(edge))).toBe(PG.uniqueViolation);

      await db.insert(ignorePatterns).values({ repositoryId: repo.id, pattern: 'dist/**' });
      expect(
        await pgErrorCode(
          db.insert(ignorePatterns).values({ repositoryId: repo.id, pattern: 'dist/**' }),
        ),
      ).toBe(PG.uniqueViolation);
    });

    it('rejects a duplicate webhook delivery ID', async () => {
      await db.insert(webhookEvents).values({ githubEventId: 'd-1', eventName: 'push' });
      expect(
        await pgErrorCode(
          db.insert(webhookEvents).values({ githubEventId: 'd-1', eventName: 'push' }),
        ),
      ).toBe(PG.uniqueViolation);
    });

    it('allows only one review per review job', async () => {
      const { job } = await makeReviewJob(db);
      const review = { reviewJobId: job.id, provider: 'gemini', model: 'gemini-2.5-pro' };
      await db.insert(reviews).values(review);
      expect(await pgErrorCode(db.insert(reviews).values(review))).toBe(PG.uniqueViolation);
    });
  });

  describe('foreign keys', () => {
    it('rejects a repository for a missing installation', async () => {
      const orphan = db.insert(repositories).values({
        installationId: '00000000-0000-4000-8000-000000000000',
        githubRepositoryId: 1,
        fullName: 'x/y',
        ownerLogin: 'x',
        name: 'y',
      });
      expect(await pgErrorCode(orphan)).toBe(PG.foreignKeyViolation);
    });

    it('rejects a finding for a missing review', async () => {
      const orphan = db.insert(reviewFindings).values({
        reviewId: '00000000-0000-4000-8000-000000000000',
        filename: 'a.ts',
        severity: 'low',
        startLine: 1,
        endLine: 1,
        issue: 'x',
        fixType: 'warning',
      });
      expect(await pgErrorCode(orphan)).toBe(PG.foreignKeyViolation);
    });
  });

  describe('check constraints', () => {
    async function insertFinding(overrides: Partial<typeof reviewFindings.$inferInsert>) {
      const { job } = await makeReviewJob(db, overrides.issue ?? 'f'.repeat(40));
      const [review] = await db
        .insert(reviews)
        .values({ reviewJobId: job.id, provider: 'gemini', model: 'm' })
        .returning();
      return db.insert(reviewFindings).values({
        reviewId: review!.id,
        filename: 'a.ts',
        severity: 'high',
        startLine: 3,
        endLine: 4,
        issue: 'issue',
        fixType: 'warning',
        ...overrides,
      });
    }

    it('rejects an unknown severity or fix type', async () => {
      expect(await pgErrorCode(insertFinding({ issue: '1', severity: 'blocker' as never }))).toBe(
        PG.checkViolation,
      );
      expect(await pgErrorCode(insertFinding({ issue: '2', fixType: 'patch' as never }))).toBe(
        PG.checkViolation,
      );
    });

    it('rejects line ranges that start below 1 or run backwards', async () => {
      expect(await pgErrorCode(insertFinding({ issue: '3', startLine: 0, endLine: 1 }))).toBe(
        PG.checkViolation,
      );
      expect(await pgErrorCode(insertFinding({ issue: '4', startLine: 10, endLine: 9 }))).toBe(
        PG.checkViolation,
      );
    });

    it('rejects confidence outside 0..1 and accepts a valid finding', async () => {
      expect(await pgErrorCode(insertFinding({ issue: '5', confidence: 1.5 }))).toBe(
        PG.checkViolation,
      );
      await expect(insertFinding({ issue: '6', confidence: 0.8 })).resolves.toBeDefined();
    });

    it('rejects an unknown repository index status', async () => {
      const repo = await makeRepository(db);
      const bad = db
        .update(repositories)
        .set({ indexStatus: 'DONE' as never })
        .where(eq(repositories.id, repo.id));
      expect(await pgErrorCode(bad)).toBe(PG.checkViolation);
    });
  });

  describe('cascading behaviour', () => {
    it('deleting a repository removes its settings, edges, jobs, reviews and findings', async () => {
      const { repository, job } = await makeReviewJob(db);
      await db.insert(dependencyEdges).values({
        repositoryId: repository.id,
        sourcePath: 'a.ts',
        targetPath: 'b.ts',
        commitSha: 'c',
      });
      const [review] = await db
        .insert(reviews)
        .values({ reviewJobId: job.id, provider: 'gemini', model: 'm' })
        .returning();
      await db.insert(reviewFindings).values({
        reviewId: review!.id,
        filename: 'a.ts',
        severity: 'low',
        startLine: 1,
        endLine: 1,
        issue: 'x',
        fixType: 'warning',
      });

      await db.delete(repositories).where(eq(repositories.id, repository.id));

      const counts = await Promise.all(
        [dependencyEdges, reviews, reviewFindings].map(
          async (table) => (await db.select().from(table)).length,
        ),
      );
      expect(counts).toEqual([0, 0, 0]);
    });

    it('deleting a user keeps their installation but clears the creator link', async () => {
      const [user] = await db.insert(users).values({ githubUserId: 9, login: 'u' }).returning();
      const installation = await makeInstallation(db);
      await db
        .update(installations)
        .set({ createdByUserId: user!.id })
        .where(eq(installations.id, installation.id));
      await db.insert(modelCredentials).values({
        userId: user!.id,
        provider: 'gemini',
        encryptedSecret: 'v1:ciphertext',
        keyVersion: 1,
      });

      await db.delete(users).where(eq(users.id, user!.id));

      const [kept] = await db
        .select()
        .from(installations)
        .where(eq(installations.id, installation.id));
      expect(kept!.createdByUserId).toBeNull();
      expect(await db.select().from(modelCredentials)).toEqual([]);
    });

    it('deleting an installation keeps its webhook events but unlinks them', async () => {
      const installation = await makeInstallation(db);
      await db.insert(webhookEvents).values({
        githubEventId: 'd-9',
        eventName: 'installation',
        installationId: installation.id,
      });
      await db.delete(installations).where(eq(installations.id, installation.id));
      const [event] = await db.select().from(webhookEvents);
      expect(event!.installationId).toBeNull();
    });
  });
});
