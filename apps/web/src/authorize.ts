import 'server-only';
import {
  findAuthorizedRepository,
  GitHubUserAccessError,
  type AuthorizedRepository,
} from '@coderexic/core';
import { NextResponse, type NextRequest } from 'next/server';
import { db } from './db';
import { getSessionIdentity } from './session';

export interface AuthorizedContext {
  accessToken: string;
  userId: string;
  repository: AuthorizedRepository;
}

/**
 * The gate every repo-scoped write route (Phase 13c: settings, ignore
 * patterns, BYOK credentials) shares: signed in, authorized for *this*
 * repository (re-derived from GitHub, never trusted from the URL - same
 * rule as every 13b read route), and specifically a repo *admin* on
 * GitHub (`permissions.admin`) - a member who can merely see the repo
 * through an org's "all repositories" install must not be able to change
 * what a review costs or which key bills it. Returns the response to send
 * as-is on failure so a route just does `const ctx = await
 * requireRepoAdmin(...); if (!ctx.ok) return ctx.response;`.
 */
export async function requireRepoAdmin(
  req: NextRequest,
  repositoryId: string,
): Promise<{ ok: true; ctx: AuthorizedContext } | { ok: false; response: NextResponse }> {
  const identity = await getSessionIdentity(req);
  if (!identity) {
    return { ok: false, response: NextResponse.json({ error: 'not signed in' }, { status: 401 }) };
  }
  try {
    const repository = await findAuthorizedRepository(db().db, identity.accessToken, repositoryId);
    if (!repository) {
      return { ok: false, response: NextResponse.json({ error: 'not found' }, { status: 404 }) };
    }
    if (!repository.isAdmin) {
      return {
        ok: false,
        response: NextResponse.json({ error: 'repository admin required' }, { status: 403 }),
      };
    }
    return {
      ok: true,
      ctx: { accessToken: identity.accessToken, userId: identity.userId, repository },
    };
  } catch (err) {
    if (err instanceof GitHubUserAccessError && err.status === 401) {
      return {
        ok: false,
        response: NextResponse.json({ error: 'sign in again' }, { status: 401 }),
      };
    }
    throw err;
  }
}

/**
 * A lightweight CSRF guard for the first mutating routes in `apps/web`
 * (this app has no other POST/PUT/DELETE routes yet to reuse a pattern
 * from). The session cookie is `SameSite=Lax` (next-auth's default), which
 * already blocks a cross-site POST from a plain HTML form, but a defense-
 * in-depth check costs nothing: reject a mismatched `Origin` outright, and
 * require `content-type: application/json` so a plain HTML form can't
 * trigger this endpoint at all (forms can't set that content type).
 */
export function requireSameOriginJson(
  req: NextRequest,
  nextAuthUrl: string,
): NextResponse | undefined {
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return NextResponse.json({ error: 'content-type must be application/json' }, { status: 415 });
  }
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(nextAuthUrl).origin) {
    return NextResponse.json({ error: 'origin mismatch' }, { status: 403 });
  }
  return undefined;
}
