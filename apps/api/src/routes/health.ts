import type { FastifyInstance } from 'fastify';

export interface HealthRouteOptions {
  checkDatabase?: () => Promise<void>;
  checkRedis?: () => Promise<void>;
}

/**
 * `/health` is liveness only: it answers whether the process can serve HTTP
 * and checks no dependencies, so a dependency outage never gets the API
 * restarted. `/ready` checks the database and (Phase 14) Redis - both are on
 * the request path (the database for reads, Redis to enqueue a review) - for
 * load balancers deciding whether to send traffic.
 */
export function registerHealthRoutes(
  app: FastifyInstance,
  version: string,
  { checkDatabase, checkRedis }: HealthRouteOptions = {},
): void {
  app.get('/health', { logLevel: 'warn' }, () => ({
    status: 'ok',
    service: 'api',
    version,
    uptimeSeconds: Math.round(process.uptime()),
  }));

  app.get('/ready', { logLevel: 'warn' }, async (request, reply) => {
    const checks: { dependency: string; check: () => Promise<void> }[] = [
      ...(checkDatabase ? [{ dependency: 'database', check: checkDatabase }] : []),
      ...(checkRedis ? [{ dependency: 'redis', check: checkRedis }] : []),
    ];
    for (const { dependency, check } of checks) {
      try {
        await check();
      } catch (err) {
        request.log.warn({ err, dependency }, 'readiness check failed');
        return reply.code(503).send({ status: 'unavailable', dependency });
      }
    }
    return { status: 'ready' };
  });
}
