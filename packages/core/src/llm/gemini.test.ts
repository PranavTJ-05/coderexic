import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger.js';
import { createGeminiAdapter, DEFAULT_GEMINI_MODEL } from './gemini.js';
import { ModelHttpError, ModelInvalidOutputError, ModelTimeoutError } from './errors.js';

const logger = createLogger({ name: 'gemini-test', level: 'silent' });
const input = {
  repositoryFullName: 'octocat/hello',
  pullRequestTitle: 'Fix bug',
  pullRequestBody: null,
  files: [{ filename: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }],
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function geminiPayload(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

describe('createGeminiAdapter', () => {
  it('sends the API key in a header, never the URL', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse(geminiPayload('{"summary":"ok","reviews":[]}')));
    const adapter = createGeminiAdapter({ apiKey: 'secret-key-123', logger, fetch });
    await adapter.generateReview(input);

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('secret-key-123');
    expect(url).toContain(DEFAULT_GEMINI_MODEL);
    expect(new Headers(init.headers).get('x-goog-api-key')).toBe('secret-key-123');
  });

  it('returns the parsed, schema-valid review', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(geminiPayload(JSON.stringify({ summary: 'Looks fine', reviews: [] }))),
      );
    const adapter = createGeminiAdapter({ apiKey: 'k', logger, fetch });
    await expect(adapter.generateReview(input)).resolves.toEqual({
      summary: 'Looks fine',
      reviews: [],
    });
  });

  it('retries a 503 and then succeeds', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { status: 'UNAVAILABLE' } }, 503))
      .mockResolvedValueOnce(jsonResponse(geminiPayload('{"summary":"ok","reviews":[]}')));
    const adapter = createGeminiAdapter({
      apiKey: 'k',
      logger,
      fetch,
      maxRetries: 3,
      retryBaseMs: 1,
    });
    await expect(adapter.generateReview(input)).resolves.toEqual({ summary: 'ok', reviews: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('honors a Retry-After header', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: {} }, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse(geminiPayload('{"summary":"ok","reviews":[]}')));
    const adapter = createGeminiAdapter({ apiKey: 'k', logger, fetch, maxRetries: 3 });
    await expect(adapter.generateReview(input)).resolves.toEqual({ summary: 'ok', reviews: [] });
  });

  it('gives up after maxRetries and throws ModelHttpError', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { status: 'UNAVAILABLE' } }, 503));
    const adapter = createGeminiAdapter({
      apiKey: 'k',
      logger,
      fetch,
      maxRetries: 1,
      retryBaseMs: 1,
    });
    await expect(adapter.generateReview(input)).rejects.toBeInstanceOf(ModelHttpError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable HTTP error', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { status: 'PERMISSION_DENIED' } }, 403));
    const adapter = createGeminiAdapter({ apiKey: 'k', logger, fetch, maxRetries: 3 });
    const error = await adapter.generateReview(input).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ModelHttpError);
    expect((error as ModelHttpError).status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a response with no text content', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [] } }] }));
    const adapter = createGeminiAdapter({ apiKey: 'k', logger, fetch });
    await expect(adapter.generateReview(input)).rejects.toBeInstanceOf(ModelInvalidOutputError);
  });

  it('rejects text that is not valid JSON', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(geminiPayload('not json')));
    const adapter = createGeminiAdapter({ apiKey: 'k', logger, fetch });
    await expect(adapter.generateReview(input)).rejects.toBeInstanceOf(ModelInvalidOutputError);
  });

  it('rejects JSON that fails the finding schema', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse(geminiPayload(JSON.stringify({ summary: 'x' }))));
    const adapter = createGeminiAdapter({ apiKey: 'k', logger, fetch });
    const error = await adapter.generateReview(input).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ModelInvalidOutputError);
    expect((error as ModelInvalidOutputError).issues.length).toBeGreaterThan(0);
  });

  it('maps an aborted signal to ModelTimeoutError', async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    const adapter = createGeminiAdapter({ apiKey: 'k', logger, fetch });
    controller.abort();
    await expect(
      adapter.generateReview(input, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(ModelTimeoutError);
  });

  it('never includes suggested_code above the schema limit (rejected, not truncated)', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        geminiPayload(
          JSON.stringify({
            summary: 'x',
            reviews: [
              {
                filename: 'a.ts',
                severity: 'low',
                start_line: 1,
                end_line: 1,
                issue: 'x',
                fix_type: 'applyable',
                suggested_code: 'y'.repeat(10_000),
              },
            ],
          }),
        ),
      ),
    );
    const adapter = createGeminiAdapter({ apiKey: 'k', logger, fetch });
    await expect(adapter.generateReview(input)).rejects.toBeInstanceOf(ModelInvalidOutputError);
  });
});
