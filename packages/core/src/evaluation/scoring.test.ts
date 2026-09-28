import { describe, expect, it } from 'vitest';
import type { ModelFinding } from '../llm/types.js';
import { modifiedFile } from './fixtures/patch-builder.js';
import {
  aggregateReport,
  computeCostUsd,
  LINE_MATCH_TOLERANCE,
  matchFindings,
  scoreCase,
} from './scoring.js';
import type { EvalCase, PriceTable } from './types.js';

function finding(overrides: Partial<ModelFinding> = {}): ModelFinding {
  return {
    filename: 'src/a.ts',
    severity: 'medium',
    start_line: 5,
    end_line: 5,
    issue: 'issue',
    fix_type: 'warning',
    suggested_code: null,
    ...overrides,
  };
}

// 2 lines context, 3 added lines (new lines 3-5), 2 lines context.
function bugCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'case-a',
    title: 'A bug',
    category: 'known-bug',
    description: 'desc',
    pullRequestTitle: 'title',
    pullRequestBody: null,
    files: [
      modifiedFile('src/a.ts', 1, 1, [
        ' context1',
        ' context2',
        '+added3',
        '+added4',
        '+added5',
        ' context6',
        ' context7',
      ]),
    ],
    expectedFindings: [
      { filename: 'src/a.ts', startLine: 4, endLine: 4, severity: 'high', description: 'the bug' },
    ],
    ...overrides,
  };
}

describe('matchFindings', () => {
  it('matches within LINE_MATCH_TOLERANCE lines', () => {
    const expected = [
      {
        filename: 'src/a.ts',
        startLine: 10,
        endLine: 10,
        severity: 'high' as const,
        description: 'x',
      },
    ];
    const predicted = [
      finding({ start_line: 10 + LINE_MATCH_TOLERANCE, end_line: 10 + LINE_MATCH_TOLERANCE }),
    ];
    expect(matchFindings(expected, predicted)).toHaveLength(1);
  });

  it('does not match beyond the tolerance', () => {
    const expected = [
      {
        filename: 'src/a.ts',
        startLine: 10,
        endLine: 10,
        severity: 'high' as const,
        description: 'x',
      },
    ];
    const predicted = [
      finding({
        start_line: 10 + LINE_MATCH_TOLERANCE + 1,
        end_line: 10 + LINE_MATCH_TOLERANCE + 1,
      }),
    ];
    expect(matchFindings(expected, predicted)).toHaveLength(0);
  });

  it('never matches the same prediction to two expected findings', () => {
    const expected = [
      {
        filename: 'src/a.ts',
        startLine: 10,
        endLine: 10,
        severity: 'high' as const,
        description: 'x',
      },
      {
        filename: 'src/a.ts',
        startLine: 11,
        endLine: 11,
        severity: 'high' as const,
        description: 'y',
      },
    ];
    const predicted = [finding({ start_line: 10, end_line: 11 })];
    expect(matchFindings(expected, predicted)).toHaveLength(1);
  });

  it('requires the same filename', () => {
    const expected = [
      {
        filename: 'src/a.ts',
        startLine: 10,
        endLine: 10,
        severity: 'high' as const,
        description: 'x',
      },
    ];
    const predicted = [finding({ filename: 'src/b.ts', start_line: 10, end_line: 10 })];
    expect(matchFindings(expected, predicted)).toHaveLength(0);
  });
});

describe('scoreCase', () => {
  it('scores an oracle model as precision=recall=1, severityAccuracy=1, exact line match', () => {
    const evalCase = bugCase();
    const score = scoreCase(
      evalCase,
      { summary: 's', reviews: [finding({ start_line: 4, end_line: 4, severity: 'high' })] },
      { durationMs: 100 },
    );
    expect(score.precision).toBe(1);
    expect(score.recall).toBe(1);
    expect(score.matches[0]?.exactLineMatch).toBe(true);
    expect(score.matches[0]?.severityMatch).toBe(true);
  });

  it('scores wrong severity as matched but not a severity match', () => {
    const evalCase = bugCase();
    const score = scoreCase(
      evalCase,
      { summary: 's', reviews: [finding({ start_line: 4, end_line: 4, severity: 'low' })] },
      { durationMs: 0 },
    );
    expect(score.matchedCount).toBe(1);
    expect(score.matches[0]?.severityMatch).toBe(false);
  });

  it('scores a finding 3 lines off (beyond tolerance) as unmatched', () => {
    const evalCase = bugCase();
    const score = scoreCase(
      evalCase,
      {
        summary: 's',
        reviews: [
          finding({
            start_line: 4 + LINE_MATCH_TOLERANCE + 1,
            end_line: 4 + LINE_MATCH_TOLERANCE + 1,
          }),
        ],
      },
      { durationMs: 0 },
    );
    expect(score.matchedCount).toBe(0);
    expect(score.recall).toBe(0);
  });

  it('empty predictions score recall=0 and precision=null', () => {
    const score = scoreCase(bugCase(), { summary: 's', reviews: [] }, { durationMs: 0 });
    expect(score.recall).toBe(0);
    expect(score.precision).toBeNull();
  });

  it('a false-positive-trap prediction on an FP case yields precision=0', () => {
    const fpCase = bugCase({ category: 'false-positive', expectedFindings: [] });
    const score = scoreCase(
      fpCase,
      { summary: 's', reviews: [finding({ start_line: 4, end_line: 4 })] },
      { durationMs: 0 },
    );
    expect(score.precision).toBe(0);
    expect(score.recall).toBeNull();
  });

  it('drops findings below the configured minimum severity before scoring, mirroring production', () => {
    const evalCase = bugCase();
    const score = scoreCase(
      evalCase,
      { summary: 's', reviews: [finding({ start_line: 4, end_line: 4, severity: 'low' })] },
      { durationMs: 0 },
      { minimumSeverity: 'medium' },
    );
    expect(score.predictedCount).toBe(0);
    expect(score.recall).toBe(0);
  });
});

describe('aggregateReport', () => {
  it('micro-averages precision and recall across cases rather than meaning per-case ratios', () => {
    const caseA = scoreCase(
      bugCase({ id: 'a' }),
      { summary: 's', reviews: [finding({ start_line: 4, end_line: 4 })] },
      { durationMs: 10 },
    );
    const fpCase = bugCase({ id: 'b', category: 'false-positive', expectedFindings: [] });
    const caseB = scoreCase(
      fpCase,
      { summary: 's', reviews: [finding({ start_line: 4, end_line: 4 })] },
      { durationMs: 20 },
    );

    const report = aggregateReport([caseA, caseB]);
    // 1 matched / 2 predicted total (one true positive, one false positive on the FP-trap case).
    expect(report.precision).toBe(0.5);
    expect(report.recall).toBe(1);
    expect(report.avgDurationMs).toBe(15);
  });

  it('reports null line/severity accuracy when nothing matched', () => {
    const caseA = scoreCase(bugCase(), { summary: 's', reviews: [] }, { durationMs: 0 });
    const report = aggregateReport([caseA]);
    expect(report.lineAccuracy).toBeNull();
    expect(report.severityAccuracy).toBeNull();
  });
});

describe('computeCostUsd', () => {
  const prices: PriceTable = {
    'anthropic:claude-opus-5': { inputPerMillionTokens: 10, outputPerMillionTokens: 30 },
  };

  it('computes cost from a price table entry', () => {
    const cost = computeCostUsd(
      { inputTokens: 1_000_000, outputTokens: 500_000, durationMs: 0 },
      'anthropic',
      'claude-opus-5',
      prices,
    );
    expect(cost).toBe(10 + 15);
  });

  it('returns null with no price table', () => {
    expect(
      computeCostUsd(
        { inputTokens: 100, outputTokens: 100, durationMs: 0 },
        'anthropic',
        'claude-opus-5',
      ),
    ).toBeNull();
  });

  it('returns null when the provider+model has no entry', () => {
    expect(
      computeCostUsd(
        { inputTokens: 100, outputTokens: 100, durationMs: 0 },
        'openai',
        'gpt-5.1',
        prices,
      ),
    ).toBeNull();
  });

  it('returns null when token usage is missing, never fabricating a number', () => {
    expect(computeCostUsd({ durationMs: 0 }, 'anthropic', 'claude-opus-5', prices)).toBeNull();
  });
});
