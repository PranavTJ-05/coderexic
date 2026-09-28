import { describe, expect, it, vi } from 'vitest';
import { ModelInvalidOutputError } from '../llm/errors.js';
import type { ProviderEntry } from '../llm/provider-factory.js';
import type { AgentAdapter, AgentChatResult } from '../agent/types.js';
import type { ReviewModel } from '../llm/types.js';
import type { EvalCase } from './types.js';
import { buildLiveReviewer, withFailureHandling, withUsageCapture } from './live.js';

function evalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'case-a',
    title: 'A case',
    category: 'known-bug',
    description: 'desc',
    pullRequestTitle: 'title',
    pullRequestBody: null,
    files: [
      {
        filename: 'src/a.ts',
        previousFilename: null,
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1,1 +1,2 @@\n context\n+added',
      },
    ],
    expectedFindings: [],
    ...overrides,
  };
}

describe('withUsageCapture', () => {
  it('captures the last chat() call usage', async () => {
    const chat = vi.fn((): Promise<AgentChatResult> =>
      Promise.resolve({
        text: null,
        toolCalls: null,
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    );
    const fakeAdapter: AgentAdapter = { chat };
    const { wrapped, lastUsage } = withUsageCapture(fakeAdapter);
    expect(lastUsage()).toBeUndefined();
    await wrapped.chat([], []);
    expect(lastUsage()).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});

function fakeProviderEntry(reviewModel: ReviewModel, agentAdapter: AgentAdapter): ProviderEntry {
  return { provider: 'openai', modelName: 'test-model', reviewModel, agentAdapter };
}

describe('buildLiveReviewer', () => {
  it('reports usage from the underlying agent adapter for a non-Gemini provider', async () => {
    const chat = vi.fn((): Promise<AgentChatResult> =>
      Promise.resolve({
        text: null,
        toolCalls: [
          {
            id: 'call-1',
            name: 'submit_review',
            args: { summary: 'ok', reviews: [] },
          },
        ],
        usage: { inputTokens: 100, outputTokens: 20 },
      }),
    );
    const fakeAdapter: AgentAdapter = { chat };
    const entry = fakeProviderEntry(
      { generateReview: () => Promise.reject(new Error('unused for non-gemini')) },
      fakeAdapter,
    );
    const reviewer = buildLiveReviewer('openai', entry, 5_000);
    const { output, usage } = await reviewer(evalCase());
    expect(output).toEqual({ summary: 'ok', reviews: [] });
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(20);
    expect(usage.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('uses entry.reviewModel directly for gemini, with no token usage', async () => {
    const geminiReviewModel: ReviewModel = {
      generateReview: () => Promise.resolve({ summary: 'ok', reviews: [] }),
    };
    const chat = vi.fn(() => Promise.reject(new Error('gemini must not call the agent adapter')));
    const unusedAdapter: AgentAdapter = { chat };
    const entry = fakeProviderEntry(geminiReviewModel, unusedAdapter);
    const reviewer = buildLiveReviewer('gemini', entry, 5_000);
    const { output, usage } = await reviewer(evalCase());
    expect(output).toEqual({ summary: 'ok', reviews: [] });
    expect(usage.inputTokens).toBeUndefined();
    expect(usage.outputTokens).toBeUndefined();
    expect(chat).not.toHaveBeenCalled();
  });
});

describe('withFailureHandling', () => {
  it('scores a ModelError as an empty review and reports it via onFailure', async () => {
    const onFailure = vi.fn();
    const reviewOnce = () => Promise.reject(new ModelInvalidOutputError('bad json'));
    const adapter = withFailureHandling(reviewOnce, onFailure);
    const { output, usage } = await adapter.review(evalCase());
    expect(output.reviews).toEqual([]);
    expect(usage.durationMs).toBeGreaterThanOrEqual(0);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('rethrows an error that is not a ModelError', async () => {
    const reviewOnce = () => Promise.reject(new Error('harness bug'));
    const adapter = withFailureHandling(reviewOnce, vi.fn());
    await expect(adapter.review(evalCase())).rejects.toThrow('harness bug');
  });
});
