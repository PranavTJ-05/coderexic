import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from '../logger.js';
import { ModelHttpError, ModelTimeoutError } from './errors.js';

/**
 * Shared retry/timeout policy (ROADMAP.md Phase 10's "Retry policy" and
 * "Timeout policy" checklist items) for every raw-`fetch` provider adapter
 * (`gemini-http.ts`, `openai-http.ts`, `anthropic-http.ts`). One place to
 * get right: which statuses are worth retrying, how backoff is computed,
 * and how a per-request timeout combines with the caller's own signal.
 */
export interface HttpPolicyOptions {
  apiKey: string;
  /** How the key is sent - each provider has its own header name/scheme. */
  authHeader: (apiKey: string) => Record<string, string>;
  fetch: typeof globalThis.fetch;
  logger: Logger;
  /** Extra fixed headers (e.g. Anthropic's `anthropic-version`). */
  extraHeaders?: Record<string, string>;
  /** Statuses worth retrying: 429 (rate limit) and 503 (unavailable) by every provider here; Anthropic also uses 529 (overloaded). */
  retryStatuses?: readonly number[];
  maxRetries: number;
  /** Base delay for exponential backoff when no Retry-After header is sent (tests). */
  retryBaseMs: number;
  /** A per-request ceiling, combined with the caller's own signal via `AbortSignal.any`. Generous for a provider that may cold-start (e.g. local Ollama). */
  requestTimeoutMs?: number;
}

const DEFAULT_RETRY_STATUSES = [429, 503];

/** Every adapter's default per-attempt timeout, unless it overrides one (e.g. a slower cold-starting local backend). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

async function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch (err) {
    if (isAbortError(err)) throw new ModelTimeoutError();
    throw err;
  }
}

/**
 * POSTs JSON with retry on the configured statuses and returns the parsed
 * response body. Throws `ModelTimeoutError` on an abort and `ModelHttpError`
 * (status only - never the response body, which can echo request secrets
 * back, e.g. a provider's 401 body fragmenting the sent key) on a
 * non-retried failure.
 */
export async function postJsonWithRetry(
  url: string,
  body: string,
  options: HttpPolicyOptions,
  callerSignal?: AbortSignal,
): Promise<unknown> {
  const {
    apiKey,
    authHeader,
    fetch,
    logger,
    extraHeaders,
    retryStatuses = DEFAULT_RETRY_STATUSES,
    maxRetries,
    retryBaseMs,
    requestTimeoutMs,
  } = options;

  for (let attempt = 1; ; attempt++) {
    // A fresh per-attempt timeout window, not a single deadline for the whole call: a slow
    // provider that's still worth retrying (429/503) shouldn't have its retry budget eaten by
    // an earlier attempt's own timeout countdown.
    const timeoutSignal =
      requestTimeoutMs !== undefined ? AbortSignal.timeout(requestTimeoutMs) : undefined;
    const signals = [callerSignal, timeoutSignal].filter((s): s is AbortSignal => s !== undefined);
    const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...authHeader(apiKey),
          ...extraHeaders,
        },
        body,
        ...(signal && { signal }),
      });
    } catch (err) {
      if (isAbortError(err)) throw new ModelTimeoutError();
      throw new ModelHttpError(`request failed: ${(err as Error).message}`, 0);
    }

    if (retryStatuses.includes(response.status) && attempt <= maxRetries) {
      const retryAfterHeader = Number(response.headers.get('retry-after'));
      const retryAfterMs =
        Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? retryAfterHeader * 1000
          : Math.min(retryBaseMs * 2 ** attempt, 30_000);
      logger.warn({ status: response.status, attempt, retryAfterMs }, 'rate limited, retrying');
      await abortableDelay(retryAfterMs, callerSignal);
      continue;
    }
    if (!response.ok) {
      throw new ModelHttpError(`request failed with status ${response.status}`, response.status);
    }
    return response.json();
  }
}
