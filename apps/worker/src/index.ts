import {
  createDatabase,
  createGeminiAdapter,
  createGitHubApp,
  createLogger,
  createRedisConnection,
  loadGeminiEnv,
  loadGitHubAppCredentials,
} from '@coderexic/core';
import { loadWorkerEnv } from './env.js';
import { createIndexWorker } from './index-run/worker.js';
import { createReviewWorker } from './worker.js';

const env = loadWorkerEnv();
const logger = createLogger({ name: 'worker', level: env.LOG_LEVEL });

const database = createDatabase({ url: env.DATABASE_URL });
const redis = createRedisConnection(env.REDIS_URL);
const githubApp = createGitHubApp({
  credentials: loadGitHubAppCredentials(process.env, (message) => {
    logger.warn(message);
  }),
  logger,
});
const geminiEnv = loadGeminiEnv(process.env);
const model = createGeminiAdapter({
  apiKey: geminiEnv.GEMINI_API_KEY,
  model: geminiEnv.GEMINI_MODEL,
  logger,
});

const worker = createReviewWorker({
  logger,
  db: database.db,
  connection: redis,
  githubApp,
  model,
  provider: 'gemini',
  modelName: geminiEnv.GEMINI_MODEL,
  concurrency: env.REVIEW_CONCURRENCY,
});

const indexWorker = createIndexWorker({
  logger,
  db: database.db,
  connection: redis,
  githubApp,
  concurrency: env.INDEX_CONCURRENCY,
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  try {
    await Promise.all([worker.stop(), indexWorker.stop()]);
    await database.close();
    redis.disconnect();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', (signal) => void shutdown(signal));
process.on('SIGINT', (signal) => void shutdown(signal));

try {
  await Promise.all([worker.start(), indexWorker.start()]);
} catch (err) {
  logger.fatal({ err }, 'failed to start worker');
  process.exit(1);
}
