import 'server-only';
import { GitHubUserAccessError, listAuthorizedRepositories } from '@coderexic/core';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '../../../src/db';
import { toAuthorizedRepositoryDto } from '../../../src/dto';
import { getAccessToken } from '../../../src/session';

/**
 * The repositories this signed-in user is authorized to see (Phase 13a).
 * `/api/dashboard` (Phase 13b) is what the dashboard UI actually calls -
 * it wraps this same authorization check with per-repository index/review
 * status. This route is kept as the minimal, UI-independent version of the
 * same check.
 */
export async function GET(req: NextRequest) {
  const accessToken = await getAccessToken(req);
  if (!accessToken) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  }
  try {
    const repositories = await listAuthorizedRepositories(db().db, accessToken);
    return NextResponse.json({ repositories: repositories.map(toAuthorizedRepositoryDto) });
  } catch (err) {
    // A GitHub App user token expires (8h by default) - GitHub's own 401
    // here means "sign in again," not a bug. Anything else is a genuine
    // upstream failure.
    if (err instanceof GitHubUserAccessError && err.status === 401) {
      return NextResponse.json({ error: 'sign in again' }, { status: 401 });
    }
    throw err;
  }
}
