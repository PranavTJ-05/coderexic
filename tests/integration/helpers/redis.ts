import { existsSync } from 'node:fs';
import { createRedisConnection } from '@coderexic/core';
import { afterAll } from 'vitest';

function redisUrl(): string {
  if (!process.env.TEST_REDIS_URL && !process.env.REDIS_URL && existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  const url = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      'Integration tests need Redis: set TEST_REDIS_URL or REDIS_URL ' +
        '(e.g. `docker compose up -d redis` and copy .env.example to .env).',
    );
  }
  return url;
}

/** A shared Redis connection for one test file, closed after all its tests. */
export function useTestRedis(): ReturnType<typeof createRedisConnection> {
  const connection = createRedisConnection(redisUrl());
  afterAll(() => connection.quit());
  return connection;
}
