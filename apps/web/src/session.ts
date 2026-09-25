import 'server-only';
import { getToken } from 'next-auth/jwt';
import type { NextRequest } from 'next/server';
import { loadWebEnv } from './env';

/**
 * The signed-in user's GitHub access token, decoded server-side from the
 * encrypted session JWT (never exposed on the `session` object client JS
 * can read - see `auth.ts`). Returns `undefined` if there is no session or
 * it has no access token, same treatment either way: the caller responds
 * `401`.
 */
export async function getAccessToken(req: NextRequest): Promise<string | undefined> {
  const env = loadWebEnv();
  const token = await getToken({ req, secret: env.AUTH_SECRET });
  return token?.githubAccessToken;
}

/**
 * Both halves of the session a mutating route needs (Phase 13c): the
 * GitHub access token, to re-derive authorization/admin status from GitHub
 * itself, and this app's own `users.id` (`token.userId`, set by the `jwt`
 * callback's `upsertUser` call), to record who a repo-scoped BYOK
 * credential was added by. `undefined` if either is missing from the
 * token, same "not signed in" treatment as `getAccessToken`.
 */
export async function getSessionIdentity(
  req: NextRequest,
): Promise<{ accessToken: string; userId: string } | undefined> {
  const env = loadWebEnv();
  const token = await getToken({ req, secret: env.AUTH_SECRET });
  if (!token?.githubAccessToken || !token.userId) return undefined;
  return { accessToken: token.githubAccessToken, userId: token.userId };
}
