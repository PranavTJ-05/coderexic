import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { runMigrations } from '@coderexic/core';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

function baseUrl(): string {
  if (!process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL && existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Integration tests need Postgres: set TEST_DATABASE_URL or DATABASE_URL ' +
        '(e.g. `docker compose up -d postgres` and copy .env.example to .env).',
    );
  }
  return url;
}

/** Creates a fresh, migrated database for this run and drops it afterwards. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const adminUrl = new URL(baseUrl());
  const name = `coderexic_test_${randomBytes(4).toString('hex')}`;
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => undefined });
  await admin.unsafe(`CREATE DATABASE ${name}`);

  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${name}`;
  await runMigrations(testUrl.toString());
  project.provide('databaseUrl', testUrl.toString());

  return async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  };
}
