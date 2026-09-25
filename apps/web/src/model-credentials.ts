import 'server-only';
import { loadModelCredentialsConfig, type ModelCredentialsConfig } from '@coderexic/core';
import { loadWebEnv } from './env';

let cached: ModelCredentialsConfig | null | undefined;

/**
 * Lazily parses+validates the master-key map (same eager validation as
 * `loadModelCredentialsConfig`'s own doc comment - a malformed key fails
 * loudly on first use, not silently). `null` (cached) means "this
 * deployment has never configured BYOK" - callers use that to disable the
 * BYOK write routes rather than accepting a key nothing could decrypt.
 * Lazy for the same reason `db()`/`getAuthOptions()` are: `next build`
 * must succeed with no env configured.
 */
export function getModelCredentialsConfig(): ModelCredentialsConfig | null {
  if (cached !== undefined) return cached;
  const env = loadWebEnv();
  cached = env.MODEL_CREDENTIALS_MASTER_KEYS ? loadModelCredentialsConfig(process.env) : null;
  return cached;
}
