import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@coderexic/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
});
