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
}
