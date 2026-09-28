import { createOneShotFromAgentAdapter } from '../llm/one-shot-from-agent.js';
import { ModelError } from '../llm/errors.js';
import type { ProviderEntry } from '../llm/provider-factory.js';
import type { SupportedModelProvider } from '../config/schema.js';
import type { AgentAdapter, AgentChatResult } from '../agent/types.js';
import type { ModelReviewOutput, ReviewModel } from '../llm/types.js';
import type { EvalCase, EvalModelAdapter, EvalUsage } from './types.js';

/**
 * Wraps an `AgentAdapter` so the *last* `chat()` call's `usage` can be read
 * back afterwards. `createOneShotFromAgentAdapter` (production's own
 * one-shot builder) makes exactly one `chat()` call per `generateReview`,
 * so "last" is unambiguous for a single review.
 */
export function withUsageCapture(adapter: AgentAdapter): {
  wrapped: AgentAdapter;
  lastUsage: () => AgentChatResult['usage'];
} {
  let lastUsage: AgentChatResult['usage'];
  return {
    wrapped: {
      async chat(messages, tools, options) {
        const result = await adapter.chat(messages, tools, options);
        lastUsage = result.usage;
        return result;
      },
    },
    lastUsage: () => lastUsage,
  };
}

/**
 * Builds a function that reviews one eval case against a real provider,
 * reusing production's own one-shot path (`createOneShotFromAgentAdapter`)
 * rather than re-deriving prompt construction, tool-forcing and response
 * parsing - the exact code path `apps/worker/src/review/pipeline.ts` calls
 * when there's no `agentAdapter` configured (AI_AGENT_SPEC.md §15's
 * fallback mode).
 *
 * Gemini is the one exception: `buildProviderRegistry` gives it its own
 * dedicated one-shot (`createGeminiAdapter`), not
 * `createOneShotFromAgentAdapter`, so wrapping its agent adapter here would
 * measure a path production doesn't actually take for Gemini. Its
 * `entry.reviewModel` is used directly instead, at the cost of token usage
 * (and therefore cost) being unavailable for that provider.
 */
export function buildLiveReviewer(
  provider: SupportedModelProvider,
  entry: ProviderEntry,
  timeoutMs: number,
): (evalCase: EvalCase) => Promise<{ output: ModelReviewOutput; usage: EvalUsage }> {
  const capture = provider === 'gemini' ? undefined : withUsageCapture(entry.agentAdapter);
  const reviewModel: ReviewModel =
    provider === 'gemini' || !capture
      ? entry.reviewModel
      : createOneShotFromAgentAdapter(capture.wrapped);

  return async (evalCase: EvalCase) => {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      const output = await reviewModel.generateReview(
        {
          repositoryFullName: 'eval/fixture',
          pullRequestTitle: evalCase.pullRequestTitle,
          pullRequestBody: evalCase.pullRequestBody,
          files: evalCase.files
            .filter((f): f is typeof f & { patch: string } => f.patch !== null)
            .map((f) => ({ filename: f.filename, status: f.status, patch: f.patch })),
        },
        { signal: controller.signal },
      );
      const durationMs = Date.now() - started;
      const usage = capture?.lastUsage();
      return {
        output,
        usage: {
          durationMs,
          ...(usage?.inputTokens !== undefined && { inputTokens: usage.inputTokens }),
          ...(usage?.outputTokens !== undefined && { outputTokens: usage.outputTokens }),
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

/**
 * Wraps a per-case reviewer so one case's model failure (bad JSON, a
 * timeout, a provider error - anything `ModelError` covers) doesn't abort
 * every other, already-paid-for case: it's scored as an empty review
 * instead (production posts nothing in these cases either -
 * `failReviewJob`, never a partial review). Anything that isn't a
 * `ModelError` still propagates, since that's an unexpected harness bug,
 * not a model failure. `onFailure` lets the caller track how many cases
 * failed, so a run full of provider errors is visible in the report rather
 * than looking like uniformly bad recall.
 */
export function withFailureHandling(
  reviewOnce: (evalCase: EvalCase) => Promise<{ output: ModelReviewOutput; usage: EvalUsage }>,
  onFailure: (evalCase: EvalCase, err: ModelError) => void,
): EvalModelAdapter {
  return {
    async review(evalCase: EvalCase) {
      const started = Date.now();
      try {
        return await reviewOnce(evalCase);
      } catch (err) {
        if (err instanceof ModelError) {
          onFailure(evalCase, err);
          const output: ModelReviewOutput = {
            summary: `model call failed: ${err.message}`,
            reviews: [],
          };
          return { output, usage: { durationMs: Date.now() - started } };
        }
        throw err;
      }
    },
  };
}
