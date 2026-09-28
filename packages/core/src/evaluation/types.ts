import type { PRFile } from '../github/types.js';
import type { Severity } from '../db/schema.js';
import type { ModelReviewOutput } from '../llm/types.js';

/**
 * One finding a fixture case expects the pipeline to produce (ROADMAP.md
 * Phase 15's "Expected findings"). A case with an empty `expectedFindings`
 * array is a false-positive trap: code that looks suspicious but is
 * correct, where any prediction at all is a false positive.
 */
export interface EvalExpectedFinding {
  filename: string;
  startLine: number;
  endLine: number;
  severity: Severity;
  /** Short human description of the expected finding, for report output only. */
  description: string;
}

export type EvalCaseCategory = 'known-bug' | 'false-positive';

/**
 * A self-contained fixture case: a synthetic PR diff (in the same
 * `PRFile[]` shape `selectReviewableFiles`/`selection.files` expects) plus
 * the findings a good reviewer should (or, for a false-positive trap,
 * should not) report on it.
 */
export interface EvalCase {
  id: string;
  title: string;
  category: EvalCaseCategory;
  /** Why this case is interesting - what bug it plants, or what makes the FP trap tempting. */
  description: string;
  pullRequestTitle: string;
  pullRequestBody: string | null;
  files: readonly PRFile[];
  expectedFindings: readonly EvalExpectedFinding[];
}

/** Usage/timing a scorer accepts per case, mirroring `reviews.inputTokens`/`outputTokens`/`durationMs` (DATA_MODEL.md). */
export interface EvalUsage {
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
}

/** Price per million tokens for one provider+model, an explicit input rather than a hardcoded guess. */
export interface ModelPrice {
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
}

/** Keyed `${provider}:${model}`, e.g. `"anthropic:claude-opus-5"`. */
export type PriceTable = Record<string, ModelPrice>;

export interface MatchedPair {
  expected: EvalExpectedFinding;
  predictedFilename: string;
  predictedSeverity: Severity;
  predictedStartLine: number;
  predictedEndLine: number;
  /** True when both start and end lines match the expected range exactly. */
  exactLineMatch: boolean;
  severityMatch: boolean;
}

export interface CaseScore {
  id: string;
  title: string;
  category: EvalCaseCategory;
  expectedCount: number;
  /** Every finding that survived dedupe, inline or summary-only - what a user could see. */
  predictedCount: number;
  inlineCount: number;
  summaryOnlyCount: number;
  matchedCount: number;
  /** matched / predicted, `null` when there were no predictions to score. */
  precision: number | null;
  /** matched / expected, `null` for a false-positive-trap case (0 expected). */
  recall: number | null;
  matches: readonly MatchedPair[];
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  /** USD, `null` when tokens or a price table entry are unavailable. */
  costUsd: number | null;
}

export interface EvalReport {
  cases: readonly CaseScore[];
  caseCount: number;
  totalExpected: number;
  totalPredicted: number;
  totalMatched: number;
  /** Micro-averaged (sum matched / sum predicted across cases), not a mean of per-case ratios. */
  precision: number | null;
  /** Micro-averaged over known-bug cases (the only ones with expected findings). */
  recall: number | null;
  /** Fraction of matched pairs whose predicted range equals the expected range exactly. */
  lineAccuracy: number | null;
  /** Fraction of matched pairs whose predicted severity equals the expected severity. */
  severityAccuracy: number | null;
  totalCostUsd: number | null;
  avgDurationMs: number | null;
  byCategory: Record<EvalCaseCategory, { caseCount: number; predictedCount: number }>;
}

/**
 * What the eval runner needs from a model for one case: produce raw output
 * for a case's `PRFile[]`, and report how long it took (and, if available,
 * token usage) so cost/latency can be scored alongside quality.
 */
export interface EvalModelAdapter {
  review(evalCase: EvalCase): Promise<{ output: ModelReviewOutput; usage: EvalUsage }>;
}
