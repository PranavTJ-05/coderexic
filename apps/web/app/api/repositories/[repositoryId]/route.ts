import 'server-only';
import {
  findAuthorizedRepository,
  findRepositoryById,
  getRepositorySettings,
  getRepositoryUsageSummary,
  GitHubUserAccessError,
  listIgnorePatterns,
  listModelCredentials,
  listReviewJobsForRepository,
} from '@coderexic/core';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '../../../../src/db';
import { getAccessToken } from '../../../../src/session';
import { getModelCredentialsConfig } from '../../../../src/model-credentials';
import {
  toModelCredentialDto,
  toRepositoryDetailDto,
  toRepositoryUsageDto,
  toReviewJobSummaryDto,
} from '../../../../src/dto';

const PAGE_SIZE = 20;

/**
 * Repository detail + settings-page read model + a page of review history,
 * in one response - every authorized user can read it (`isAdmin` tells the
 * page whether to render write controls; the actual writes go through
 * `/settings`, `/ignore-patterns` and `/credentials`, each independently
 * admin-gated - this route never trusts a client-supplied `isAdmin`).
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ repositoryId: string }> },
) {
  const accessToken = await getAccessToken(req);
  if (!accessToken) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  }

  const { repositoryId } = await context.params;
  const offset = Math.max(
    0,
    Math.floor(Number(req.nextUrl.searchParams.get('offset') ?? '0') || 0),
  );

  try {
    const authorized = await findAuthorizedRepository(db().db, accessToken, repositoryId);
    if (!authorized) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    const repository = await findRepositoryById(db().db, repositoryId);
    if (!repository) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    const [settings, jobs, ignorePatterns, usage] = await Promise.all([
      getRepositorySettings(db().db, repositoryId),
      listReviewJobsForRepository(db().db, repositoryId, { limit: PAGE_SIZE + 1, offset }),
      listIgnorePatterns(db().db, repositoryId),
      getRepositoryUsageSummary(db().db, repositoryId),
    ]);
    // BYOK credential metadata and whether this deployment even has BYOK
    // configured are admin-only information, not fetched at all for a
    // merely-authorized (non-admin) viewer.
    const credentials = authorized.isAdmin
      ? await listModelCredentials(db().db, { repositoryId })
      : [];
    const hasMore = jobs.length > PAGE_SIZE;
    return NextResponse.json({
      repository: toRepositoryDetailDto(repository, settings),
      isAdmin: authorized.isAdmin,
      reviews: jobs.slice(0, PAGE_SIZE).map(toReviewJobSummaryDto),
      hasMore,
      ignorePatterns,
      credentials: credentials.map(toModelCredentialDto),
      byokConfigured: authorized.isAdmin ? getModelCredentialsConfig() !== null : false,
      usage: toRepositoryUsageDto(usage),
    });
  } catch (err) {
    if (err instanceof GitHubUserAccessError && err.status === 401) {
      return NextResponse.json({ error: 'sign in again' }, { status: 401 });
    }
    throw err;
  }
}
