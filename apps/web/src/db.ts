import 'server-only';
import { createDatabase, type DatabaseHandle } from '@coderexic/core';
import { loadWebEnv } from './env';

let handle: DatabaseHandle | undefined;

/**
 * Built lazily, not at module scope: `next build` statically imports route
 * modules to "collect page data", which must succeed without real secrets
 * present (see `auth.ts`'s `getAuthOptions` for the same reasoning).
 */
export function db(): DatabaseHandle {
  handle ??= createDatabase({ url: loadWebEnv().DATABASE_URL });
  return handle;
}
