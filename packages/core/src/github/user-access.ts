import { z } from 'zod';
import type { Executor } from '../db/client.js';
import { findInstallationByGithubId } from '../db/store/installations.js';
import { findRepository } from '../db/store/repositories.js';
import { findReviewJobById, type ReviewJob } from '../db/store/review-jobs.js';

/**
 * A `listAuthorizedRepositories` call failed against GitHub's API itself -
 * distinct from "authorized, but nothing found." `status` lets a caller
 * tell an expired/revoked token (401 - GitHub App user tokens expire after
 * 8h unless the App opts out) from a transient failure.
 */
export class GitHubUserAccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubUserAccessError';
  }
}

export interface AuthorizedRepository {
  installationId: string;
  githubInstallationId: number;
  repositoryId: string;
  githubRepositoryId: number;
  fullName: string;
  /**
   * The signed-in user's own admin permission on this repository, from
   * GitHub's `permissions.admin` (verified against GitHub's own OpenAPI
   * spec: `GET /user/installations/{id}/repositories` returns the shared
   * `repository` schema, which includes `permissions`). `permissions`
   * itself isn't a required field on that shared schema, so a missing
   * value is treated as "not admin" (fail closed) rather than assumed.
   * This is the gate for repo-level settings writes (model provider/name,
   * BYOK credentials, ignore patterns) - a member who can merely see the
   * repo through an org's "all repositories" install must not be able to
   * change what it costs or which key it bills.
   */
  isAdmin: boolean;
}

interface GitHubInstallationSummary {
  id: number;
}
interface GitHubRepoSummary {
  id: number;
  full_name: string;
  permissions?: {
    admin?: boolean;
    push?: boolean;
    pull?: boolean;
    maintain?: boolean;
    triage?: boolean;
  };
}

async function paginateGitHub<T>(
  path: string,
  key: string,
  userAccessToken: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<T[]> {
  const results: T[] = [];
  for (let page = 1; ; page++) {
    const separator = path.includes('?') ? '&' : '?';
    const response = await fetchImpl(
      `https://api.github.com${path}${separator}per_page=100&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${userAccessToken}`,
          accept: 'application/vnd.github+json',
        },
      },
    );
    if (!response.ok) {
      throw new GitHubUserAccessError(
        `GitHub API request to ${path} failed with status ${response.status}`,
        response.status,
      );
    }
    const body = (await response.json()) as Record<string, unknown>;
    const items = body[key];
    if (!Array.isArray(items) || items.length === 0) break;
    results.push(...(items as T[]));
    if (items.length < 100) break;
  }
  return results;
}

/**
 * Every repository this GitHub user is actually authorized to see through
 * the app, for the web dashboard's repo list (Phase 13a). Uses the user's
 * own GitHub App user-to-server access token (from the OAuth callback,
 * never the app's installation token) so the answer reflects GitHub's own
 * membership/permission model - including an org's "selected repositories"
 * install, where a member sees only some of the org's repos even though
 * the org owner sees all of them. Never authorizes by `owner_login`
 * matching or a client-supplied installation id; every result is cross-
 * checked against our own DB (`removed_at is null`), so a deselected
 * repository or an uninstalled app never shows up even if GitHub's API is
 * momentarily stale (PRODUCT_SPEC.md §17.10, no cross-user/cross-repo
 * leakage).
 */
export async function listAuthorizedRepositories(
  db: Executor,
  userAccessToken: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<AuthorizedRepository[]> {
  const installations = await paginateGitHub<GitHubInstallationSummary>(
    '/user/installations',
    'installations',
    userAccessToken,
    fetchImpl,
  );

  const results: AuthorizedRepository[] = [];
  for (const installation of installations) {
    const known = await findInstallationByGithubId(db, installation.id);
    if (!known || known.removedAt) continue;

    const repos = await paginateGitHub<GitHubRepoSummary>(
      `/user/installations/${installation.id}/repositories`,
      'repositories',
      userAccessToken,
      fetchImpl,
    );
    for (const repo of repos) {
      const knownRepo = await findRepository(db, known.id, repo.id);
      if (!knownRepo || knownRepo.removedAt) continue;
      results.push({
        installationId: known.id,
        githubInstallationId: installation.id,
        repositoryId: knownRepo.id,
        githubRepositoryId: repo.id,
        fullName: knownRepo.fullName,
        isAdmin: repo.permissions?.admin ?? false,
      });
    }
  }
  return results;
}

/**
 * A single repository from `listAuthorizedRepositories`, for a route that
 * already knows which repository it wants (e.g. `/repos/[repositoryId]`)
 * rather than needing the whole list. Still makes the full GitHub round
 * trip - there's no cheaper authorized check than "ask GitHub" - but
 * callers that already have the list (the dashboard) should filter it
 * client-side instead of calling this per repository.
 */
export async function findAuthorizedRepository(
  db: Executor,
  userAccessToken: string,
  repositoryId: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<AuthorizedRepository | undefined> {
  const repos = await listAuthorizedRepositories(db, userAccessToken, fetchImpl);
  return repos.find((repo) => repo.repositoryId === repositoryId);
}

/**
 * A review job, only if the signed-in user is authorized for *the job's
 * own* repository - not the repository named in whatever URL the caller
 * came from. Prevents a user authorized for repo A from reading repo B's
 * findings by pasting repo B's job id into repo A's URL. Returns
 * `undefined` (never a distinct "forbidden" signal) both when the job
 * doesn't exist and when it isn't authorized, so a route can 404 either
 * way without leaking which case it was.
 */
export async function findAuthorizedReviewJob(
  db: Executor,
  userAccessToken: string,
  reviewJobId: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ReviewJob | undefined> {
  // reviewJobs.id is a uuid column - an ill-formed id (e.g. from a route
  // param a caller can type anything into) would otherwise reach Postgres
  // as `invalid input syntax for type uuid`, a 500 instead of the 404 an
  // unauthorized/nonexistent id gets.
  if (!z.uuid().safeParse(reviewJobId).success) return undefined;
  const job = await findReviewJobById(db, reviewJobId);
  if (!job) return undefined;
  const authorized = await findAuthorizedRepository(
    db,
    userAccessToken,
    job.repositoryId,
    fetchImpl,
  );
  return authorized ? job : undefined;
}
