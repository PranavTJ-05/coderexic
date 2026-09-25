import { z } from 'zod';
import { parseEnv } from '../env.js';
import { getMasterKey, parseMasterKeyMap, type MasterKeyMap } from './master-key.js';

/** Needed wherever BYOK credentials are written or read (the API, once it exists; the worker, for review-time resolution). */
export const modelCredentialsEnvSchema = z.object({
  MODEL_CREDENTIALS_MASTER_KEYS: z.string().min(1),
  MODEL_CREDENTIALS_KEY_VERSION: z.coerce.number().int().min(1).default(1),
});
export type ModelCredentialsEnv = z.infer<typeof modelCredentialsEnvSchema>;

export interface ModelCredentialsConfig {
  masterKeys: MasterKeyMap;
  currentKeyVersion: number;
}

/**
 * Parses env, then eagerly parses+validates the master-key map itself, and
 * confirms `MODEL_CREDENTIALS_KEY_VERSION` actually has a key in that map -
 * a malformed key, a wrong-length key, or a version with no matching key
 * all fail at startup, not on the first BYOK write.
 */
export function loadModelCredentialsConfig(
  source?: Record<string, string | undefined>,
): ModelCredentialsConfig {
  const env = parseEnv(modelCredentialsEnvSchema, source);
  const masterKeys = parseMasterKeyMap(env.MODEL_CREDENTIALS_MASTER_KEYS);
  getMasterKey(masterKeys, env.MODEL_CREDENTIALS_KEY_VERSION);
  return { masterKeys, currentKeyVersion: env.MODEL_CREDENTIALS_KEY_VERSION };
}
