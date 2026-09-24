import { baseEnvSchema, createLogger, parseEnv } from '@coderexic/core';
import { createWorker } from './worker.js';

const env = parseEnv(baseEnvSchema);
const logger = createLogger({ name: 'worker', level: env.LOG_LEVEL });
const worker = createWorker({ logger });

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  try {
    await worker.stop();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', (signal) => void shutdown(signal));
process.on('SIGINT', (signal) => void shutdown(signal));

await worker.start();
