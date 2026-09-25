import type { AgentTerminationReason } from '../db/schema.js';
import type { ModelReviewOutput } from '../llm/types.js';
import { TOOL_DEFINITIONS } from './tools.js';
import type {
  AgentAdapter,
  AgentChatResult,
  AgentMessage,
  ToolCall,
  ToolDefinition,
  ToolExecutionResult,
  ToolExecutor,
} from './types.js';

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_FILE_FETCHES = 12;

export interface ToolCallEvent {
  turnNumber: number;
  toolCall: ToolCall;
  result: ToolExecutionResult;
  durationMs: number;
}

export interface AgentLoopOptions {
  adapter: AgentAdapter;
  executor: ToolExecutor;
  systemPrompt: string;
  initialUserMessage: string;
  tools?: readonly ToolDefinition[];
  maxTurns?: number;
  maxFileFetches?: number;
  /** Wall-clock budget from now (AI_AGENT_SPEC.md §9's `MAX_REVIEW_SECONDS`). */
  deadlineMs?: number;
  /** External cancellation, combined with the deadline above. */
  signal?: AbortSignal;
  /** Called after every tool call resolves - the only hook the loop needs for persistence, so it stays testable without a database. */
  onToolCall?: (event: ToolCallEvent) => void | Promise<void>;
}

export interface AgentLoopResult {
  /** Mirrors `agent_runs.status`; `SUCCEEDED` only when `output` is non-null. */
  status: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT';
  terminationReason: AgentTerminationReason;
  output: ModelReviewOutput | null;
  turnCount: number;
  fileFetchCount: number;
  usage: { inputTokens: number; outputTokens: number };
}

const FETCH_LIMIT_MESSAGE = (max: number): string =>
  `File fetch limit reached (${max} files). Stop investigating and call submit_review now with your best findings so far.`;

const FINAL_TURN_MESSAGE =
  'This is your final turn before the turn limit. You must call submit_review now with your best findings so far.';

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/**
 * Strips a ```json fence if present, then parses. AI_AGENT_SPEC.md §9's
 * "attempt safe fallback parsing" for a turn that ended with plain text
 * instead of a `submit_review` call - distinct from §15's "fallback mode"
 * (a one-shot prompt for a provider that can't do tool calling at all,
 * which is what Phase 4's existing pipeline path already is).
 */
function tryFallbackParse(text: string | null): unknown {
  if (!text) return PARSE_FAILED;
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    return PARSE_FAILED;
  }
}
const PARSE_FAILED = Symbol('parse-failed');

/**
 * Runs the tool-call loop of AI_AGENT_SPEC.md §9: diff -> tool calls ->
 * submit_review, with no human intervention. Provider-neutral - everything
 * here goes through `AgentAdapter`/`ToolExecutor`, never a provider
 * SDK directly (ARCHITECTURE.md §12).
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const {
    adapter,
    executor,
    systemPrompt,
    initialUserMessage,
    tools = TOOL_DEFINITIONS,
    maxTurns = DEFAULT_MAX_TURNS,
    maxFileFetches = DEFAULT_MAX_FILE_FETCHES,
  } = options;

  const deadlineSignal =
    options.deadlineMs !== undefined ? AbortSignal.timeout(options.deadlineMs) : undefined;
  const signals = [options.signal, deadlineSignal].filter((s): s is AbortSignal => s !== undefined);
  const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;

  const messages: AgentMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: initialUserMessage },
  ];

  let usage = { inputTokens: 0, outputTokens: 0 };
  let fetchLimitHit = false;
  let turn = 0;

  const finalize = (
    status: AgentLoopResult['status'],
    terminationReason: AgentTerminationReason,
    output: ModelReviewOutput | null,
  ): AgentLoopResult => ({
    status,
    terminationReason:
      fetchLimitHit && status !== 'SUCCEEDED' ? 'MAX_FILE_FETCHES' : terminationReason,
    output,
    turnCount: turn,
    fileFetchCount: executor.deliveredFileCount,
    usage,
  });

  for (turn = 1; turn <= maxTurns; turn++) {
    if (signal?.aborted) {
      return finalize('TIMED_OUT', 'TIMEOUT', null);
    }
    if (turn === maxTurns) {
      messages.push({ role: 'user', content: FINAL_TURN_MESSAGE });
    }

    let response: AgentChatResult;
    try {
      response = await adapter.chat(messages, tools, { ...(signal && { signal }) });
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) return finalize('TIMED_OUT', 'TIMEOUT', null);
      return finalize('FAILED', 'MODEL_ERROR', null);
    }
    if (response.usage) {
      usage = {
        inputTokens: usage.inputTokens + (response.usage.inputTokens ?? 0),
        outputTokens: usage.outputTokens + (response.usage.outputTokens ?? 0),
      };
    }
    messages.push({
      role: 'assistant',
      content: response.text,
      toolCalls: response.toolCalls,
      ...(response.providerData !== undefined && { providerData: response.providerData }),
    });

    if (!response.toolCalls || response.toolCalls.length === 0) {
      const parsed = tryFallbackParse(response.text);
      if (parsed !== PARSE_FAILED) {
        const result = await executor.execute('submit_review', parsed);
        if (result.done && result.output) {
          return finalize(
            'SUCCEEDED',
            result.output.reviews.length === 0 ? 'NO_FINDINGS' : 'SUBMITTED',
            result.output,
          );
        }
      }
      return finalize('FAILED', 'INVALID_OUTPUT', null);
    }

    let submitted: ModelReviewOutput | undefined;
    for (const toolCall of response.toolCalls) {
      const atFetchLimit =
        toolCall.name === 'get_file_content' && executor.deliveredFileCount >= maxFileFetches;
      if (atFetchLimit) fetchLimitHit = true;

      const started = Date.now();
      const result: ToolExecutionResult = atFetchLimit
        ? { text: FETCH_LIMIT_MESSAGE(maxFileFetches), status: 'REJECTED' }
        : await executor.execute(toolCall.name, toolCall.args);
      const durationMs = Date.now() - started;

      await options.onToolCall?.({ turnNumber: turn, toolCall, result, durationMs });
      messages.push({
        role: 'tool',
        toolCallId: toolCall.id,
        name: toolCall.name,
        content: result.text,
      });
      if (result.done && result.output) submitted = result.output;
    }

    if (submitted) {
      return finalize(
        'SUCCEEDED',
        submitted.reviews.length === 0 ? 'NO_FINDINGS' : 'SUBMITTED',
        submitted,
      );
    }
  }

  turn = maxTurns;
  return finalize('FAILED', 'MAX_TURNS', null);
}
