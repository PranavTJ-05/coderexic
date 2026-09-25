import 'server-only';
import {
  findAuthorizedRepository,
  findRepositoryById,
  getRepositorySettings,
  GitHubUserAccessError,
  listReviewJobsForRepository,
} from '@coderexic/core';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '../../../../src/db';
import { getAccessToken } from '../../../../src/session';
import { toRepositoryDetailDto, toReviewJobSummaryDto } from '../../../../src/dto';

const PAGE_SIZE = 20;

/**
 * Repository detail + a page of its review history. Authorization is
 * checked against GitHub itself (`findAuthorizedRepository`), not by
 * trusting the `repositoryId` in the URL - the same rule
 * `listAuthorizedRepositories` enforces for the dashboard.
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
    const settings = await getRepositorySettings(db().db, repositoryId);
    const jobs = await listReviewJobsForRepository(db().db, repositoryId, {
      limit: PAGE_SIZE + 1,
      offset,
    });
    const hasMore = jobs.length > PAGE_SIZE;
    return NextResponse.json({
      repository: toRepositoryDetailDto(repository, settings),
      reviews: jobs.slice(0, PAGE_SIZE).map(toReviewJobSummaryDto),
      hasMore,
    });
  } catch (err) {
    if (err instanceof GitHubUserAccessError && err.status === 401) {
      return NextResponse.json({ error: 'sign in again' }, { status: 401 });
    }
    throw err;
  }
}
