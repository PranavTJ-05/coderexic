import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from '../logger.js';
import { ModelHttpError, ModelTimeoutError } from './errors.js';

/** Shared by the one-shot (`gemini.ts`) and agent (`gemini-agent.ts`) adapters. */
export interface GeminiHttpOptions {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  baseUrl: string;
  logger: Logger;
  /** Retries for 429/503 responses, which free-tier quotas hit often. */
  maxRetries: number;
  /** Base delay for exponential backoff when no Retry-After header is sent (tests). */
  retryBaseMs: number;
}

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

/** The Gemini API's error envelope, best-effort parsed for logging only. */
function errorStatus(body: unknown): string | undefined {
  return typeof body === 'object' && body !== null && 'error' in body
    ? (body as { error?: { status?: unknown } }).error?.status?.toString()
    : undefined;
}

/**
 * POSTs to a Gemini `:generateContent` endpoint with 429/503 retry, and
 * returns the parsed JSON body. Throws `ModelHttpError` for a non-retried
 * failure and `ModelTimeoutError` for an aborted request. Callers extract
 * and validate the response shape themselves - a one-shot review and a
 * tool-calling turn parse different fields out of the same envelope.
 */
export async function callGeminiApi(
  url: string,
  body: string,
  { apiKey, fetch, logger, maxRetries, retryBaseMs }: GeminiHttpOptions,
  signal?: AbortSignal,
): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body,
        ...(signal && { signal }),
      });
    } catch (err) {
      if (isAbortError(err)) throw new ModelTimeoutError();
      throw new ModelHttpError(`gemini request failed: ${(err as Error).message}`, 0);
    }

    if ((response.status === 429 || response.status === 503) && attempt <= maxRetries) {
      const retryAfterHeader = Number(response.headers.get('retry-after'));
      const retryAfterMs =
        Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? retryAfterHeader * 1000
          : Math.min(retryBaseMs * 2 ** attempt, 30_000);
      logger.warn(
        { status: response.status, attempt, retryAfterMs },
        'gemini rate limited, retrying',
      );
      await abortableDelay(retryAfterMs, signal);
      continue;
    }
    if (!response.ok) {
      const errorBody: unknown = await response.json().catch(() => undefined);
      throw new ModelHttpError(
        `gemini request failed with ${response.status} ${errorStatus(errorBody) ?? ''}`.trim(),
        response.status,
      );
    }
    return response.json();
  }
}
