import { createLogger, createMetrics, createNoopMetrics } from '@coderexic/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createMetricsServer, type MetricsServer } from './metrics-server.js';

const silent = createLogger({ name: 'worker-test', level: 'silent' });
let server: MetricsServer | undefined;
const PORT = 18932;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

describe('worker metrics server', () => {
  it('answers /health without requiring a token', async () => {
    server = createMetricsServer({ metrics: createNoopMetrics(), logger: silent });
    await server.start(PORT);
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', service: 'worker' });
  });

  it('answers /metrics with 404 when no token is configured', async () => {
    server = createMetricsServer({ metrics: createMetrics(), logger: silent });
    await server.start(PORT);
    const res = await fetch(`http://127.0.0.1:${PORT}/metrics`);
    expect(res.status).toBe(404);
  });

  it('rejects /metrics without the configured bearer token', async () => {
    server = createMetricsServer({
      metrics: createMetrics(),
      logger: silent,
      metricsToken: 'a'.repeat(20),
    });
    await server.start(PORT);
    const res = await fetch(`http://127.0.0.1:${PORT}/metrics`);
    expect(res.status).toBe(401);
  });

  it('serves Prometheus text for the correct bearer token', async () => {
    const metrics = createMetrics();
    metrics.recordError('TIMEOUT');
    server = createMetricsServer({ metrics, logger: silent, metricsToken: 'a'.repeat(20) });
    await server.start(PORT);
    const res = await fetch(`http://127.0.0.1:${PORT}/metrics`, {
      headers: { authorization: `Bearer ${'a'.repeat(20)}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('coderexic_errors_total{code="TIMEOUT"} 1');
  });

  it('returns 404 for an unknown path', async () => {
    server = createMetricsServer({ metrics: createNoopMetrics(), logger: silent });
    await server.start(PORT);
    const res = await fetch(`http://127.0.0.1:${PORT}/nope`);
    expect(res.status).toBe(404);
  });
});
