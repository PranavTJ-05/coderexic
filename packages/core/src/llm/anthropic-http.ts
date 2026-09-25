import type { Logger } from '../logger.js';
import { postJsonWithRetry } from './http-policy.js';

const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicHttpOptions {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  logger: Logger;
  maxRetries: number;
  retryBaseMs: number;
  requestTimeoutMs?: number;
}

/** 529 is Anthropic's "overloaded" status, worth retrying like 429/503. */
const RETRY_STATUSES = [429, 503, 529];

export function callAnthropicApi(
  url: string,
  body: string,
  { apiKey, fetch, logger, maxRetries, retryBaseMs, requestTimeoutMs }: AnthropicHttpOptions,
  signal?: AbortSignal,
): Promise<unknown> {
  return postJsonWithRetry(
    url,
    body,
    {
      apiKey,
      authHeader: (key) => ({ 'x-api-key': key }),
      extraHeaders: { 'anthropic-version': ANTHROPIC_VERSION },
      retryStatuses: RETRY_STATUSES,
      fetch,
      logger,
      maxRetries,
      retryBaseMs,
      ...(requestTimeoutMs !== undefined && { requestTimeoutMs }),
    },
    signal,
  );
}
