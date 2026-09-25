import { describe, expect, it, vi } from 'vitest';
import { TOOL_DEFINITIONS } from '../agent/tools.js';
import { createLogger } from '../logger.js';
import { createGroqAgentAdapter, DEFAULT_GROQ_MODEL } from './groq.js';

const logger = createLogger({ name: 'groq-test', level: 'silent' });

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createGroqAgentAdapter', () => {
  it("hits Groq's OpenAI-compatible endpoint with the configured model and key", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const adapter = createGroqAgentAdapter({ apiKey: 'groq-secret', logger, fetch });
    const result = await adapter.chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS);

    expect(result.text).toBe('ok');
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer groq-secret');
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe(DEFAULT_GROQ_MODEL);
  });

  it('uses a caller-supplied model override', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const adapter = createGroqAgentAdapter({ apiKey: 'k', model: 'custom-model', logger, fetch });
    await adapter.chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS);
    const body = JSON.parse((fetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      model: string;
    };
    expect(body.model).toBe('custom-model');
  });
});
