import type { ToolCallStatus } from '../db/schema.js';
import type { ModelReviewOutput } from '../llm/types.js';

/**
 * Provider-neutral tool contract (ARCHITECTURE.md §12, AI_AGENT_SPEC.md
 * §5). `parameters` is a JSON Schema object; adapters translate it into
 * whatever shape their provider's SDK wants. Agent logic never imports a
 * provider SDK, and this module never imports one either.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One tool result returned to the model for one tool call. */
export interface ToolExecutionResult {
  text: string;
  /** True only for a successful `submit_review` call: the loop should stop. */
  done?: boolean;
  /** The validated review payload, set only alongside `done: true`. */
  output?: ModelReviewOutput;
  /**
   * Mirrors `agent_tool_calls.status` (DATA_MODEL.md) so the loop can
   * persist a call's outcome without re-deriving it from result text:
   * `SUCCEEDED` for a real answer (including "file not found" - the tool
   * ran correctly), `REJECTED` for a call the executor refused before
   * doing any work (bad path, duplicate fetch, schema-invalid submission),
   * `FAILED` for a call that ran and hit a real error (transient fetch
   * failure, timeout, unexpected exception).
   */
  status: ToolCallStatus;
}

/**
 * A tool call as the loop sees it, normalized across providers (§16's
 * adapters). `id` is always present - Gemini's function calls often omit
 * one, so its adapter synthesizes one - so every result can be matched back
 * to the call that produced it regardless of provider.
 */
export interface ToolCall {
  id: string;
  name: string;
  /** Parsed if the provider sent an object, or the raw string if it sent one (OpenAI-style). */
  args: unknown;
}

/**
 * One turn of the agent conversation (AI_AGENT_SPEC.md §9/§16). `assistant`
 * carries `providerData`, an opaque blob the adapter attaches and later
 * reads back unchanged when it re-serializes history for its own API - the
 * loop never inspects it, since providers disagree on what a tool-call turn
 * needs to round-trip (Gemini's `thoughtSignature`, OpenAI's raw `tool_calls`
 * shape, ...).
 */
export type AgentMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      toolCalls: ToolCall[] | null;
      providerData?: unknown;
    }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface AgentChatOptions {
  signal?: AbortSignal;
}

export interface AgentChatResult {
  text: string | null;
  toolCalls: ToolCall[] | null;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** See `AgentMessage`'s `providerData` - the adapter's own state for this turn. */
  providerData?: unknown;
}

/** Provider-neutral chat contract (AI_AGENT_SPEC.md §16). The loop never imports a provider SDK. */
export interface AgentAdapter {
  chat(
    messages: readonly AgentMessage[],
    tools: readonly ToolDefinition[],
    options?: AgentChatOptions,
  ): Promise<AgentChatResult>;
}

/**
 * The surface `agent/loop.ts` needs from a tool executor - deliberately an
 * interface, not the concrete `AgentToolExecutor` class, so the loop can be
 * unit-tested against a fake with no database or GitHub client at all.
 */
export interface ToolExecutor {
  execute(toolName: string, args: unknown): Promise<ToolExecutionResult>;
  readonly deliveredFileCount: number;
}
