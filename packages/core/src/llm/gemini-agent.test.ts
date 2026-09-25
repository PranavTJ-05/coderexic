import { describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../agent/types.js';
import { TOOL_DEFINITIONS } from '../agent/tools.js';
import { createLogger } from '../logger.js';
import { createGeminiAgentAdapter } from './gemini-agent.js';
import { ModelHttpError, ModelTimeoutError } from './errors.js';

const logger = createLogger({ name: 'gemini-agent-test', level: 'silent' });

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createGeminiAgentAdapter', () => {
  it('sends tool declarations and the system instruction separately from the API key', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    const adapter = createGeminiAgentAdapter({ apiKey: 'secret', logger, fetch });
    const messages: AgentMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'review this' },
    ];
    await adapter.chat(messages, TOOL_DEFINITIONS);

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('secret');
    expect(new Headers(init.headers).get('x-goog-api-key')).toBe('secret');
    const body = JSON.parse(init.body as string) as {
      systemInstruction?: { parts: { text: string }[] };
      tools?: { functionDeclarations: { name: string }[] }[];
    };
    expect(body.systemInstruction?.parts[0]?.text).toBe('system prompt');
    expect(body.tools?.[0]?.functionDeclarations.map((f) => f.name).sort()).toEqual([
      'get_dependents',
      'get_file_content',
      'get_imports',
      'submit_review',
    ]);
  });

  it('translates a function-call response into normalized tool calls', async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'get_imports', args: { path: 'src/a.ts' } } }],
            },
          },
        ],
      }),
    );
    const adapter = createGeminiAgentAdapter({ apiKey: 'k', logger, fetch });
    const result = await adapter.chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS);
    expect(result.text).toBeNull();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toMatchObject({
      name: 'get_imports',
      args: { path: 'src/a.ts' },
    });
    expect(typeof result.toolCalls?.[0]?.id).toBe('string');
    expect(Array.isArray((result.providerData as { parts?: unknown }).parts)).toBe(true);
  });

  it('returns plain text with no tool calls when the model does not call a function', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ candidates: [{ content: { parts: [{ text: 'done thinking' }] } }] }),
      );
    const adapter = createGeminiAgentAdapter({ apiKey: 'k', logger, fetch });
    const result = await adapter.chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS);
    expect(result.text).toBe('done thinking');
    expect(result.toolCalls).toBeNull();
  });

  it('echoes a prior assistant turn verbatim from providerData rather than re-serializing it', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    const adapter = createGeminiAgentAdapter({ apiKey: 'k', logger, fetch });
    const rawParts = [
      { functionCall: { name: 'get_imports', args: { path: 'a.ts' } } },
      // A field a normalized ToolCall round-trip would drop.
      { thoughtSignature: 'abc123' } as unknown as { text: string },
    ];
    const messages: AgentMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: '1', name: 'get_imports', args: { path: 'a.ts' } }],
        providerData: { parts: rawParts },
      },
      { role: 'tool', toolCallId: '1', name: 'get_imports', content: 'a.ts imports nothing.' },
    ];
    await adapter.chat(messages, TOOL_DEFINITIONS);
    const body = JSON.parse((fetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      contents: { role: string; parts: unknown[] }[];
    };
    const modelTurn = body.contents.find((c) => c.role === 'model');
    expect(modelTurn?.parts).toEqual(rawParts);
  });

  it('batches multiple tool results into one following user turn, keyed by name', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    const adapter = createGeminiAgentAdapter({ apiKey: 'k', logger, fetch });
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
      contents: { role: string; parts: { functionResponse?: { name: string } }[] }[];
    };
    const responseTurns = body.contents.filter((c) =>
      c.parts.some((p) => p.functionResponse !== undefined),
    );
    expect(responseTurns).toHaveLength(1);
    expect(responseTurns[0]?.parts.map((p) => p.functionResponse?.name)).toEqual([
      'get_imports',
      'get_dependents',
    ]);
  });

  it("translates a nullable-typed parameter to Gemini's schema subset", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    const adapter = createGeminiAgentAdapter({ apiKey: 'k', logger, fetch });
    await adapter.chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS);
    const rawBody: unknown = JSON.parse(
      (fetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    // Deliberately loose here: we only care that the nullable-union field was translated,
    // not the full shape of Gemini's declaration - a Record<string, unknown> walk is clearer
    // than a matching cast chain.
    const bodyRecord = rawBody as Record<string, unknown>;
    const tools = bodyRecord.tools as { functionDeclarations: Record<string, unknown>[] }[];
    const submitReview = tools[0]?.functionDeclarations.find((f) => f.name === 'submit_review');
    const parameters = submitReview?.parameters as Record<string, unknown>;
    const properties = parameters.properties as Record<string, unknown>;
    const reviewsSchema = properties.reviews as Record<string, unknown>;
    const itemSchema = reviewsSchema.items as Record<string, unknown>;
    const itemProperties = itemSchema.properties as Record<string, unknown>;
    const suggestedCode = itemProperties.suggested_code as { type: string; nullable: boolean };

    expect(suggestedCode.type).toBe('string');
    expect(suggestedCode.nullable).toBe(true);
    expect(parameters.additionalProperties).toBeUndefined();
  });

  it('propagates rate-limit retry and abort mapping the same as the one-shot adapter', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { status: 'UNAVAILABLE' } }, 503))
      .mockResolvedValueOnce(
        jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
      );
    const adapter = createGeminiAgentAdapter({
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
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { status: 'UNAVAILABLE' } }, 503));
    const adapter = createGeminiAgentAdapter({
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
    const adapter = createGeminiAgentAdapter({ apiKey: 'k', logger, fetch });
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
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
      }),
    );
    const adapter = createGeminiAgentAdapter({ apiKey: 'k', logger, fetch });
    const result = await adapter.chat([{ role: 'user', content: 'go' }], TOOL_DEFINITIONS);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });
});
