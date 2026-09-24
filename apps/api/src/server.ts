import { randomUUID } from 'node:crypto';
import type { DatabaseHandle, IndexQueueJob, Logger, ReviewQueueJob } from '@coderexic/core';
import type { Queue } from 'bullmq';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerHealthRoutes } from './routes/health.js';
import { registerWebhookRoutes } from './webhooks/route.js';

export interface BuildServerOptions {
  logger: Logger;
  version?: string;
  /** Enables the readiness check and, with the other queue/secret options, the GitHub webhook route. */
  database?: DatabaseHandle;
  webhookSecret?: string;
  reviewQueue?: Queue<ReviewQueueJob>;
  indexQueue?: Queue<IndexQueueJob>;
}

export async function buildServer({
  logger,
  version = '0.0.0',
  database,
  webhookSecret,
  reviewQueue,
  indexQueue,
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

  registerHealthRoutes(app, version, database && (() => database.ping()));
  if (database && webhookSecret && reviewQueue && indexQueue) {
    await registerWebhookRoutes(app, {
      db: database.db,
      secret: webhookSecret,
      reviewQueue,
      indexQueue,
    });
  }

  return app;
}
