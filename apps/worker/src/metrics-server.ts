import { createServer, type Server } from 'node:http';
import type { Logger, Metrics } from '@coderexic/core';

export interface MetricsServerOptions {
  metrics: Metrics;
  logger: Logger;
  /** Bearer token required to read `/metrics`. Unset means `/metrics` always answers 404. */
  metricsToken?: string;
}

export interface MetricsServer {
  start(port: number, host?: string): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The worker has no other HTTP surface (unlike the API's Fastify app), so
 * this is a minimal `node:http` listener for `/health` (liveness - the
 * worker previously had no health check at all) and `/metrics`
 * (ROADMAP.md Phase 14, bearer-protected the same way as the API's).
 */
export function createMetricsServer({
  metrics,
  logger,
  metricsToken,
}: MetricsServerOptions): MetricsServer {
  const server: Server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    const url = req.url ?? '/';
    if (url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          status: 'ok',
          service: 'worker',
          uptimeSeconds: Math.round(process.uptime()),
        }),
      );
      return;
    }
    if (url === '/metrics') {
      if (!metricsToken) {
        res.writeHead(404).end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${metricsToken}`) {
        res
          .writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      metrics.registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'content-type': metrics.registry.contentType }).end(body);
        })
        .catch((err: unknown) => {
          logger.error({ err }, 'failed to render metrics');
          res.writeHead(500).end();
        });
      return;
    }
    res.writeHead(404).end();
  });

  return {
    start(port, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          logger.info({ port }, 'worker metrics server started');
          resolve();
        });
      });
    },
    stop() {
      return new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
