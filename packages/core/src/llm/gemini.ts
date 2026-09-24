import { setTimeout as sleep } from 'node:timers/promises';
import { FIX_TYPES, SEVERITIES } from '../db/schema.js';
import type { Logger } from '../logger.js';
import { ModelHttpError, ModelInvalidOutputError, ModelTimeoutError } from './errors.js';
import { buildReviewPrompt, SYSTEM_PROMPT } from './prompt.js';
import { modelReviewOutputSchema, type ReviewModel, type ReviewModelInput } from './types.js';

/**
 * Pinned, non-preview model (checked live against the account's available
 * models on 2026-09-24; "-latest" aliases are avoided so behaviour does not
 * shift under us without a deliberate change).
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';

/** Gemini's structured-output schema (a JSON-schema subset), mirroring modelReviewOutputSchema. */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    reviews: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
          severity: { type: 'string', enum: [...SEVERITIES] },
          start_line: { type: 'integer' },
          end_line: { type: 'integer' },
          issue: { type: 'string' },
          fix_type: { type: 'string', enum: [...FIX_TYPES] },
          suggested_code: { type: 'string', nullable: true },
        },
        required: ['filename', 'severity', 'start_line', 'end_line', 'issue', 'fix_type'],
      },
    },
  },
  required: ['summary', 'reviews'],
} as const;

export interface GeminiAdapterOptions {
  apiKey: string;
  model?: string;
  logger: Logger;
  /** Overrides the HTTP transport (tests). */
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  /** Retries for 429/503 responses, which free-tier quotas hit often. */
  maxRetries?: number;
  /** Base delay for exponential backoff when no Retry-After header is sent (tests). */
  retryBaseMs?: number;
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

export function createGeminiAdapter({
  apiKey,
  model = DEFAULT_GEMINI_MODEL,
  logger,
  fetch = globalThis.fetch,
  baseUrl = 'https://generativelanguage.googleapis.com',
  maxRetries = 3,
  retryBaseMs = 1000,
}: GeminiAdapterOptions): ReviewModel {
  const log = logger.child({ component: 'gemini', model });
  const url = `${baseUrl}/v1beta/models/${model}:generateContent`;

  return {
    async generateReview(input: ReviewModelInput, options = {}) {
      const body = JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildReviewPrompt(input) }] }],
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA },
      });

      for (let attempt = 1; ; attempt++) {
        let response: Response;
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
            body,
            ...(options.signal && { signal: options.signal }),
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
          log.warn(
            { status: response.status, attempt, retryAfterMs },
            'gemini rate limited, retrying',
          );
          await abortableDelay(retryAfterMs, options.signal);
          continue;
        }
        if (!response.ok) {
          const errorBody: unknown = await response.json().catch(() => undefined);
          throw new ModelHttpError(
            `gemini request failed with ${response.status} ${errorStatus(errorBody) ?? ''}`.trim(),
            response.status,
          );
        }

        const data = (await response.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof text !== 'string') {
          throw new ModelInvalidOutputError('gemini response had no text content');
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new ModelInvalidOutputError('gemini response was not valid JSON');
        }
        const result = modelReviewOutputSchema.safeParse(parsed);
        if (!result.success) {
          throw new ModelInvalidOutputError(
            'gemini response failed schema validation',
            result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
          );
        }
        return result.data;
      }
    },
  };
}
