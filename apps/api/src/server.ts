import { randomUUID } from 'node:crypto';
import type { Logger } from '@coderexic/core';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerHealthRoutes } from './routes/health.js';

export interface BuildServerOptions {
  logger: Logger;
  version?: string;
}

export function buildServer({ logger, version = '0.0.0' }: BuildServerOptions): FastifyInstance {
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

  registerHealthRoutes(app, version);

  return app;
}
