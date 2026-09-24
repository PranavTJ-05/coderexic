import { baseEnvSchema, createLogger, parseEnv, runMigrations } from '@coderexic/core';

// Applies pending database migrations, then exits. Run before starting the
// API and worker: `pnpm db:migrate` locally, the `migrate` service in compose.
const env = parseEnv(baseEnvSchema.pick({ DATABASE_URL: true, LOG_LEVEL: true }));
const logger = createLogger({ name: 'migrate', level: env.LOG_LEVEL });

try {
  await runMigrations(env.DATABASE_URL);
  logger.info('migrations applied');
} catch (err) {
  logger.fatal({ err }, 'migration failed');
  process.exit(1);
}
