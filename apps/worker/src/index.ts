import {
  buildProviderRegistry,
  checkProviderHealth,
  createDatabase,
  createGitHubApp,
  createLogger,
  createRedisConnection,
  loadGitHubAppCredentials,
  type ProviderCredentials,
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

// Only providers with a key actually set get an entry (ROADMAP.md Phase 10's provider
// factory) - a Groq-only deployment never touches GEMINI_API_KEY, and env.ts's superRefine
// already guarantees MODEL_PROVIDER's own key is present.
const credentials: ProviderCredentials = {
  ...(env.GEMINI_API_KEY && {
    gemini: { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL ?? 'gemini-3.6-flash' },
  }),
  ...(env.OPENAI_API_KEY && {
    openai: { apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL ?? 'gpt-5.1' },
  }),
  ...(env.ANTHROPIC_API_KEY && {
    anthropic: { apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL ?? 'claude-opus-5' },
  }),
  ...(env.GROQ_API_KEY && {
    groq: { apiKey: env.GROQ_API_KEY, model: env.GROQ_MODEL ?? 'openai/gpt-oss-20b' },
  }),
};
const providers = buildProviderRegistry(credentials, logger);
const defaultCredential = credentials[env.MODEL_PROVIDER];
const defaultEntry = providers[env.MODEL_PROVIDER];
if (!defaultEntry || !defaultCredential) {
  // env.ts's superRefine should make this unreachable; fail loudly rather than silently
  // falling back to some other provider if it ever is.
  logger.fatal(
    { provider: env.MODEL_PROVIDER },
    'selected MODEL_PROVIDER has no credential configured',
  );
  process.exit(1);
}

// A no-token models-list call; never blocks startup on a transient failure.
await checkProviderHealth(defaultEntry.provider, defaultCredential).then((health) => {
  if (!health.ok) {
    logger.warn(
      { provider: health.provider, error: health.error },
      'provider health check failed at startup',
    );
  }
});

// Off by default (ROADMAP.md Phase 9): the agent loop makes many more model
// calls per review than the one-shot path, which stays wired in as the
// fallback whenever this flag is off.
if (env.AGENT_LOOP_ENABLED) {
  logger.info(
    { provider: defaultEntry.provider },
    'AGENT_LOOP_ENABLED: reviews will run through the agent loop',
  );
}

const worker = createReviewWorker({
  logger,
  db: database.db,
  connection: redis,
  githubApp,
  model: defaultEntry.reviewModel,
  ...(env.AGENT_LOOP_ENABLED && { agentAdapter: defaultEntry.agentAdapter }),
  provider: defaultEntry.provider,
  modelName: defaultEntry.modelName,
  providers,
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
