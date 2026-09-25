import 'server-only';
import {
  createDatabase,
  GitHubUserAccessError,
  listAuthorizedRepositories,
  type DatabaseHandle,
} from '@coderexic/core';
import { getToken } from 'next-auth/jwt';
import { NextResponse, type NextRequest } from 'next/server';
import { loadWebEnv } from '../../../src/env';

let handle: DatabaseHandle | undefined;
/**
 * Built lazily, not at module scope: `next build` statically imports route
 * modules to "collect page data", which must succeed without real secrets
 * present (see `src/auth.ts`'s `getAuthOptions` for the same reasoning).
 */
function db(): DatabaseHandle {
  handle ??= createDatabase({ url: loadWebEnv().DATABASE_URL });
  return handle;
}

/**
 * The repositories this signed-in user is authorized to see (Phase 13a).
 * Reads the GitHub access token straight off the encrypted session JWT via
 * `getToken` - it's never exposed on the `session` object client JS can
 * read from `/api/auth/session`, only decodable here with `AUTH_SECRET`.
 */
export async function GET(req: NextRequest) {
  const env = loadWebEnv();
  const token = await getToken({ req, secret: env.AUTH_SECRET });
  const accessToken = token?.githubAccessToken;
  if (!accessToken) {
    return NextResponse.json({ error: 'not signed in' }, { status: 401 });
  }
  try {
    const repositories = await listAuthorizedRepositories(db().db, accessToken);
    return NextResponse.json({ repositories });
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
