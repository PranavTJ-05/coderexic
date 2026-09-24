import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;
/** A transaction handle; store functions accept either this or a Database. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Transaction;

export interface DatabaseOptions {
  url: string;
  /** Pool size per process. */
  maxConnections?: number;
}

export interface DatabaseHandle {
  db: Database;
  /** Checks connectivity with a trivial query. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createDatabase({ url, maxConnections = 10 }: DatabaseOptions): DatabaseHandle {
  const client = postgres(url, { max: maxConnections, onnotice: () => undefined });
  const db = drizzle({ client, schema });
  return {
    db,
    ping: async () => {
      await client`select 1`;
    },
    close: () => client.end({ timeout: 5 }),
  };
}
