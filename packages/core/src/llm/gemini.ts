import { FIX_TYPES, SEVERITIES } from '../db/schema.js';
import type { Logger } from '../logger.js';
import { callGeminiApi } from './gemini-http.js';
import { ModelInvalidOutputError } from './errors.js';
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
  const httpOptions = { apiKey, fetch, baseUrl, logger: log, maxRetries, retryBaseMs };

  return {
    async generateReview(input: ReviewModelInput, options = {}) {
      const body = JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildReviewPrompt(input) }] }],
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA },
      });

      const data = (await callGeminiApi(url, body, httpOptions, options.signal)) as {
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
    },
  };
}
