import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger.js';
import { ModelHttpError, ModelTimeoutError } from './errors.js';
import { postJsonWithRetry } from './http-policy.js';

const logger = createLogger({ name: 'http-policy-test', level: 'silent' });

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const baseOptions = {
  apiKey: 'k',
  authHeader: (key: string) => ({ authorization: `Bearer ${key}` }),
  logger,
  maxRetries: 3,
  retryBaseMs: 1,
};

describe('postJsonWithRetry', () => {
  it('gives each attempt a fresh timeout signal, not one shared deadline for the whole call', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce((_url, init) => {
        signals.push(init?.signal ?? undefined);
        return Promise.resolve(jsonResponse({ error: 'unavailable' }, 503));
      })
      .mockImplementationOnce((_url, init) => {
        signals.push(init?.signal ?? undefined);
        return Promise.resolve(jsonResponse({ ok: true }));
      });

    await postJsonWithRetry('https://example.test/x', '{}', {
      ...baseOptions,
      fetch,
      requestTimeoutMs: 50_000,
    });

    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it('retries a retryable status and returns the eventual success', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const result = await postJsonWithRetry('https://example.test/x', '{}', {
      ...baseOptions,
      fetch,
    });
    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('honors a Retry-After header over the exponential backoff', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const result = await postJsonWithRetry('https://example.test/x', '{}', {
      ...baseOptions,
      fetch,
    });
    expect(result).toEqual({ ok: true });
  });

  it('throws ModelHttpError with only the status, never the response body', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response('{"error":"key sk-abc123 invalid"}', { status: 401 }));
    const err = await postJsonWithRetry('https://example.test/x', '{}', {
      ...baseOptions,
      fetch,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelHttpError);
    expect((err as ModelHttpError).status).toBe(401);
    expect((err as Error).message).not.toContain('sk-abc123');
  });

  it('does not retry a non-retryable status', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 400 }));
    await expect(
      postJsonWithRetry('https://example.test/x', '{}', { ...baseOptions, fetch }),
    ).rejects.toBeInstanceOf(ModelHttpError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ error: 'unavailable' }, 503));
    await expect(
      postJsonWithRetry('https://example.test/x', '{}', { ...baseOptions, fetch, maxRetries: 1 }),
    ).rejects.toBeInstanceOf(ModelHttpError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('maps an aborted signal to ModelTimeoutError', async () => {
    const fetch = vi.fn().mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      postJsonWithRetry(
        'https://example.test/x',
        '{}',
        { ...baseOptions, fetch },
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(ModelTimeoutError);
  });

  it('retries a custom-configured status (e.g. Anthropic-style 529)', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 529))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const result = await postJsonWithRetry('https://example.test/x', '{}', {
      ...baseOptions,
      fetch,
      retryStatuses: [429, 503, 529],
    });
    expect(result).toEqual({ ok: true });
  });
});
