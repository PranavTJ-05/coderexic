import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export const coreAlias = {
  '@coderexic/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
};

// Unit tests: no Postgres or Redis needed. Integration tests have their own
// config (vitest.integration.config.ts) and run with `pnpm test:integration`.
export default defineConfig({
  resolve: { alias: coreAlias },
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
