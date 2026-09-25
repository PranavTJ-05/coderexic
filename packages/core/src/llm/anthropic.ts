import type {
  AgentAdapter,
  AgentChatResult,
  AgentMessage,
  ToolCall,
  ToolDefinition,
} from '../agent/types.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from './http-policy.js';
import type { Logger } from '../logger.js';
import { callAnthropicApi } from './anthropic-http.js';

/**
 * Per the `claude-api` skill: always use `claude-opus-5` unless told
 * otherwise, and never downgrade for cost on your own. Override with
 * `ANTHROPIC_MODEL` (`packages/core/src/llm/env.ts`) if that's not what
 * you want for an automated per-PR reviewer.
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';
/** Per the skill: ~16000 for a non-streaming request, to avoid truncating mid-thought. */
const MAX_TOKENS = 16_000;

export interface AnthropicAdapterOptions {
  apiKey: string;
  model?: string;
  logger: Logger;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  maxRetries?: number;
  retryBaseMs?: number;
  requestTimeoutMs?: number;
}

/**
 * A known block shape used to *build* outgoing messages (`tool_use`,
 * `tool_result`) plus a catch-all for anything read back from a response
 * that isn't reconstructed - `thinking`, `redacted_thinking`, and any
 * future block type. `claude-sonnet-5`/`claude-opus-5` run adaptive
 * thinking whenever `thinking` isn't explicitly configured (this adapter
 * never sends it), so a response routinely includes `thinking` blocks;
 * the skill's guidance is to echo them back unchanged on the same model,
 * not to drop them.
 */
type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | { type: string; [key: string]: unknown };
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

function isTextBlock(b: AnthropicBlock): b is Extract<AnthropicBlock, { type: 'text' }> {
  return b.type === 'text' && typeof (b as { text?: unknown }).text === 'string';
}
function isToolUseBlock(b: AnthropicBlock): b is Extract<AnthropicBlock, { type: 'tool_use' }> {
  return b.type === 'tool_use';
}
function isToolResultBlock(
  b: AnthropicBlock,
): b is Extract<AnthropicBlock, { type: 'tool_result' }> {
  return b.type === 'tool_result';
}

function parseArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args ?? {};
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return {};
  }
}

/**
 * Translates the loop's history into Anthropic's `messages`. An assistant
 * turn that carries `providerData.content` (this adapter's own earlier
 * output) is echoed back verbatim rather than rebuilt from the normalized
 * text/`ToolCall[]` fields, so a `thinking` block from a prior turn - which
 * the model needs to see unchanged to keep reasoning about the same
 * conversation - is never silently dropped. The system message is pulled
 * out separately (Anthropic's top-level `system` field). Every
 * `tool_result` for one assistant turn's `tool_use` blocks must land in a
 * single following `user` message (Anthropic's parallel-tool-use contract
 * - splitting them across messages "silently trains Claude to stop making
 * parallel calls"), so consecutive `tool` messages are batched the same
 * way Gemini's adapter batches `functionResponse` parts. A trailing
 * plain-text `user` message (the loop's final-turn reminder) does *not*
 * need to merge into that batch - Anthropic allows and combines
 * consecutive same-role messages.
 */
function toAnthropicMessages(messages: readonly AgentMessage[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      result.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
      continue;
    }
    if (m.role === 'assistant') {
      const raw = m.providerData as { content?: AnthropicBlock[] } | undefined;
      if (raw?.content) {
        result.push({ role: 'assistant', content: raw.content });
        continue;
      }
      const blocks: AnthropicBlock[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parseArgs(tc.args) });
      }
      result.push({ role: 'assistant', content: blocks });
      continue;
    }
    const block: AnthropicBlock = {
      type: 'tool_result',
      tool_use_id: m.toolCallId,
      content: m.content,
    };
    const last = result[result.length - 1];
    if (last?.role === 'user' && last.content.every(isToolResultBlock)) {
      (last.content as AnthropicBlock[]).push(block);
    } else {
      result.push({ role: 'user', content: [block] });
    }
  }
  return result;
}

/**
 * Anthropic's tool schema has no `nullable`/union-type support the way
 * Gemini's does; a `type: ['string', 'null']` field (`agent/tools.ts`'s
 * `suggested_code`) is simplified to just `'string'` - it's already
 * outside `required`, so the model can still omit it.
 */
function toAnthropicSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toAnthropicSchema);
  if (schema && typeof schema === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'type' && Array.isArray(value)) {
        const nonNull = (value as string[]).filter((t) => t !== 'null');
        result.type = nonNull[0] ?? 'string';
        continue;
      }
      result[key] = toAnthropicSchema(value);
    }
    return result;
  }
  return schema;
}

function toAnthropicTools(tools: readonly ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: toAnthropicSchema(tool.parameters),
  }));
}

function toToolCalls(blocks: AnthropicBlock[]): ToolCall[] | null {
  const toolUse = blocks.filter(isToolUseBlock);
  if (toolUse.length === 0) return null;
  return toolUse.map((b) => ({ id: b.id, name: b.name, args: b.input }));
}

/**
 * Anthropic Messages API adapter (raw HTTP, no SDK - ARCHITECTURE.md §22
 * keeps provider deps to a per-adapter fetch). Deliberately never sends
 * `tool_choice`, even when `options.toolChoice` is set: Anthropic's tool
 * forcing (`{type: 'tool', name}`) is documented as incompatible with
 * extended thinking, and `claude-sonnet-5`/`claude-opus-5` both run
 * adaptive thinking by default whenever `thinking` isn't explicitly
 * configured - which this adapter never does. `llm/one-shot-from-agent.ts`
 * already has a text-parsing fallback for exactly this case (a provider
 * that ignores `toolChoice`).
 */
export function createAnthropicAgentAdapter({
  apiKey,
  model = DEFAULT_ANTHROPIC_MODEL,
  logger,
  fetch = globalThis.fetch,
  baseUrl = 'https://api.anthropic.com/v1',
  maxRetries = 3,
  retryBaseMs = 1000,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: AnthropicAdapterOptions): AgentAdapter {
  const log = logger.child({ component: 'anthropic', model });
  const url = `${baseUrl.replace(/\/+$/, '')}/messages`;
  const httpOptions = { apiKey, fetch, logger: log, maxRetries, retryBaseMs, requestTimeoutMs };

  return {
    async chat(messages, tools, options = {}): Promise<AgentChatResult> {
      const systemMessage = messages.find((m) => m.role === 'system');
      const body = JSON.stringify({
        model,
        max_tokens: MAX_TOKENS,
        ...(systemMessage && { system: systemMessage.content }),
        messages: toAnthropicMessages(messages),
        ...(tools.length > 0 && { tools: toAnthropicTools(tools) }),
      });

      const data = (await callAnthropicApi(url, body, httpOptions, options.signal)) as {
        content?: AnthropicBlock[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const blocks = data.content ?? [];
      const text = blocks
        .filter(isTextBlock)
        .map((b) => b.text)
        .join('');

      return {
        text: text || null,
        toolCalls: toToolCalls(blocks),
        usage: {
          ...(data.usage?.input_tokens !== undefined && { inputTokens: data.usage.input_tokens }),
          ...(data.usage?.output_tokens !== undefined && {
            outputTokens: data.usage.output_tokens,
          }),
        },
        providerData: { content: blocks },
      };
    },
  };
}
