import type { Logger } from '../logger.js';
import { postJsonWithRetry } from './http-policy.js';

/** Shared by OpenAI, Groq, and (later) any other OpenAI-compatible `/chat/completions` backend. */
export interface OpenAIHttpOptions {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  logger: Logger;
  maxRetries: number;
  retryBaseMs: number;
  requestTimeoutMs?: number;
}

export function callOpenAICompatibleApi(
  url: string,
  body: string,
  { apiKey, fetch, logger, maxRetries, retryBaseMs, requestTimeoutMs }: OpenAIHttpOptions,
  signal?: AbortSignal,
): Promise<unknown> {
  return postJsonWithRetry(
    url,
    body,
    {
      apiKey,
      authHeader: (key) => ({ authorization: `Bearer ${key}` }),
      fetch,
      logger,
      maxRetries,
      retryBaseMs,
      ...(requestTimeoutMs !== undefined && { requestTimeoutMs }),
    },
    signal,
  );
}
