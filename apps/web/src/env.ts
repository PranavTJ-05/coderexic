import { baseEnvSchema, parseEnv } from '@coderexic/core';
import { z } from 'zod';

/**
 * `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` are the GitHub *App's* own OAuth
 * client credentials (Settings -> General -> "Client ID"/"Client secret" on
 * the App, not a separate OAuth App) - a GitHub App user-to-server token
 * only comes from authorizing that same App, and only that token can list
 * the App's installations for `GET /user/installations` (Phase 13a's
 * authorization check).
 */
export const webEnvSchema = baseEnvSchema.extend({
  GITHUB_CLIENT_ID: z.string().min(1),
  GITHUB_CLIENT_SECRET: z.string().min(1),
  /** Signs and encrypts the session JWT. Generate with `openssl rand -base64 32`. */
  AUTH_SECRET: z.string().min(32),
  /**
   * next-auth v4 defaults to `http://localhost:3000` when this is unset,
   * which silently sends the OAuth callback to the wrong port/origin -
   * required here rather than left to that default, since apps/api also
   * defaults to port 3000.
   */
  NEXTAUTH_URL: z.url(),
  /**
   * The GitHub App's URL slug (Settings -> General -> "Public page" URL,
   * the last path segment), used to build
   * `https://github.com/apps/<slug>/installations/new`. Optional and
   * server-only, not `NEXT_PUBLIC_*`: Next inlines `NEXT_PUBLIC_*` vars at
   * `next build` time, which would bake in `undefined` for a build that
   * doesn't have it, and this app never needs it in client JS - the
   * install link is rendered server-side and passed down as a plain href.
   */
  GITHUB_APP_SLUG: z.string().min(1).optional(),
  /**
   * Optional, matching `apps/worker`'s own `MODEL_CREDENTIALS_MASTER_KEYS`
   * (must be the *same* value in both - it's what encrypts a BYOK key
   * written here and what the worker decrypts it with at review time).
   * When unset, the BYOK credential write routes are disabled rather than
   * accepting a key this deployment could never actually decrypt again.
   */
  MODEL_CREDENTIALS_MASTER_KEYS: z.string().min(1).optional(),
  MODEL_CREDENTIALS_KEY_VERSION: z.coerce.number().int().min(1).default(1),
});
export type WebEnv = z.infer<typeof webEnvSchema>;

export function loadWebEnv(source?: Record<string, string | undefined>): WebEnv {
  return parseEnv(webEnvSchema, source);
}
