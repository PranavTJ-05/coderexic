import type { AgentAdapter } from '../agent/types.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from './http-policy.js';
import type { Logger } from '../logger.js';
import { createOpenAICompatibleAdapter } from './openai-compatible.js';

/**
 * Checked live against Groq's `/openai/v1/models` on 2026-09-25: of the
 * models whose `supported_features` include `"tools"`, this is the
 * smallest/fastest (`llama-3.3-70b-versatile`, an earlier obvious choice,
 * is no longer in Groq's catalog at all).
 */
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-20b';

export interface GroqAdapterOptions {
  apiKey: string;
  model?: string;
  logger: Logger;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  maxRetries?: number;
  retryBaseMs?: number;
  requestTimeoutMs?: number;
}

/** Groq's API is OpenAI-compatible (same `/chat/completions` request/response shape). */
export function createGroqAgentAdapter({
  apiKey,
  model = DEFAULT_GROQ_MODEL,
  logger,
  fetch,
  baseUrl = 'https://api.groq.com/openai/v1',
  maxRetries,
  retryBaseMs,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: GroqAdapterOptions): AgentAdapter {
  const log = logger.child({ component: 'groq', model });
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
