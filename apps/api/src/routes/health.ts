import type { FastifyInstance } from 'fastify';

/**
 * `/health` is liveness only: it answers whether the process can serve HTTP
 * and checks no dependencies, so a database outage never gets the API
 * restarted. `/ready` checks the database, for load balancers deciding
 * whether to send traffic.
 */
export function registerHealthRoutes(
  app: FastifyInstance,
  version: string,
  checkDatabase?: () => Promise<void>,
): void {
  app.get('/health', { logLevel: 'warn' }, () => ({
    status: 'ok',
    service: 'api',
    version,
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get('/ready', { logLevel: 'warn' }, async (request, reply) => {
    if (!checkDatabase) return { status: 'ready' };
    try {
      await checkDatabase();
      return { status: 'ready' };
    } catch (err) {
      request.log.warn({ err }, 'readiness check failed');
      return reply.code(503).send({ status: 'unavailable', dependency: 'database' });
    }
  });
}
