import {
  createLogger,
  createSignatureFailureLimiter,
  signWebhookPayload,
  type Database,
} from '@coderexic/core';
import type { Queue } from 'bullmq';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';

/**
 * Covers the signature-verification layer of the webhook route (401s, the
 * signature-failure rate limit, and the generous verified-traffic rate
 * limit) without a real Postgres/Redis connection. Every path exercised
 * here returns before the route ever touches `db` or the queues, so a
 * type-satisfying stand-in is enough - unlike
 * `tests/integration/webhooks.test.ts`, which needs real services to
 * exercise the DB-writing paths past signature verification.
 */
const SECRET = 'route-test-webhook-secret-01234';

function fakeDatabase(): Database {
  return {} as Database;
}

function fakeQueue<T>(): Queue<T> {
  return {} as Queue<T>;
}

describe('POST /webhooks/github (signature and rate-limit layer)', () => {
  let app: Awaited<ReturnType<typeof buildServer>> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function build(
    options: Partial<Parameters<typeof buildServer>[0]> = {},
  ): Promise<Awaited<ReturnType<typeof buildServer>>> {
    app = await buildServer({
      logger: createLogger({ name: 'route-test', level: 'silent' }),
      database: { db: fakeDatabase(), ping: async () => undefined, close: async () => undefined },
      webhookSecret: SECRET,
      reviewQueue: fakeQueue(),
      indexQueue: fakeQueue(),
      ...options,
    });
    return app;
  }

  function post(body: string, signature: string | undefined) {
    return app!.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-github-delivery': 'd1',
        ...(signature !== undefined && { 'x-hub-signature-256': signature }),
      },
      payload: body,
    });
  }

  it('rejects an empty signature header with 401, not a 500', async () => {
    await build();
    const res = await post('{}', '');
    expect(res.statusCode).toBe(401);
  });

  it('rejects a sha1= prefix with 401', async () => {
    await build();
    const body = '{}';
    const sha1ish = signWebhookPayload(SECRET, body).replace('sha256=', 'sha1=');
    const res = await post(body, sha1ish);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong-length signature with 401, not a 500', async () => {
    await build();
    const res = await post('{}', 'sha256=abcd');
    expect(res.statusCode).toBe(401);
  });

  it('rejects a duplicate x-hub-signature-256 header (array value) as missing, 401', async () => {
    await build();
    const body = '{}';
    const res = await app!.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-github-delivery': 'd1',
        // Simulates what a duplicated header looks like once Node parses
        // it into `request.headers`: an array, not a string. `header()`
        // only accepts a string value, so this must be treated as missing.
        'x-hub-signature-256': ['sig-a', 'sig-b'],
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it('blocks further requests from an IP after repeated signature failures', async () => {
    await build({ signatureFailureLimiter: createSignatureFailureLimiter({ maxFailures: 2 }) });
    const body = '{}';
    expect((await post(body, 'sha256=' + 'a'.repeat(64))).statusCode).toBe(401);
    expect((await post(body, 'sha256=' + 'b'.repeat(64))).statusCode).toBe(401);
    expect((await post(body, 'sha256=' + 'c'.repeat(64))).statusCode).toBe(401);
    // A 4th request, even with no signature header at all, is blocked by
    // the limiter before signature verification even runs.
    const blocked = await post(body, undefined);
    expect(blocked.statusCode).toBe(429);
  });

  it('rate-limits verified-looking traffic once the generous cap is hit', async () => {
    await build({ webhookRateLimit: { max: 1, timeWindow: '1 minute' } });
    const body = '{}';
    const signature = signWebhookPayload(SECRET, body);
    const first = await post(body, signature);
    // The first request passes signature verification; it may fail later
    // (fake DB), but must not be rejected by the rate limiter itself.
    expect(first.statusCode).not.toBe(429);
    const second = await post(body, signature);
    expect(second.statusCode).toBe(429);
  });

  it('does not buffer the body at all for a request already over the body limit', async () => {
    await build();
    const res = await app!.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-github-delivery': 'd1',
        'content-length': String(30 * 1024 * 1024),
      },
      payload: Buffer.alloc(30 * 1024 * 1024),
    });
    expect(res.statusCode).toBe(413);
  });
});
