import { Writable } from 'node:stream';
import { createLogger, createMetrics, createNoopMetrics } from '@coderexic/core';
import { afterEach, describe, expect, it } from 'vitest';
import { loadApiEnv } from './env.js';
import { buildServer } from './server.js';

const silent = createLogger({ name: 'api-test', level: 'silent' });
let app: Awaited<ReturnType<typeof buildServer>> | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health', () => {
  it('returns 200 with service status', async () => {
    app = await buildServer({ logger: silent, version: '1.2.3' });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'api', version: '1.2.3' });
  });

  it('echoes an incoming x-request-id', async () => {
    app = await buildServer({ logger: silent });
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'req-abc' },
    });
    expect(res.headers['x-request-id']).toBe('req-abc');
  });

  it('generates a request id when none is sent', async () => {
    app = await buildServer({ logger: silent });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('GET /ready', () => {
  it('is ready without a database configured', async () => {
    app = await buildServer({ logger: silent });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.json()).toEqual({ status: 'ready' });
  });
});

describe('GET /ready', () => {
  it('is unavailable when a configured redis check fails, without checking the database', async () => {
    app = await buildServer({
      logger: silent,
      redis: { ping: () => Promise.reject(new Error('down')) } as never,
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'unavailable', dependency: 'redis' });
  });

  it('is ready when a configured redis check succeeds', async () => {
    app = await buildServer({
      logger: silent,
      redis: { ping: () => Promise.resolve('PONG') } as never,
    });
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.json()).toEqual({ status: 'ready' });
  });
});

describe('GET /metrics', () => {
  it('is not registered at all when no METRICS_TOKEN is configured', async () => {
    app = await buildServer({ logger: silent, metrics: createNoopMetrics() });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(404);
  });

  it('rejects a request without the configured bearer token', async () => {
    app = await buildServer({
      logger: silent,
      metrics: createMetrics(),
      metricsToken: 'a'.repeat(20),
    });
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects the wrong bearer token', async () => {
    app = await buildServer({
      logger: silent,
      metrics: createMetrics(),
      metricsToken: 'a'.repeat(20),
    });
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('serves Prometheus text format for the correct bearer token', async () => {
    const metrics = createMetrics();
    app = await buildServer({ logger: silent, metrics, metricsToken: 'a'.repeat(20) });
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${'a'.repeat(20)}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('coderexic_http_request_duration_seconds');
  });

  it('records an HTTP request duration observation labeled by route template', async () => {
    const metrics = createMetrics();
    app = await buildServer({ logger: silent, metrics, metricsToken: 'a'.repeat(20) });
    await app.inject({ method: 'GET', url: '/health' });
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${'a'.repeat(20)}` },
    });
    expect(res.body).toContain('route="/health"');
  });

  it('labels an unmatched route "unmatched", never the raw URL', async () => {
    const metrics = createMetrics();
    app = await buildServer({ logger: silent, metrics, metricsToken: 'a'.repeat(20) });
    await app.inject({ method: 'GET', url: '/some/random/path/12345' });
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: `Bearer ${'a'.repeat(20)}` },
    });
    expect(res.body).toContain('route="unmatched"');
    expect(res.body).not.toContain('/some/random/path/12345');
  });
});

describe('unknown routes', () => {
  it('return 404', async () => {
    app = await buildServer({ logger: silent });
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
    app = await buildServer({ logger: createLogger({ name: 'api-test', destination: stream }) });
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
      GITHUB_WEBHOOK_SECRET: 'a-webhook-secret-of-32-characters',
      PORT: '4000',
    });
    expect(env.PORT).toBe(4000);
    expect(env.HOST).toBe('0.0.0.0');
  });

  it('requires a webhook secret of at least 16 characters', () => {
    expect(() =>
      loadApiEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        GITHUB_WEBHOOK_SECRET: 'short',
      }),
    ).toThrow(/GITHUB_WEBHOOK_SECRET/);
  });

  it('rejects an out-of-range port', () => {
    expect(() =>
      loadApiEnv({
        DATABASE_URL: 'postgres://u:p@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        GITHUB_WEBHOOK_SECRET: 'a-webhook-secret-of-32-characters',
        PORT: '70000',
      }),
    ).toThrow(/PORT/);
  });
});
