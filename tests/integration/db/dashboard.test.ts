import {
  automaticReviewKey,
  completeReview,
  createReviewJob,
  findAuthorizedRepository,
  findAuthorizedReviewJob,
  findLatestReviewJobForRepository,
  findReviewWithFindings,
  getRepositoryUsageSummary,
  listReviewJobsForRepository,
  markRepositoriesRemoved,
} from '@coderexic/core';
import { describe, expect, it, vi } from 'vitest';
import { makeInstallation, makeRepository, makeReviewJob } from './fixtures.js';
import { useTestDatabase } from '../helpers/db.js';

const { db } = useTestDatabase();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Mirrors tests/integration/db/user-access.test.ts's fakeFetch. */
function fakeFetch(
  installations: { id: number }[],
  reposByInstallation: Record<number, { id: number; full_name: string }[]>,
) {
  return vi.fn<typeof globalThis.fetch>().mockImplementation((url) => {
    const href = url as string;
    if (href.includes('/user/installations?')) {
      return Promise.resolve(jsonResponse({ total_count: installations.length, installations }));
    }
    const match = /\/user\/installations\/(\d+)\/repositories/.exec(href);
    if (match) {
      const id = Number(match[1]);
      const repos = reposByInstallation[id] ?? [];
      return Promise.resolve(jsonResponse({ total_count: repos.length, repositories: repos }));
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
}

async function makeJobOn(
  repository: Awaited<ReturnType<typeof makeRepository>>,
  pullRequestNumber: number,
  headSha: string,
) {
  return createReviewJob(db, {
    repositoryId: repository.id,
    installationId: repository.installationId,
    pullRequestNumber,
    headSha,
    triggerType: 'automatic',
    idempotencyKey: automaticReviewKey(repository.id, pullRequestNumber, headSha),
  });
}

describe('listReviewJobsForRepository / findLatestReviewJobForRepository', () => {
  it('orders newest first and pairs each job with its review and finding count', async () => {
    const repository = await makeRepository(db);
    const { job: first } = await makeJobOn(repository, 1, 'a'.repeat(40));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { job: second } = await makeJobOn(repository, 2, 'b'.repeat(40));
    await completeReview(db, {
      reviewJobId: second.id,
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
        {
          filename: 'b.ts',
          severity: 'low',
          startLine: 3,
          endLine: 3,
          issue: 'nit',
          fixType: 'warning',
        },
      ],
    });

    const rows = await listReviewJobsForRepository(db, repository.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.job.id).toBe(second.id);
    expect(rows[0]!.review?.summary).toBe('ok');
    expect(rows[0]!.findingsCount).toBe(2);
    expect(rows[1]!.job.id).toBe(first.id);
    expect(rows[1]!.review).toBeNull();
    expect(rows[1]!.findingsCount).toBe(0);

    const latest = await findLatestReviewJobForRepository(db, repository.id);
    expect(latest?.job.id).toBe(second.id);
  });

  it('paginates with limit/offset', async () => {
    const repository = await makeRepository(db);
    for (let i = 0; i < 3; i++) {
      await makeJobOn(repository, i + 1, `${i}`.repeat(40));
    }
    const page1 = await listReviewJobsForRepository(db, repository.id, { limit: 2, offset: 0 });
    const page2 = await listReviewJobsForRepository(db, repository.id, { limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(1);
  });
});

describe('findReviewWithFindings', () => {
  it('returns the review and its findings ordered by line', async () => {
    const { job } = await makeReviewJob(db);
    await completeReview(db, {
      reviewJobId: job.id,
      jobStatus: 'SUCCEEDED',
      review: { provider: 'gemini', model: 'gemini-2.5-pro', status: 'SUCCEEDED', summary: 'ok' },
      findings: [
        {
          filename: 'b.ts',
          severity: 'low',
          startLine: 9,
          endLine: 9,
          issue: 'later',
          fixType: 'warning',
        },
        {
          filename: 'a.ts',
          severity: 'high',
          startLine: 1,
          endLine: 1,
          issue: 'first',
          fixType: 'warning',
        },
      ],
    });

    const result = await findReviewWithFindings(db, job.id);
    expect(result?.review.summary).toBe('ok');
    expect(result?.findings.map((f) => f.issue)).toEqual(['first', 'later']);
  });

  it('returns undefined for a job with no completed review yet', async () => {
    const { job } = await makeReviewJob(db);
    expect(await findReviewWithFindings(db, job.id)).toBeUndefined();
  });
});

describe('findAuthorizedRepository / findAuthorizedReviewJob', () => {
  it('returns the repository when GitHub and our DB agree the user is authorized', async () => {
    const installation = await makeInstallation(db);
    const repository = await makeRepository(db, installation.id);
    const fetchImpl = fakeFetch([{ id: installation.githubInstallationId }], {
      [installation.githubInstallationId]: [
        { id: repository.githubRepositoryId, full_name: repository.fullName },
      ],
    });

    const result = await findAuthorizedRepository(db, 'user-token', repository.id, fetchImpl);
    expect(result?.repositoryId).toBe(repository.id);
  });

  it('returns undefined for a repository the user is not authorized for', async () => {
    const installation = await makeInstallation(db);
    const repository = await makeRepository(db, installation.id);
    const fetchImpl = fakeFetch([], {});

    expect(
      await findAuthorizedRepository(db, 'user-token', repository.id, fetchImpl),
    ).toBeUndefined();
  });

  it("returns the job when the user is authorized for the job's own repository", async () => {
    const installation = await makeInstallation(db);
    const repository = await makeRepository(db, installation.id);
    const { job } = await makeJobOn(repository, 1, 'a'.repeat(40));
    const fetchImpl = fakeFetch([{ id: installation.githubInstallationId }], {
      [installation.githubInstallationId]: [
        { id: repository.githubRepositoryId, full_name: repository.fullName },
      ],
    });

    const result = await findAuthorizedReviewJob(db, 'user-token', job.id, fetchImpl);
    expect(result?.id).toBe(job.id);
  });

  it('never authorizes a job by matching a different, authorized repository (cross-repo protection)', async () => {
    const installationA = await makeInstallation(db);
    const repoA = await makeRepository(db, installationA.id);
    const { job: jobOnRepoB } = await makeReviewJob(db); // a different repository entirely

    // The user is authorized for repoA only.
    const fetchImpl = fakeFetch([{ id: installationA.githubInstallationId }], {
      [installationA.githubInstallationId]: [
        { id: repoA.githubRepositoryId, full_name: repoA.fullName },
      ],
    });

    const result = await findAuthorizedReviewJob(db, 'user-token', jobOnRepoB.id, fetchImpl);
    expect(result).toBeUndefined();
  });

  it('returns undefined for a job belonging to a removed repository', async () => {
    const installation = await makeInstallation(db);
    const repository = await makeRepository(db, installation.id);
    const { job } = await makeJobOn(repository, 1, 'a'.repeat(40));
    await markRepositoriesRemoved(db, installation.id, [repository.githubRepositoryId]);

    const fetchImpl = fakeFetch([{ id: installation.githubInstallationId }], {
      [installation.githubInstallationId]: [
        { id: repository.githubRepositoryId, full_name: repository.fullName },
      ],
    });

    expect(await findAuthorizedReviewJob(db, 'user-token', job.id, fetchImpl)).toBeUndefined();
  });

  it('returns undefined for a nonexistent job id', async () => {
    const fetchImpl = fakeFetch([], {});
    expect(
      await findAuthorizedReviewJob(
        db,
        'user-token',
        '00000000-0000-0000-0000-000000000000',
        fetchImpl,
      ),
    ).toBeUndefined();
  });

  it('returns undefined for an ill-formed job id without querying the database', async () => {
    // reviewJobs.id is a uuid column - an unvalidated id from a route
    // param would otherwise reach Postgres as `invalid input syntax for
    // type uuid`, a 500 rather than a clean 404.
    const fetchImpl = fakeFetch([], {});
    expect(
      await findAuthorizedReviewJob(db, 'user-token', 'not-a-uuid', fetchImpl),
    ).toBeUndefined();
  });
});

describe('getRepositoryUsageSummary', () => {
  it('sums tokens/duration across reviews and breaks jobs down by status', async () => {
    const repository = await makeRepository(db);
    const { job: succeeded1 } = await createReviewJob(db, {
      repositoryId: repository.id,
      installationId: repository.installationId,
      pullRequestNumber: 1,
      headSha: 'a'.repeat(40),
      triggerType: 'automatic',
      idempotencyKey: automaticReviewKey(repository.id, 1, 'a'.repeat(40)),
    });
    await completeReview(db, {
      reviewJobId: succeeded1.id,
      jobStatus: 'SUCCEEDED',
      review: {
        provider: 'gemini',
        model: 'gemini-2.5-pro',
        status: 'SUCCEEDED',
        inputTokens: 1000,
        outputTokens: 200,
        durationMs: 5000,
      },
      findings: [],
    });

    const { job: succeeded2 } = await createReviewJob(db, {
      repositoryId: repository.id,
      installationId: repository.installationId,
      pullRequestNumber: 2,
      headSha: 'b'.repeat(40),
      triggerType: 'automatic',
      idempotencyKey: automaticReviewKey(repository.id, 2, 'b'.repeat(40)),
    });
    await completeReview(db, {
      reviewJobId: succeeded2.id,
      jobStatus: 'SUCCEEDED',
      review: {
        provider: 'gemini',
        model: 'gemini-2.5-pro',
        status: 'SUCCEEDED',
        inputTokens: 500,
        outputTokens: 100,
        durationMs: 3000,
      },
      findings: [],
    });

    await createReviewJob(db, {
      repositoryId: repository.id,
      installationId: repository.installationId,
      pullRequestNumber: 3,
      headSha: 'c'.repeat(40),
      triggerType: 'automatic',
      idempotencyKey: automaticReviewKey(repository.id, 3, 'c'.repeat(40)),
    });
    // A third job stays PENDING (no review row) - proves jobCountByStatus
    // counts jobs, not reviews, and PENDING contributes nothing to the sums.

    const summary = await getRepositoryUsageSummary(db, repository.id);
    expect(summary).toEqual({
      reviewCount: 2,
      totalInputTokens: 1500,
      totalOutputTokens: 300,
      totalDurationMs: 8000,
      jobCountByStatus: { SUCCEEDED: 2, PENDING: 1 },
    });
  });

  it('returns all-zero for a repository with no review history', async () => {
    const repository = await makeRepository(db);
    expect(await getRepositoryUsageSummary(db, repository.id)).toEqual({
      reviewCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalDurationMs: 0,
      jobCountByStatus: {},
    });
  });
});
