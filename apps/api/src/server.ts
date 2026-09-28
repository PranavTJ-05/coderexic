import { randomUUID } from 'node:crypto';
import {
  createMetrics,
  type DatabaseHandle,
  type IndexQueueJob,
  type Logger,
  type Metrics,
  type ReviewQueueJob,
} from '@coderexic/core';
import type { Queue } from 'bullmq';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { registerHealthRoutes } from './routes/health.js';
import { registerWebhookRoutes } from './webhooks/route.js';

export interface BuildServerOptions {
  logger: Logger;
  version?: string;
  /** Enables the readiness check and, with the other queue/secret options, the GitHub webhook route. */
  database?: DatabaseHandle;
  /** Enables the Redis half of the readiness check. */
  redis?: Redis;
  webhookSecret?: string;
  reviewQueue?: Queue<ReviewQueueJob>;
  indexQueue?: Queue<IndexQueueJob>;
  /** Defaults to a fresh, real `Registry`-backed instance so `/metrics` always has something to serve. */
  metrics?: Metrics;
  /**
   * Bearer token required to read `/metrics`. Unset means `/metrics` is not
   * registered at all (ROADMAP.md Phase 14: never expose metrics
   * unauthenticated on the same public listener as the webhook route).
   */
  metricsToken?: string;
}

export async function buildServer({
  logger,
  version = '0.0.0',
  database,
  redis,
  webhookSecret,
  reviewQueue,
  indexQueue,
  metrics = createMetrics(),
  metricsToken,
}: BuildServerOptions): Promise<FastifyInstance> {
  // Widen to Fastify's logger interface so routes see a plain FastifyInstance.
  const loggerInstance: FastifyBaseLogger = logger;
  const app = Fastify({
    loggerInstance,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    metrics.observeHttpRequest({
      method: request.method,
      route,
      statusCode: reply.statusCode,
      durationSeconds: reply.elapsedTime / 1000,
    });
  });

  if (reviewQueue) metrics.registerQueue('review-jobs', reviewQueue);
  if (indexQueue) metrics.registerQueue('index-runs', indexQueue);

  registerHealthRoutes(app, version, {
    ...(database && { checkDatabase: () => database.ping() }),
    ...(redis && {
      checkRedis: async () => {
        await redis.ping();
      },
    }),
  });

  if (metricsToken) {
    app.get('/metrics', { logLevel: 'warn' }, async (request, reply) => {
      const auth = request.headers.authorization;
      if (auth !== `Bearer ${metricsToken}`) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      reply.header('content-type', metrics.registry.contentType);
      return metrics.registry.metrics();
    });
  }

  if (database && webhookSecret && reviewQueue && indexQueue) {
    await registerWebhookRoutes(app, {
      db: database.db,
      secret: webhookSecret,
      reviewQueue,
      indexQueue,
      metrics,
    });
  }

  return app;
}
