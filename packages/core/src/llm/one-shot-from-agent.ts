import { TOOL_DEFINITIONS } from '../agent/tools.js';
import type { AgentAdapter, AgentMessage } from '../agent/types.js';
import { ModelError, ModelInvalidOutputError } from './errors.js';
import { buildReviewPrompt, SYSTEM_PROMPT } from './prompt.js';
import { modelReviewOutputSchema, type ReviewModel, type ReviewModelInput } from './types.js';

function findSubmitReviewTool() {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === 'submit_review');
  if (!tool) throw new Error('one-shot-from-agent: submit_review tool definition missing');
  return tool;
}
const SUBMIT_REVIEW_TOOL = findSubmitReviewTool();

const PARSE_FAILED = Symbol('parse-failed');

function tryParseFallbackText(text: string | null): unknown {
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

/**
 * Builds a one-shot `ReviewModel` (AI_AGENT_SPEC.md §15's fallback mode)
 * out of any `AgentAdapter`, without running a full agent loop: a single
 * `chat()` call with only the `submit_review` tool and `toolChoice` forcing
 * it, so the same request/response translation each provider adapter
 * already has for the agent loop also serves the one-shot path - no
 * separate per-provider one-shot implementation needed. Falls back to
 * parsing the response as plain text if the provider ignores `toolChoice`
 * (some don't support forcing a call at all).
 */
export function createOneShotFromAgentAdapter(adapter: AgentAdapter): ReviewModel {
  return {
    async generateReview(input: ReviewModelInput, options = {}) {
      const messages: AgentMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildReviewPrompt(input) },
      ];

      let result;
      try {
        result = await adapter.chat(messages, [SUBMIT_REVIEW_TOOL], {
          ...(options.signal && { signal: options.signal }),
          toolChoice: { name: 'submit_review' },
        });
      } catch (err) {
        if (err instanceof ModelError) throw err;
        throw new ModelInvalidOutputError(
          err instanceof Error ? err.message : 'model call failed unexpectedly',
        );
      }

      const toolCall = result.toolCalls?.find((tc) => tc.name === 'submit_review');
      const candidate =
        toolCall !== undefined
          ? typeof toolCall.args === 'string'
            ? tryParseFallbackText(toolCall.args)
            : toolCall.args
          : tryParseFallbackText(result.text);

      if (candidate === PARSE_FAILED) {
        throw new ModelInvalidOutputError('model response was not valid JSON');
      }
      const parsed = modelReviewOutputSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new ModelInvalidOutputError(
          'model response failed schema validation',
          parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        );
      }
      return parsed.data;
    },
  };
}
