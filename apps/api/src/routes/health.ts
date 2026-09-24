import type { FastifyInstance } from 'fastify';

/**
 * Liveness only: answers whether the process can serve HTTP. It deliberately
 * checks no dependencies, so a database outage never gets the API restarted.
 */
export function registerHealthRoutes(app: FastifyInstance, version: string): void {
  app.get('/health', { logLevel: 'warn' }, () => ({
    status: 'ok',
    service: 'api',
    version,
    uptimeSeconds: Math.round(process.uptime()),
  }));
}
