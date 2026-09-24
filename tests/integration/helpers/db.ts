import { createDatabase, type DatabaseHandle } from '@coderexic/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, inject } from 'vitest';

/**
 * Opens the run's test database for one test file and empties every table
 * before each test.
 */
export function useTestDatabase(): DatabaseHandle {
  const handle = createDatabase({ url: inject('databaseUrl'), maxConnections: 4 });
  beforeEach(async () => {
    await handle.db.execute(sql`
      DO $$ DECLARE tables text;
      BEGIN
        SELECT string_agg(format('%I', tablename), ', ') INTO tables
        FROM pg_tables WHERE schemaname = 'public';
        IF tables IS NOT NULL THEN EXECUTE 'TRUNCATE ' || tables || ' CASCADE'; END IF;
      END $$;
    `);
  });
  afterAll(() => handle.close());
  return handle;
}

/** The Postgres SQLSTATE of a failed query (drizzle wraps the driver error). */
export async function pgErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    const cause = (err as { cause?: { code?: string } }).cause;
    return cause?.code ?? (err as { code?: string }).code;
  }
  return undefined;
}

export const PG = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
} as const;
