import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../agent/types.js';
import { TOOL_DEFINITIONS } from '../agent/tools.js';
import { createLogger } from '../logger.js';
import { createAnthropicAgentAdapter } from './anthropic.js';
import { ModelHttpError, ModelTimeoutError } from './errors.js';

const logger = createLogger({ name: 'anthropic-test', level: 'silent' });

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createAnthropicAgentAdapter', () => {
  it('sends the API key via x-api-key and the anthropic-version header, with system split out', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
    const adapter = createAnthropicAgentAdapter({ apiKey: 'secret', logger, fetch });
    await adapter.chat(
      [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'go' },
      ],
      TOOL_DEFINITIONS,
    );

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = new Headers(init.headers);
    expect(headers.get('x-api-key')).toBe('secret');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    const body = JSON.parse(init.body as string) as { system?: string; messages: unknown[] };
    expect(body.system).toBe('system prompt');
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'go' }] }]);
  });

  it('translates a tool_use block into a normalized tool call', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'get_imports', input: { path: 'a.ts' } },
        ],
      }),
    );
    const adapter = createAnthropicAgentAdapter({ apiKey: 'k', logger, fetch });
    const result = await adapter.chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS);
    expect(result.text).toBeNull();
    expect(result.toolCalls).toEqual([
      { id: 'toolu_1', name: 'get_imports', args: { path: 'a.ts' } },
    ]);
  });

  it('batches multiple tool results for one assistant turn into a single following user message', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
    const adapter = createAnthropicAgentAdapter({ apiKey: 'k', logger, fetch });
    const messages: AgentMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: '1', name: 'get_imports', args: { path: 'a.ts' } },
          { id: '2', name: 'get_dependents', args: { path: 'a.ts' } },
        ],
      },
      { role: 'tool', toolCallId: '1', name: 'get_imports', content: 'imports nothing' },
      { role: 'tool', toolCallId: '2', name: 'get_dependents', content: 'no dependents' },
    ];
    await adapter.chat(messages, TOOL_DEFINITIONS);
    const body = JSON.parse((fetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      messages: { role: string; content: { type: string; tool_use_id?: string }[] }[];
    };
    const resultTurns = body.messages.filter((m) =>
      m.content.some((b) => b.type === 'tool_result'),
    );
    expect(resultTurns).toHaveLength(1);
    expect(resultTurns[0]?.content.map((b) => b.tool_use_id)).toEqual(['1', '2']);
  });

  it('allows a trailing plain-text user message after a tool-result batch without merging it in', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
    const adapter = createAnthropicAgentAdapter({ apiKey: 'k', logger, fetch });
    const messages: AgentMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: '1', name: 'get_imports', args: {} }],
      },
      { role: 'tool', toolCallId: '1', name: 'get_imports', content: 'imports nothing' },
      { role: 'user', content: 'final turn: submit now' },
    ];
    await adapter.chat(messages, TOOL_DEFINITIONS);
    const body = JSON.parse((fetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      messages: { role: string; content: { type: string; text?: string }[] }[];
    };
    const lastMessage = body.messages[body.messages.length - 1];
    expect(lastMessage?.role).toBe('user');
    expect(lastMessage?.content).toEqual([{ type: 'text', text: 'final turn: submit now' }]);
  });

  it('never sends tool_choice, even when asked to force one (incompatible with the adaptive thinking these models run by default)', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
    const adapter = createAnthropicAgentAdapter({ apiKey: 'k', logger, fetch });
    await adapter.chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS, {
      toolChoice: { name: 'submit_review' },
    });
    const body = JSON.parse(
      (fetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect('tool_choice' in body).toBe(false);
  });

  it('echoes a prior assistant turn verbatim from providerData, preserving a thinking block', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
    const adapter = createAnthropicAgentAdapter({ apiKey: 'k', logger, fetch });
    const rawContent: unknown[] = [
      { type: 'thinking', thinking: '', signature: 'abc123' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_imports', input: { path: 'a.ts' } },
    ];
    const messages: AgentMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'toolu_1', name: 'get_imports', args: { path: 'a.ts' } }],
        providerData: { content: rawContent },
      },
      { role: 'tool', toolCallId: 'toolu_1', name: 'get_imports', content: 'imports nothing' },
    ];
    await adapter.chat(messages, TOOL_DEFINITIONS);
    const body = JSON.parse((fetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      messages: { role: string; content: unknown }[];
    };
    const assistantTurn = body.messages.find((m) => m.role === 'assistant');
    expect(assistantTurn?.content).toEqual(rawContent);
  });

  it('returns providerData with the raw response content, for the next turn to echo back', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        content: [
          { type: 'thinking', thinking: '', signature: 'xyz' },
          { type: 'text', text: 'ok' },
        ],
      }),
    );
    const adapter = createAnthropicAgentAdapter({ apiKey: 'k', logger, fetch });
    const result = await adapter.chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS);
    expect(result.providerData).toMatchObject({
      content: [{ type: 'thinking' }, { type: 'text', text: 'ok' }],
    });
  });

  it('omits the tools key entirely when there are none', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
    const adapter = createAnthropicAgentAdapter({ apiKey: 'k', logger, fetch });
    await adapter.chat([{ role: 'user', content: 'go' }], []);
    const body = JSON.parse(
      (fetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect('tools' in body).toBe(false);
  });

  it('translates a nullable-typed parameter to a plain string type (no union, no nullable keyword)', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
    const adapter = createAnthropicAgentAdapter({ apiKey: 'k', logger, fetch });
    await adapter.chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS);
    const body = JSON.parse((fetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      tools: { name: string; input_schema: Record<string, unknown> }[];
    };
    const submitReview = body.tools.find((t) => t.name === 'submit_review');
    const properties = submitReview?.input_schema.properties as Record<string, unknown>;
    const reviewsSchema = properties.reviews as Record<string, unknown>;
    const itemSchema = reviewsSchema.items as Record<string, unknown>;
    const itemProperties = itemSchema.properties as Record<string, unknown>;
    const suggestedCode = itemProperties.suggested_code as { type: unknown; nullable?: unknown };
    expect(suggestedCode.type).toBe('string');
    expect(suggestedCode.nullable).toBeUndefined();
  });

  it('retries a 529 (overloaded) and then succeeds', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'overloaded' }, 529))
      .mockResolvedValueOnce(jsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
    const adapter = createAnthropicAgentAdapter({
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

  it('throws ModelHttpError after exhausting retries', async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ error: 'unavailable' }, 503));
    const adapter = createAnthropicAgentAdapter({
      apiKey: 'k',
      logger,
      fetch,
      maxRetries: 1,
      retryBaseMs: 1,
    });
    await expect(
      adapter.chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS),
    ).rejects.toBeInstanceOf(ModelHttpError);
  });

  it('maps an aborted signal to ModelTimeoutError', async () => {
    const fetch = vi.fn().mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    const adapter = createAnthropicAgentAdapter({ apiKey: 'k', logger, fetch });
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
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 200, output_tokens: 40 },
      }),
    );
    const adapter = createAnthropicAgentAdapter({ apiKey: 'k', logger, fetch });
    const result = await adapter.chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS);
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
  });
});
