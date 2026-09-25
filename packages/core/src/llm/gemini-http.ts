import type { Logger } from '../logger.js';
import { postJsonWithRetry } from './http-policy.js';

/** Shared by the one-shot (`gemini.ts`) and agent (`gemini-agent.ts`) adapters. */
export interface GeminiHttpOptions {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  logger: Logger;
  maxRetries: number;
  retryBaseMs: number;
  requestTimeoutMs?: number;
}

/**
 * POSTs to a Gemini `:generateContent` endpoint and returns the parsed JSON
 * body, via the shared retry/timeout policy (`http-policy.ts`). Callers
 * extract and validate the response shape themselves - a one-shot review
 * and a tool-calling turn parse different fields out of the same envelope.
 */
export function callGeminiApi(
  url: string,
  body: string,
  { apiKey, fetch, logger, maxRetries, retryBaseMs, requestTimeoutMs }: GeminiHttpOptions,
  signal?: AbortSignal,
): Promise<unknown> {
  return postJsonWithRetry(
    url,
    body,
    {
      apiKey,
      authHeader: (key) => ({ 'x-goog-api-key': key }),
      fetch,
      logger,
      maxRetries,
      retryBaseMs,
      ...(requestTimeoutMs !== undefined && { requestTimeoutMs }),
    },
    signal,
  );
}
