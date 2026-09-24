import { runMigrations } from '@coderexic/core';
import { sql } from 'drizzle-orm';
import { describe, expect, inject, it } from 'vitest';
import { useTestDatabase } from '../helpers/db.js';

const EXPECTED_TABLES = [
  'agent_runs',
  'agent_tool_calls',
  'audit_events',
  'dependency_edges',
  'ignore_patterns',
  'index_runs',
  'indexed_files',
  'installations',
  'model_credentials',
  'repositories',
  'repository_rules',
  'repository_settings',
  'review_findings',
  'review_jobs',
  'reviews',
  'users',
  'webhook_events',
];

describe('migrations', () => {
  const { db } = useTestDatabase();

  it('create every table in the data model', async () => {
    const rows = await db.execute<{ tablename: string }>(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    expect(rows.map((r) => r.tablename)).toEqual(EXPECTED_TABLES);
  });

  it('are idempotent when run again', async () => {
    await expect(runMigrations(inject('databaseUrl'))).resolves.toBeUndefined();
  });
});
