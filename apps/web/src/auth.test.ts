import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

describe('getAuthOptions', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://user:pass@localhost:5432/db');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('GITHUB_CLIENT_ID', 'client-id');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'client-secret');
    vi.stubEnv('AUTH_SECRET', '0123456789012345678901234567890123456789');
    vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3001');
  });

  it('session callback never copies the GitHub access token onto the client-visible session', async () => {
    const { getAuthOptions } = await import('./auth.js');
    const options = getAuthOptions();
    const sessionCallback = options.callbacks?.session;
    if (!sessionCallback) throw new Error('session callback not configured');

    const session = {
      user: { name: null, email: null, image: null },
      expires: new Date().toISOString(),
    };
    const token = {
      userId: 'user-1',
      login: 'octocat',
      githubAccessToken: 'gho_super-secret-access-token',
    };

    const result = (await sessionCallback({
      session,
      token,
      // Only `session`/`token` are used by this callback; the rest of the
      // parameters are unused here.
    } as Parameters<NonNullable<typeof sessionCallback>>[0])) as typeof session & {
      user: { id?: string; login?: string };
    };

    expect(result.user.id).toBe('user-1');
    expect(result.user.login).toBe('octocat');
    expect(JSON.stringify(result)).not.toContain('gho_super-secret-access-token');
    expect(result).not.toHaveProperty('githubAccessToken');
  });

  it('is built lazily and reads env only when actually called', async () => {
    // An empty value counts as unset (packages/core/src/env.ts's parseEnv) -
    // deterministic, unlike relying on the ambient shell not having these set.
    vi.stubEnv('GITHUB_CLIENT_ID', '');
    const { getAuthOptions } = await import('./auth.js');
    expect(() => getAuthOptions()).toThrow(/GITHUB_CLIENT_ID/);
  });
});
