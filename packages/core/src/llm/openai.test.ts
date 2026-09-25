import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../agent/types.js';
import { TOOL_DEFINITIONS } from '../agent/tools.js';
import { createLogger } from '../logger.js';
import { createOpenAIAgentAdapter } from './openai.js';
import { ModelHttpError, ModelTimeoutError } from './errors.js';

const logger = createLogger({ name: 'openai-test', level: 'silent' });

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createOpenAIAgentAdapter', () => {
  it('sends the API key as a Bearer token, never in the URL', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const adapter = createOpenAIAgentAdapter({ apiKey: 'secret-key', logger, fetch });
    await adapter.chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS);

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('secret-key');
    expect(url).toContain('/chat/completions');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret-key');
  });

  it('translates a tool_calls response into normalized tool calls, args as the raw string', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_imports', arguments: '{"path":"src/a.ts"}' },
                },
              ],
            },
          },
        ],
      }),
    );
    const adapter = createOpenAIAgentAdapter({ apiKey: 'k', logger, fetch });
    const result = await adapter.chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS);
    expect(result.text).toBeNull();
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'get_imports', args: '{"path":"src/a.ts"}' },
    ]);
  });

  it('returns plain text with no tool calls when the model does not call a function', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'done thinking' } }] }));
    const adapter = createOpenAIAgentAdapter({ apiKey: 'k', logger, fetch });
    const result = await adapter.chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS);
    expect(result.text).toBe('done thinking');
    expect(result.toolCalls).toBeNull();
  });

  it('omits the tools key entirely when there are none, rather than sending an empty array', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const adapter = createOpenAIAgentAdapter({ apiKey: 'k', logger, fetch });
    await adapter.chat([{ role: 'user', content: 'go' }], []);
    const body = JSON.parse(
      (fetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect('tools' in body).toBe(false);
    expect('tool_choice' in body).toBe(false);
  });

  it('forces a specific tool via toolChoice', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const adapter = createOpenAIAgentAdapter({ apiKey: 'k', logger, fetch });
    await adapter.chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS, {
      toolChoice: { name: 'submit_review' },
    });
    const body = JSON.parse((fetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      tool_choice?: { type: string; function: { name: string } };
    };
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'submit_review' } });
  });

  it('reconstructs an assistant tool-call turn as a JSON-string arguments field', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const adapter = createOpenAIAgentAdapter({ apiKey: 'k', logger, fetch });
    const messages: AgentMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: '1', name: 'get_imports', args: { path: 'a.ts' } }],
      },
      { role: 'tool', toolCallId: '1', name: 'get_imports', content: 'a.ts imports nothing.' },
    ];
    await adapter.chat(messages, TOOL_DEFINITIONS);
    const body = JSON.parse((fetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      messages: { role: string; tool_calls?: { function: { arguments: string } }[] }[];
    };
    const assistantTurn = body.messages.find((m) => m.role === 'assistant');
    expect(assistantTurn?.tool_calls?.[0]?.function.arguments).toBe('{"path":"a.ts"}');
    const toolTurn = body.messages.find((m) => m.role === 'tool');
    expect(toolTurn).toMatchObject({ tool_call_id: '1', content: 'a.ts imports nothing.' });
  });

  it('retries a 503 and then succeeds', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const adapter = createOpenAIAgentAdapter({
      apiKey: 'k',
      logger,
      fetch,
      maxRetries: 3,
      retryBaseMs: 1,
    });
    const result = await adapter.chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS);
    expect(result.text).toBe('ok');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('throws ModelHttpError after exhausting retries, without echoing the response body', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { message: 'key sk-abc123' } }, 401));
    const adapter = createOpenAIAgentAdapter({
      apiKey: 'k',
      logger,
      fetch,
      maxRetries: 1,
      retryBaseMs: 1,
    });
    const err = await adapter
      .chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelHttpError);
    expect((err as Error).message).not.toContain('sk-abc123');
  });

  it('maps an aborted signal to ModelTimeoutError', async () => {
    const fetch = vi.fn().mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    const adapter = createOpenAIAgentAdapter({ apiKey: 'k', logger, fetch });
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS, {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(ModelTimeoutError);
  });

  it('reports usage tokens from the response envelope', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 55, completion_tokens: 10 },
      }),
    );
    const adapter = createOpenAIAgentAdapter({ apiKey: 'k', logger, fetch });
    const result = await adapter.chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS);
    expect(result.usage).toEqual({ inputTokens: 55, outputTokens: 10 });
  });
});
