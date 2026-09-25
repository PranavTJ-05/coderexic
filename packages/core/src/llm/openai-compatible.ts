import type {
  AgentAdapter,
  AgentChatResult,
  AgentMessage,
  ToolCall,
  ToolDefinition,
} from '../agent/types.js';
import type { Logger } from '../logger.js';
import { callOpenAICompatibleApi } from './openai-http.js';

export interface OpenAICompatibleAdapterOptions {
  apiKey: string;
  model: string;
  /** Full base URL including any provider-specific path prefix, e.g. `https://api.groq.com/openai/v1`. */
  baseUrl: string;
  logger: Logger;
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
  retryBaseMs?: number;
  requestTimeoutMs?: number;
}

interface OpenAIToolCall {
  id?: string;
  type: 'function';
  function: { name: string; arguments: string };
}
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

function toOpenAIMessages(messages: readonly AgentMessage[]): OpenAIMessage[] {
  return messages.map((m): OpenAIMessage => {
    if (m.role === 'system') return { role: 'system', content: m.content };
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls &&
          m.toolCalls.length > 0 && {
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                // OpenAI's wire format wants a JSON string; a call this adapter itself produced
                // already carries one (see toToolCalls), but args could in principle be an
                // already-parsed object (e.g. round-tripped through another provider's adapter).
                arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}),
              },
            })),
          }),
      };
    }
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  });
}

function toOpenAITools(tools: readonly ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

let callCounter = 0;

function toToolCalls(toolCalls: OpenAIToolCall[] | undefined): ToolCall[] | null {
  if (!toolCalls || toolCalls.length === 0) return null;
  return toolCalls.map((tc) => {
    callCounter += 1;
    return {
      id: tc.id ?? `openai_call_${callCounter}`,
      name: tc.function.name,
      // Left as the raw string: the executor already parses a string-typed `args` itself
      // (AI_AGENT_SPEC.md §16's OpenAI-style adapters hand tool arguments over as text).
      args: tc.function.arguments,
    };
  });
}

/**
 * One adapter for every OpenAI-compatible `/chat/completions` backend
 * (OpenAI itself, Groq, and any future one - Ollama's OpenAI-compat mode
 * fits the same shape when it's added). The request/response format is
 * shared; only `baseUrl`/`apiKey`/`model` differ per provider.
 */
export function createOpenAICompatibleAdapter({
  apiKey,
  model,
  baseUrl,
  logger,
  fetch = globalThis.fetch,
  maxRetries = 3,
  retryBaseMs = 1000,
  requestTimeoutMs,
}: OpenAICompatibleAdapterOptions): AgentAdapter {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const httpOptions = {
    apiKey,
    fetch,
    logger,
    maxRetries,
    retryBaseMs,
    ...(requestTimeoutMs !== undefined && { requestTimeoutMs }),
  };

  return {
    async chat(messages, tools, options = {}): Promise<AgentChatResult> {
      const body = JSON.stringify({
        model,
        messages: toOpenAIMessages(messages),
        ...(tools.length > 0 && { tools: toOpenAITools(tools) }),
        ...(options.toolChoice &&
          tools.length > 0 && {
            tool_choice: { type: 'function', function: { name: options.toolChoice.name } },
          }),
      });

      const data = (await callOpenAICompatibleApi(url, body, httpOptions, options.signal)) as {
        choices?: { message?: { content?: string | null; tool_calls?: OpenAIToolCall[] } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const message = data.choices?.[0]?.message;

      return {
        text: message?.content ?? null,
        toolCalls: toToolCalls(message?.tool_calls),
        usage: {
          ...(data.usage?.prompt_tokens !== undefined && { inputTokens: data.usage.prompt_tokens }),
          ...(data.usage?.completion_tokens !== undefined && {
            outputTokens: data.usage.completion_tokens,
          }),
        },
      };
    },
  };
}
