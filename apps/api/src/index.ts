import {
  createDatabase,
  createIndexQueue,
  createLogger,
  createMetrics,
  createRedisConnection,
  createReviewQueue,
} from '@coderexic/core';
import { loadApiEnv } from './env.js';
import { buildServer } from './server.js';

const env = loadApiEnv();
const logger = createLogger({ name: 'api', level: env.LOG_LEVEL });

// A crash Fastify's own error handling never sees (e.g. a rejected promise in
// a `void`-called background task) must still be logged before the process
// dies, so it shows up as more than a silent restart (ROADMAP.md Phase 14:
// error tracking).
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled rejection');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
});

const database = createDatabase({ url: env.DATABASE_URL });
const redis = createRedisConnection(env.REDIS_URL);
const reviewQueue = createReviewQueue(redis);
const indexQueue = createIndexQueue(redis);
const metrics = createMetrics();
const app = await buildServer({
  logger,
  version: process.env.npm_package_version ?? '0.0.0',
  database,
  redis,
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
  reviewQueue,
  indexQueue,
  metrics,
  ...(env.METRICS_TOKEN && { metricsToken: env.METRICS_TOKEN }),
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  try {
    await app.close();
    await reviewQueue.close();
    await indexQueue.close();
    redis.disconnect();
    await database.close();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', (signal) => void shutdown(signal));
process.on('SIGINT', (signal) => void shutdown(signal));

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (err) {
  logger.fatal({ err }, 'failed to start api');
  process.exit(1);
}
