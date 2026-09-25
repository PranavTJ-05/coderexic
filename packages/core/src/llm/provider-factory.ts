import type { SupportedModelProvider } from '../config/schema.js';
import type { AgentAdapter } from '../agent/types.js';
import type { Logger } from '../logger.js';
import { createAnthropicAgentAdapter } from './anthropic.js';
import { createGeminiAdapter } from './gemini.js';
import { createGeminiAgentAdapter } from './gemini-agent.js';
import { createGroqAgentAdapter } from './groq.js';
import { createOneShotFromAgentAdapter } from './one-shot-from-agent.js';
import { createOpenAIAgentAdapter } from './openai.js';
import type { ReviewModel } from './types.js';

export interface ProviderCredential {
  apiKey: string;
  model: string;
}

/** Only the providers a deployment actually has a key for. */
export type ProviderCredentials = Partial<Record<SupportedModelProvider, ProviderCredential>>;

export interface ProviderEntry {
  provider: SupportedModelProvider;
  modelName: string;
  /** The one-shot fallback path (AI_AGENT_SPEC.md §15) - Gemini keeps its own dedicated one-shot adapter; every other provider gets one for free via `createOneShotFromAgentAdapter`. */
  reviewModel: ReviewModel;
  agentAdapter: AgentAdapter;
}

export type ProviderRegistry = Partial<Record<SupportedModelProvider, ProviderEntry>>;

/**
 * Builds every configured provider's `ReviewModel`/`AgentAdapter` pair
 * (ROADMAP.md Phase 10's "Provider factory"). A provider with no
 * credential entry is simply absent from the registry - callers (the
 * pipeline's `config.model` resolution) fall back to the deployment
 * default and warn, rather than erroring.
 */
export function buildProviderRegistry(
  credentials: ProviderCredentials,
  logger: Logger,
): ProviderRegistry {
  const registry: ProviderRegistry = {};

  if (credentials.gemini) {
    const { apiKey, model } = credentials.gemini;
    registry.gemini = {
      provider: 'gemini',
      modelName: model,
      reviewModel: createGeminiAdapter({ apiKey, model, logger }),
      agentAdapter: createGeminiAgentAdapter({ apiKey, model, logger }),
    };
  }
  if (credentials.openai) {
    const { apiKey, model } = credentials.openai;
    const agentAdapter = createOpenAIAgentAdapter({ apiKey, model, logger });
    registry.openai = {
      provider: 'openai',
      modelName: model,
      reviewModel: createOneShotFromAgentAdapter(agentAdapter),
      agentAdapter,
    };
  }
  if (credentials.anthropic) {
    const { apiKey, model } = credentials.anthropic;
    const agentAdapter = createAnthropicAgentAdapter({ apiKey, model, logger });
    registry.anthropic = {
      provider: 'anthropic',
      modelName: model,
      reviewModel: createOneShotFromAgentAdapter(agentAdapter),
      agentAdapter,
    };
  }
  if (credentials.groq) {
    const { apiKey, model } = credentials.groq;
    const agentAdapter = createGroqAgentAdapter({ apiKey, model, logger });
    registry.groq = {
      provider: 'groq',
      modelName: model,
      reviewModel: createOneShotFromAgentAdapter(agentAdapter),
      agentAdapter,
    };
  }

  return registry;
}

export interface ProviderHealth {
  provider: SupportedModelProvider;
  ok: boolean;
  error?: string;
}

interface HealthCheckRequest {
  url: string;
  headers: Record<string, string>;
}

function healthCheckRequest(
  provider: SupportedModelProvider,
  credential: ProviderCredential,
): HealthCheckRequest {
  switch (provider) {
    case 'gemini':
      return {
        url: 'https://generativelanguage.googleapis.com/v1beta/models',
        headers: { 'x-goog-api-key': credential.apiKey },
      };
    case 'openai':
      return {
        url: 'https://api.openai.com/v1/models',
        headers: { authorization: `Bearer ${credential.apiKey}` },
      };
    case 'groq':
      return {
        url: 'https://api.groq.com/openai/v1/models',
        headers: { authorization: `Bearer ${credential.apiKey}` },
      };
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/models',
        headers: { 'x-api-key': credential.apiKey, 'anthropic-version': '2023-06-01' },
      };
  }
}

/**
 * A no-token models-list call (ROADMAP.md Phase 10's "Provider health
 * checks", and Phase 11's "provider-specific credential validation" -
 * the same call answers both: a 401/403 means the key is bad, a network
 * failure means the provider is unreachable). Never throws; the caller
 * decides what a failed check means (log-and-continue at startup, or a
 * BYOK key-validation rejection).
 */
export async function checkProviderHealth(
  provider: SupportedModelProvider,
  credential: ProviderCredential,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ProviderHealth> {
  const { url, headers } = healthCheckRequest(provider, credential);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      return { provider, ok: false, error: `status ${response.status}` };
    }
    return { provider, ok: true };
  } catch (err) {
    return { provider, ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}
