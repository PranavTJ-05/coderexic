import { Writable } from 'node:stream';
import { createLogger } from '@coderexic/core';
import { afterEach, describe, expect, it } from 'vitest';
import { loadApiEnv } from './env.js';
import { buildServer } from './server.js';

const silent = createLogger({ name: 'api-test', level: 'silent' });
let app: ReturnType<typeof buildServer> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health', () => {
  it('returns 200 with service status', async () => {
    app = buildServer({ logger: silent, version: '1.2.3' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'api', version: '1.2.3' });
  });

  it('echoes an incoming x-request-id', async () => {
    app = buildServer({ logger: silent });
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'req-abc' },
    });
    expect(res.headers['x-request-id']).toBe('req-abc');
  });

  it('generates a request id when none is sent', async () => {
    app = buildServer({ logger: silent });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('unknown routes', () => {
  it('return 404', async () => {
    app = buildServer({ logger: silent });
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
  });
});

describe('request logging', () => {
  it('never writes the authorization header to logs', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    app = buildServer({ logger: createLogger({ name: 'api-test', destination: stream }) });
    app.get('/echo', (req) => {
      req.log.info({ req: { headers: req.headers } }, 'incoming');
      return {};
    });
    await app.inject({
      method: 'GET',
      url: '/echo',
      headers: { authorization: 'Bearer ghs_should_not_appear' },
    });
    const raw = lines.join('');
    expect(raw).toContain('incoming');
    expect(raw).not.toContain('ghs_should_not_appear');
  });
});

describe('loadApiEnv', () => {
  it('parses PORT and applies HOST default', () => {
    const env = loadApiEnv({
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      PORT: '4000',
    });
    expect(env.PORT).toBe(4000);
    expect(env.HOST).toBe('0.0.0.0');
  });

  it('rejects an out-of-range port', () => {
    expect(() =>
      loadApiEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        PORT: '70000',
      }),
    ).toThrow(/PORT/);
  });
});
