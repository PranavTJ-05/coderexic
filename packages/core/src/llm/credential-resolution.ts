import type { SupportedModelProvider } from '../config/schema.js';
import type { MasterKeyMap } from '../crypto/master-key.js';
import type { Executor } from '../db/client.js';
import { resolveDecryptedCredential } from '../db/store/model-credentials.js';
import type { Logger } from '../logger.js';
import { DEFAULT_ANTHROPIC_MODEL } from './anthropic.js';
import { DEFAULT_GEMINI_MODEL } from './gemini.js';
import { DEFAULT_GROQ_MODEL } from './groq.js';
import { DEFAULT_OPENAI_MODEL } from './openai.js';
import {
  buildProviderRegistry,
  type ProviderEntry,
  type ProviderRegistry,
} from './provider-factory.js';

const DEFAULT_MODEL: Record<SupportedModelProvider, string> = {
  gemini: DEFAULT_GEMINI_MODEL,
  openai: DEFAULT_OPENAI_MODEL,
  anthropic: DEFAULT_ANTHROPIC_MODEL,
  groq: DEFAULT_GROQ_MODEL,
};

export interface ResolvedProviderEntry extends ProviderEntry {
  source: 'repo' | 'user' | 'system';
}

/**
 * Composes the full repo > user > system precedence (PRODUCT_SPEC.md §12,
 * DATA_MODEL.md) into a single usable `ProviderEntry`: the DB tiers come
 * from `resolveDecryptedCredential`, and the system tier is whatever this
 * deployment already has configured for that provider (`systemRegistry`,
 * built by `buildProviderRegistry` from env-configured keys).
 *
 * A resolved DB credential has no stored model preference (BYOK stores only
 * an API key), so its `ProviderEntry` is built against the system
 * deployment's configured model for that provider when one exists, falling
 * back to the provider's own default model otherwise.
 *
 * Tested directly; not wired into the review pipeline this phase - see
 * `db/store/model-credentials.ts`'s `resolveDecryptedCredential` doc
 * comment for why.
 */
export async function resolveProviderEntry(
  db: Executor,
  lookup: { userId?: string; repositoryId?: string; provider: SupportedModelProvider },
  masterKeys: MasterKeyMap,
  systemRegistry: ProviderRegistry,
  logger: Logger,
): Promise<ResolvedProviderEntry | undefined> {
  const dbCredential = await resolveDecryptedCredential(db, lookup, masterKeys);
  if (dbCredential) {
    const model = systemRegistry[lookup.provider]?.modelName ?? DEFAULT_MODEL[lookup.provider];
    const registry = buildProviderRegistry(
      { [lookup.provider]: { apiKey: dbCredential.apiKey, model } },
      logger,
    );
    const entry = registry[lookup.provider];
    if (!entry) throw new Error(`buildProviderRegistry did not build a "${lookup.provider}" entry`);
    return { ...entry, source: dbCredential.source };
  }

  const systemEntry = systemRegistry[lookup.provider];
  if (!systemEntry) return undefined;
  return { ...systemEntry, source: 'system' };
}
