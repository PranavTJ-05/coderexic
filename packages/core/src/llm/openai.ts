import type { AgentAdapter } from '../agent/types.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from './http-policy.js';
import type { Logger } from '../logger.js';
import { createOpenAICompatibleAdapter } from './openai-compatible.js';

/** Not checked live (no OpenAI key available this phase - ROADMAP.md Phase 10). Override with `OPENAI_MODEL` if this drifts. */
export const DEFAULT_OPENAI_MODEL = 'gpt-5.1';

export interface OpenAIAdapterOptions {
  apiKey: string;
  model?: string;
  logger: Logger;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  maxRetries?: number;
  retryBaseMs?: number;
  requestTimeoutMs?: number;
}

export function createOpenAIAgentAdapter({
  apiKey,
  model = DEFAULT_OPENAI_MODEL,
  logger,
  fetch,
  baseUrl = 'https://api.openai.com/v1',
  maxRetries,
  retryBaseMs,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: OpenAIAdapterOptions): AgentAdapter {
  const log = logger.child({ component: 'openai', model });
  return createOpenAICompatibleAdapter({
    apiKey,
    model,
    baseUrl,
    logger: log,
    requestTimeoutMs,
    ...(fetch && { fetch }),
    ...(maxRetries !== undefined && { maxRetries }),
    ...(retryBaseMs !== undefined && { retryBaseMs }),
  });
}
