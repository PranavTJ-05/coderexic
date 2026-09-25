import 'server-only';
import {
  findLatestReviewJobForRepository,
  findRepositoryById,
  GitHubUserAccessError,
  listAuthorizedRepositories,
} from '@coderexic/core';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '../../../src/db';
import { getAccessToken } from '../../../src/session';
import { toRepositorySummaryDto } from '../../../src/dto';

/**
 * The dashboard's read model: every repository this user is authorized
 * for, paired with its most recent review job. One `findRepositoryById` +
 * one `findLatestReviewJobForRepository` per repository - acceptable here
 * since the list is bounded by how many repos a user's GitHub App
 * installations actually grant (not by review or finding volume, which is
 * paginated separately on the repository page).
 */
export async function GET(req: NextRequest) {
  const accessToken = await getAccessToken(req);
  if (!accessToken) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  }

  try {
    const authorized = await listAuthorizedRepositories(db().db, accessToken);
    const repositories = await Promise.all(
      authorized.map(async (entry) => {
        const repository = await findRepositoryById(db().db, entry.repositoryId);
        if (!repository) return null;
        const latestJob = await findLatestReviewJobForRepository(db().db, repository.id);
        return toRepositorySummaryDto(repository, latestJob);
      }),
    );
    return NextResponse.json({ repositories: repositories.filter((r) => r !== null) });
  } catch (err) {
    if (err instanceof GitHubUserAccessError && err.status === 401) {
      return NextResponse.json({ error: 'sign in again' }, { status: 401 });
    }
    throw err;
  }
}
