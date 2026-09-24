import { createDatabase, createLogger } from '@coderexic/core';
import { loadApiEnv } from './env.js';
import { buildServer } from './server.js';

const env = loadApiEnv();
const logger = createLogger({ name: 'api', level: env.LOG_LEVEL });
const database = createDatabase({ url: env.DATABASE_URL });
const app = await buildServer({
  logger,
  version: process.env.npm_package_version ?? '0.0.0',
  database,
  webhookSecret: env.GITHUB_WEBHOOK_SECRET,
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  try {
    await app.close();
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
