import type {
  AgentAdapter,
  AgentChatResult,
  AgentMessage,
  ToolCall,
  ToolDefinition,
} from '../agent/types.js';
import type { Logger } from '../logger.js';
import { callGeminiApi } from './gemini-http.js';
import { DEFAULT_GEMINI_MODEL } from './gemini.js';

export interface GeminiAgentAdapterOptions {
  apiKey: string;
  model?: string;
  logger: Logger;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  maxRetries?: number;
  retryBaseMs?: number;
}

interface GeminiTextPart {
  text: string;
}
interface GeminiFunctionCallPart {
  functionCall: { name: string; args: Record<string, unknown> };
}
interface GeminiFunctionResponsePart {
  functionResponse: { name: string; response: { content: string } };
}
type GeminiPart = GeminiTextPart | GeminiFunctionCallPart | GeminiFunctionResponsePart;
interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

function isFunctionResponsePart(part: GeminiPart): part is GeminiFunctionResponsePart {
  return 'functionResponse' in part;
}
function isFunctionCallPart(part: GeminiPart): part is GeminiFunctionCallPart {
  return 'functionCall' in part;
}
function isTextPart(part: GeminiPart): part is GeminiTextPart {
  return 'text' in part;
}

/**
 * Translates the loop's provider-neutral history into Gemini's `contents`.
 * An assistant turn that carries `providerData.parts` (this adapter's own
 * earlier output) is echoed back verbatim rather than re-serialized from
 * the normalized `ToolCall[]`, since Gemini can attach fields (e.g. a
 * `thoughtSignature`) to a function-call part that a round-trip through our
 * own types would silently drop.
 */
function toGeminiContents(messages: readonly AgentMessage[]): GeminiContent[] {
  const contents: GeminiContent[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: message.content }] });
      continue;
    }
    if (message.role === 'assistant') {
      const raw = message.providerData as { parts?: GeminiPart[] } | undefined;
      if (raw?.parts) {
        contents.push({ role: 'model', parts: raw.parts });
        continue;
      }
      const parts: GeminiPart[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        parts.push({
          functionCall: { name: call.name, args: call.args as Record<string, unknown> },
        });
      }
      contents.push({ role: 'model', parts });
      continue;
    }
    // tool: Gemini keys a functionResponse by name, and expects every response for one
    // model turn's function calls batched into a single following 'user' content.
    const part: GeminiPart = {
      functionResponse: { name: message.name, response: { content: message.content } },
    };
    const last = contents[contents.length - 1];
    if (last?.role === 'user' && last.parts.every(isFunctionResponsePart)) {
      last.parts.push(part);
    } else {
      contents.push({ role: 'user', parts: [part] });
    }
  }
  return contents;
}

/**
 * Gemini's function-calling schema is a JSON Schema subset: no
 * `additionalProperties`, and `nullable: true` instead of a `type` union
 * with `"null"` (see `agent/tools.ts`'s `suggested_code` field).
 */
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema && typeof schema === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'additionalProperties') continue;
      if (key === 'type' && Array.isArray(value)) {
        const nonNull = (value as string[]).find((t) => t !== 'null');
        if (nonNull) result.type = nonNull;
        if ((value as string[]).includes('null')) result.nullable = true;
        continue;
      }
      result[key] = toGeminiSchema(value);
    }
    return result;
  }
  return schema;
}

function toFunctionDeclarations(tools: readonly ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: toGeminiSchema(tool.parameters),
  }));
}

let callCounter = 0;

function toToolCalls(parts: readonly GeminiPart[]): ToolCall[] | null {
  const functionCalls = parts.filter(isFunctionCallPart);
  if (functionCalls.length === 0) return null;
  return functionCalls.map((part) => {
    callCounter += 1;
    return {
      id: `gemini_call_${callCounter}`,
      name: part.functionCall.name,
      args: part.functionCall.args,
    };
  });
}

/**
 * Gemini implementation of `AgentAdapter` (AI_AGENT_SPEC.md §16), built
 * first per that section. Unlike the one-shot `createGeminiAdapter`
 * (`gemini.ts`), this never sets `responseSchema`: the model may respond
 * with a function call or with plain text, and the agent loop's fallback
 * parsing (§9) handles the plain-text case.
 */
export function createGeminiAgentAdapter({
  apiKey,
  model = DEFAULT_GEMINI_MODEL,
  logger,
  fetch = globalThis.fetch,
  baseUrl = 'https://generativelanguage.googleapis.com',
  maxRetries = 3,
  retryBaseMs = 1000,
}: GeminiAgentAdapterOptions): AgentAdapter {
  const log = logger.child({ component: 'gemini-agent', model });
  const url = `${baseUrl}/v1beta/models/${model}:generateContent`;
  const httpOptions = { apiKey, fetch, baseUrl, logger: log, maxRetries, retryBaseMs };

  return {
    async chat(messages, tools, options = {}): Promise<AgentChatResult> {
      const systemMessage = messages.find((m) => m.role === 'system');
      const body = JSON.stringify({
        contents: toGeminiContents(messages),
        ...(systemMessage && { systemInstruction: { parts: [{ text: systemMessage.content }] } }),
        tools: [{ functionDeclarations: toFunctionDeclarations(tools) }],
      });

      const data = (await callGeminiApi(url, body, httpOptions, options.signal)) as {
        candidates?: { content?: { parts?: GeminiPart[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const text =
        parts
          .filter(isTextPart)
          .map((p) => p.text)
          .join('') || null;

      return {
        text,
        toolCalls: toToolCalls(parts),
        usage: {
          ...(data.usageMetadata?.promptTokenCount !== undefined && {
            inputTokens: data.usageMetadata.promptTokenCount,
          }),
          ...(data.usageMetadata?.candidatesTokenCount !== undefined && {
            outputTokens: data.usageMetadata.candidatesTokenCount,
          }),
        },
        providerData: { parts },
      };
    },
  };
}
