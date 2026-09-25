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
});
export type WebEnv = z.infer<typeof webEnvSchema>;

export function loadWebEnv(source?: Record<string, string | undefined>): WebEnv {
  return parseEnv(webEnvSchema, source);
}
