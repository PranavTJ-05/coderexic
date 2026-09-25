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
