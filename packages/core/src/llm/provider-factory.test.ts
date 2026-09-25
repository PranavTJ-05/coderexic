import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger.js';
import { buildProviderRegistry, checkProviderHealth } from './provider-factory.js';

const logger = createLogger({ name: 'provider-factory-test', level: 'silent' });

describe('buildProviderRegistry', () => {
  it('only includes providers with a configured credential', () => {
    const registry = buildProviderRegistry(
      { gemini: { apiKey: 'k', model: 'gemini-3.6-flash' }, groq: { apiKey: 'g', model: 'llama' } },
      logger,
    );
    expect(Object.keys(registry).sort()).toEqual(['gemini', 'groq']);
    expect(registry.openai).toBeUndefined();
    expect(registry.anthropic).toBeUndefined();
  });

  it('gives every entry both a reviewModel and an agentAdapter', () => {
    const registry = buildProviderRegistry(
      {
        gemini: { apiKey: 'k', model: 'gemini-3.6-flash' },
        openai: { apiKey: 'k', model: 'gpt-5.1' },
        anthropic: { apiKey: 'k', model: 'claude-sonnet-5' },
        groq: { apiKey: 'k', model: 'openai/gpt-oss-20b' },
      },
      logger,
    );
    for (const entry of Object.values(registry)) {
      expect(typeof entry.reviewModel.generateReview).toBe('function');
      expect(typeof entry.agentAdapter.chat).toBe('function');
    }
  });

  it('returns an empty registry when no credentials are configured', () => {
    expect(buildProviderRegistry({}, logger)).toEqual({});
  });
});

describe('checkProviderHealth', () => {
  it('reports ok on a successful models-list call, without spending tokens (GET, no body)', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    const result = await checkProviderHealth('groq', { apiKey: 'k', model: 'm' }, fetch);
    expect(result).toEqual({ provider: 'groq', ok: true });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/models');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('reports a bad key as not ok, with the status but not the body', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response('{"error":"invalid key sk-123"}', { status: 401 }));
    const result = await checkProviderHealth('openai', { apiKey: 'bad', model: 'm' }, fetch);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('status 401');
  });

  it('never throws on a network failure', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await checkProviderHealth('anthropic', { apiKey: 'k', model: 'm' }, fetch);
    expect(result).toEqual({ provider: 'anthropic', ok: false, error: 'ECONNREFUSED' });
  });
});
