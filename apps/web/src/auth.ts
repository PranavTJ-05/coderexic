import 'server-only';
import { createDatabase, upsertUser, type DatabaseHandle } from '@coderexic/core';
import NextAuth, { type NextAuthOptions } from 'next-auth';
import GithubProvider, { type GithubProfile } from 'next-auth/providers/github';
import type { NextRequest } from 'next/server';
import { loadWebEnv } from './env';

let handle: DatabaseHandle | undefined;
/** One pooled connection per process, like apps/api and apps/worker. */
function db(): DatabaseHandle {
  handle ??= createDatabase({ url: loadWebEnv().DATABASE_URL });
  return handle;
}

let cachedAuthOptions: NextAuthOptions | undefined;

/**
 * Built lazily, not at module scope: `next build` statically imports route
 * modules to "collect page data", and that must succeed without real
 * secrets present - env validation is a runtime/deploy-time concern here,
 * not a build-time one (unlike `apps/api`/`apps/worker`, which have no
 * separate build-time code-execution step to worry about).
 *
 * A GitHub App's own OAuth client (Settings -> General on the App itself,
 * not a separate OAuth App) - only authorizing this App yields a
 * user-to-server token that can call `GET /user/installations` (the
 * dashboard's repo-list authorization check, `@coderexic/core`'s
 * `listAuthorizedRepositories`).
 */
export function getAuthOptions(): NextAuthOptions {
  if (cachedAuthOptions) return cachedAuthOptions;
  const env = loadWebEnv();
  cachedAuthOptions = {
    providers: [
      GithubProvider({
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      }),
    ],
    secret: env.AUTH_SECRET,
    // JWT, not the database strategy: no Auth.js adapter/tables. The app's
    // own `users` table is upserted by hand in the jwt callback below.
    session: { strategy: 'jwt' },
    callbacks: {
      async jwt({ token, account, profile }) {
        if (account?.provider === 'github' && profile) {
          const githubProfile = profile as GithubProfile;
          const user = await upsertUser(db().db, {
            githubUserId: githubProfile.id,
            login: githubProfile.login,
            displayName: githubProfile.name,
            avatarUrl: githubProfile.avatar_url,
            email: githubProfile.email,
          });
          token.userId = user.id;
          token.login = user.login;
          // The GitHub App user-to-server access token. Kept in the JWT
          // only - never copied onto `session` below, which client JS can
          // read via /api/auth/session.
          if (account.access_token) token.githubAccessToken = account.access_token;
        }
        return token;
      },
      session({ session, token }) {
        if (token.userId && token.login) {
          session.user.id = token.userId;
          session.user.login = token.login;
        }
        return session;
      },
    },
  };
  return cachedAuthOptions;
}

/**
 * `NextAuth(options)` (the single-argument, App Router form) is typed
 * `any` in next-auth's own `.d.ts` - it returns a request handler function,
 * not a plain value. Typed explicitly here instead of an eslint-disable,
 * matching next-auth's documented `[...nextauth]` route handler signature.
 */
type NextAuthRouteHandler = (
  req: NextRequest,
  context: { params: Promise<{ nextauth: string[] }> },
) => Promise<Response>;

let cachedHandler: NextAuthRouteHandler | undefined;
function getHandler(): NextAuthRouteHandler {
  cachedHandler ??= NextAuth(getAuthOptions()) as NextAuthRouteHandler;
  return cachedHandler;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ nextauth: string[] }> },
): Promise<Response> {
  return getHandler()(req, context);
}
export { GET as POST };
