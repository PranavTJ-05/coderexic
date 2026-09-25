import {
  GitHubUserAccessError,
  listAuthorizedRepositories,
  markInstallationRemoved,
  markRepositoriesRemoved,
} from '@coderexic/core';
import { describe, expect, it, vi } from 'vitest';
import { makeInstallation, makeRepository } from './fixtures.js';
import { useTestDatabase } from '../helpers/db.js';

const { db } = useTestDatabase();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A single-page fetch mock: one installations page, one repos page per installation. */
function fakeFetch(
  installations: { id: number }[],
  reposByInstallation: Record<
    number,
    {
      id: number;
      full_name: string;
      permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
    }[]
  >,
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

describe('listAuthorizedRepositories', () => {
  it('returns only repos that are both GitHub-authorized and known, non-removed in our DB', async () => {
    const installation = await makeInstallation(db);
    const repository = await makeRepository(db, installation.id);
    const fetchImpl = fakeFetch([{ id: installation.githubInstallationId }], {
      [installation.githubInstallationId]: [
        {
          id: repository.githubRepositoryId,
          full_name: repository.fullName,
          permissions: { admin: true, pull: true, push: true },
        },
      ],
    });

    const result = await listAuthorizedRepositories(db, 'user-token', fetchImpl);

    expect(result).toEqual([
      {
        installationId: installation.id,
        githubInstallationId: installation.githubInstallationId,
        repositoryId: repository.id,
        githubRepositoryId: repository.githubRepositoryId,
        fullName: repository.fullName,
        isAdmin: true,
      },
    ]);
  });

  it('reports isAdmin: false for a repo where GitHub reports admin: false', async () => {
    const installation = await makeInstallation(db);
    const repository = await makeRepository(db, installation.id);
    const fetchImpl = fakeFetch([{ id: installation.githubInstallationId }], {
      [installation.githubInstallationId]: [
        {
          id: repository.githubRepositoryId,
          full_name: repository.fullName,
          permissions: { admin: false, pull: true, push: false },
        },
      ],
    });

    const [result] = await listAuthorizedRepositories(db, 'user-token', fetchImpl);
    expect(result?.isAdmin).toBe(false);
  });

  it('fails closed to isAdmin: false when GitHub omits permissions entirely', async () => {
    const installation = await makeInstallation(db);
    const repository = await makeRepository(db, installation.id);
    const fetchImpl = fakeFetch([{ id: installation.githubInstallationId }], {
      [installation.githubInstallationId]: [
        { id: repository.githubRepositoryId, full_name: repository.fullName },
      ],
    });

    const [result] = await listAuthorizedRepositories(db, 'user-token', fetchImpl);
    expect(result?.isAdmin).toBe(false);
  });

  it('excludes an installation GitHub reports but our DB does not know about', async () => {
    const fetchImpl = fakeFetch([{ id: 999_999 }], {});
    const result = await listAuthorizedRepositories(db, 'user-token', fetchImpl);
    expect(result).toEqual([]);
  });

  it('excludes a repository GitHub reports that was deselected (removed) in our DB', async () => {
    const installation = await makeInstallation(db);
    const repository = await makeRepository(db, installation.id);
    await markRepositoriesRemoved(db, installation.id, [repository.githubRepositoryId]);
    const fetchImpl = fakeFetch([{ id: installation.githubInstallationId }], {
      [installation.githubInstallationId]: [
        { id: repository.githubRepositoryId, full_name: repository.fullName },
      ],
    });

    const result = await listAuthorizedRepositories(db, 'user-token', fetchImpl);

    expect(result).toEqual([]);
  });

  it('excludes a repository GitHub reports that our DB never indexed (never trusts GitHub alone)', async () => {
    const installation = await makeInstallation(db);
    const fetchImpl = fakeFetch([{ id: installation.githubInstallationId }], {
      [installation.githubInstallationId]: [{ id: 42, full_name: 'octocat/unknown' }],
    });

    const result = await listAuthorizedRepositories(db, 'user-token', fetchImpl);

    expect(result).toEqual([]);
  });

  it('excludes an installation GitHub still reports as authorized after it was uninstalled in our DB', async () => {
    const installation = await makeInstallation(db);
    const repository = await makeRepository(db, installation.id);
    await markInstallationRemoved(db, installation.githubInstallationId);
    const fetchImpl = fakeFetch([{ id: installation.githubInstallationId }], {
      [installation.githubInstallationId]: [
        { id: repository.githubRepositoryId, full_name: repository.fullName },
      ],
    });

    const result = await listAuthorizedRepositories(db, 'user-token', fetchImpl);

    expect(result).toEqual([]);
  });

  it('throws GitHubUserAccessError with the status on an expired/revoked token', async () => {
    const fetchImpl = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('{}', { status: 401 }));

    const err = await listAuthorizedRepositories(db, 'expired-token', fetchImpl).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GitHubUserAccessError);
    expect((err as GitHubUserAccessError).status).toBe(401);
  });

  it('sends the user access token as a bearer token, never a query param', async () => {
    const fetchImpl = fakeFetch([], {});
    await listAuthorizedRepositories(db, 'secret-user-token', fetchImpl);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('secret-user-token');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret-user-token');
  });
});
