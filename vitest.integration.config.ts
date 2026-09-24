import { defineConfig } from 'vitest/config';
import { coreAlias } from './vitest.config.js';

// Needs a reachable Postgres: TEST_DATABASE_URL, else DATABASE_URL (from the
// environment or .env). A throwaway database is created and dropped per run.
export default defineConfig({
  resolve: { alias: coreAlias },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/integration/helpers/global-setup.ts'],
    // Files share one database and truncate it between tests.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
