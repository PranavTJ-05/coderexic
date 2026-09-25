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
 * A DB-stored credential exists for this lookup but couldn't actually be
 * used - most likely decryption failed (e.g. the master key version it was
 * encrypted under was rotated away without re-encrypting existing rows).
 * Callers must never treat this as "no credential configured" and silently
 * fall back to a different key - that would quietly bill whichever key the
 * fallback uses instead of the one the credential's owner explicitly
 * chose. The review pipeline (Phase 13c) fails the review with this
 * surfaced as a distinct error code instead.
 */
export class ProviderCredentialResolutionError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'ProviderCredentialResolutionError';
  }
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
 * Wired into the review pipeline for the repo tier only (Phase 13c) - see
 * `apps/worker/src/review/pipeline.ts`. A decryption failure (e.g. a
 * credential encrypted under a master key version that's since been
 * rotated away) is rethrown as `ProviderCredentialResolutionError`, never
 * swallowed into "no credential, use the system default" - a caller that
 * did that would silently bill the operator's own key instead of the
 * credential owner's explicit choice.
 */
export async function resolveProviderEntry(
  db: Executor,
  lookup: { userId?: string; repositoryId?: string; provider: SupportedModelProvider },
  masterKeys: MasterKeyMap,
  systemRegistry: ProviderRegistry,
  logger: Logger,
): Promise<ResolvedProviderEntry | undefined> {
  let dbCredential;
  try {
    dbCredential = await resolveDecryptedCredential(db, lookup, masterKeys);
  } catch (err) {
    throw new ProviderCredentialResolutionError(
      `failed to resolve the stored ${lookup.provider} credential`,
      err,
    );
  }
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
