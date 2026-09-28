import type { Severity } from '../db/schema.js';
import type { ModelFinding, ModelReviewOutput } from '../llm/types.js';
import {
  DEFAULT_DIFF_BUDGET,
  dedupeFindings,
  filterBySeverity,
  filterIgnoredPaths,
  placeFindings,
  selectReviewableFiles,
  type DiffBudget,
} from '../review/index.js';
import type {
  CaseScore,
  EvalCase,
  EvalExpectedFinding,
  EvalReport,
  EvalUsage,
  MatchedPair,
  PriceTable,
} from './types.js';

/**
 * How far apart a predicted range may sit from an expected one and still
 * count as the same finding (ROADMAP.md Phase 15's line accuracy metric
 * needs *some* tolerance - a reviewer that flags line 42 instead of 41 for
 * the same bug is not "wrong", it just anchored one line off).
 */
export const LINE_MATCH_TOLERANCE = 2;

/**
 * Runs a case's model output through exactly the post-processing steps
 * production uses (`apps/worker/src/review/pipeline.ts`'s
 * `publishAndComplete`: filterIgnoredPaths -> filterBySeverity ->
 * dedupeFindings -> placeFindings), after first narrowing the case's files
 * through `selectReviewableFiles` the same way the pipeline does before the
 * model ever sees them. Scoring anything else would measure a pipeline
 * users never actually get.
 */
export function runProductionPipeline(
  evalCase: EvalCase,
  output: ModelReviewOutput,
  options: {
    ignoreGlobs?: readonly string[];
    minimumSeverity?: Severity;
    budget?: DiffBudget;
  } = {},
): { predicted: ModelFinding[]; inlineCount: number; summaryOnlyCount: number } {
  const ignoreGlobs = options.ignoreGlobs ?? [];
  const minimumSeverity = options.minimumSeverity ?? 'low';
  const budget = options.budget ?? DEFAULT_DIFF_BUDGET;

  const selection = selectReviewableFiles(evalCase.files, { ignoreGlobs, budget });
  const ignoreFiltered = filterIgnoredPaths(output.reviews, ignoreGlobs);
  const deduped = dedupeFindings(filterBySeverity(ignoreFiltered, minimumSeverity));
  const filesByPath = new Map(selection.files.map((file) => [file.filename, file.patch]));
  const processed = placeFindings(deduped, filesByPath);

  const inlineCount = processed.filter((p) => p.placement.kind === 'inline').length;
  const summaryOnlyCount = processed.length - inlineCount;
  return { predicted: processed.map((p) => p.finding), inlineCount, summaryOnlyCount };
}

function rangesOverlapWithTolerance(
  expected: EvalExpectedFinding,
  predicted: ModelFinding,
  tolerance: number,
): boolean {
  const lo = expected.startLine - tolerance;
  const hi = expected.endLine + tolerance;
  return predicted.start_line <= hi && lo <= predicted.end_line;
}

/**
 * One-to-one greedy match between a case's expected findings and its
 * predictions: same file, overlapping range within `LINE_MATCH_TOLERANCE`.
 * A predicted finding matches at most one expected finding, so a single
 * lucky prediction can't inflate recall by covering two expected bugs.
 */
export function matchFindings(
  expected: readonly EvalExpectedFinding[],
  predicted: readonly ModelFinding[],
  tolerance = LINE_MATCH_TOLERANCE,
): MatchedPair[] {
  const usedPredicted = new Set<number>();
  const matches: MatchedPair[] = [];

  for (const exp of expected) {
    let bestIndex = -1;
    let bestOverlap = -Infinity;
    for (let i = 0; i < predicted.length; i++) {
      if (usedPredicted.has(i)) continue;
      const pred = predicted[i];
      if (!pred || pred.filename !== exp.filename) continue;
      if (!rangesOverlapWithTolerance(exp, pred, tolerance)) continue;
      const overlap =
        Math.min(exp.endLine, pred.end_line) - Math.max(exp.startLine, pred.start_line);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIndex = i;
      }
    }
    if (bestIndex === -1) continue;
    usedPredicted.add(bestIndex);
    const pred = predicted[bestIndex];
    if (!pred) continue;
    matches.push({
      expected: exp,
      predictedFilename: pred.filename,
      predictedSeverity: pred.severity,
      predictedStartLine: pred.start_line,
      predictedEndLine: pred.end_line,
      exactLineMatch: pred.start_line === exp.startLine && pred.end_line === exp.endLine,
      severityMatch: pred.severity === exp.severity,
    });
  }
  return matches;
}

function priceKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

/** `null` (never a guessed number) when usage or a matching price-table entry is unavailable. */
export function computeCostUsd(
  usage: EvalUsage,
  provider: string,
  model: string,
  prices?: PriceTable,
): number | null {
  if (!prices) return null;
  const entry = prices[priceKey(provider, model)];
  if (!entry) return null;
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) return null;
  return (
    (usage.inputTokens / 1_000_000) * entry.inputPerMillionTokens +
    (usage.outputTokens / 1_000_000) * entry.outputPerMillionTokens
  );
}

export function scoreCase(
  evalCase: EvalCase,
  output: ModelReviewOutput,
  usage: EvalUsage,
  options: {
    ignoreGlobs?: readonly string[];
    minimumSeverity?: Severity;
    budget?: DiffBudget;
    tolerance?: number;
    provider?: string;
    model?: string;
    prices?: PriceTable;
  } = {},
): CaseScore {
  const { predicted, inlineCount, summaryOnlyCount } = runProductionPipeline(
    evalCase,
    output,
    options,
  );
  const matches = matchFindings(evalCase.expectedFindings, predicted, options.tolerance);
  const expectedCount = evalCase.expectedFindings.length;
  const predictedCount = predicted.length;

  const costUsd =
    options.provider && options.model
      ? computeCostUsd(usage, options.provider, options.model, options.prices)
      : null;

  return {
    id: evalCase.id,
    title: evalCase.title,
    category: evalCase.category,
    expectedCount,
    predictedCount,
    inlineCount,
    summaryOnlyCount,
    matchedCount: matches.length,
    precision: predictedCount === 0 ? null : matches.length / predictedCount,
    recall: expectedCount === 0 ? null : matches.length / expectedCount,
    matches,
    ...(usage.inputTokens !== undefined && { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens !== undefined && { outputTokens: usage.outputTokens }),
    durationMs: usage.durationMs,
    costUsd,
  };
}

/**
 * Aggregates case scores by micro-averaging (sum matched / sum predicted
 * across every case) rather than meaning per-case ratios, so a false-
 * positive-trap case (0 expected findings, `recall: null` on its own row)
 * still pulls the overall precision down when the model hallucinates on it,
 * and a known-bug case with many findings isn't drowned out by ten trivial
 * cases with one finding each.
 */
export function aggregateReport(cases: readonly CaseScore[]): EvalReport {
  const totalExpected = cases.reduce((sum, c) => sum + c.expectedCount, 0);
  const totalPredicted = cases.reduce((sum, c) => sum + c.predictedCount, 0);
  const totalMatched = cases.reduce((sum, c) => sum + c.matchedCount, 0);
  const allMatches = cases.flatMap((c) => c.matches);

  const exactMatches = allMatches.filter((m) => m.exactLineMatch).length;
  const severityMatches = allMatches.filter((m) => m.severityMatch).length;

  const costs = cases.map((c) => c.costUsd).filter((c): c is number => c !== null);
  const durations = cases.map((c) => c.durationMs);

  const byCategory: EvalReport['byCategory'] = {
    'known-bug': { caseCount: 0, predictedCount: 0 },
    'false-positive': { caseCount: 0, predictedCount: 0 },
  };
  for (const c of cases) {
    byCategory[c.category].caseCount += 1;
    byCategory[c.category].predictedCount += c.predictedCount;
  }

  return {
    cases,
    caseCount: cases.length,
    totalExpected,
    totalPredicted,
    totalMatched,
    precision: totalPredicted === 0 ? null : totalMatched / totalPredicted,
    recall: totalExpected === 0 ? null : totalMatched / totalExpected,
    lineAccuracy: allMatches.length === 0 ? null : exactMatches / allMatches.length,
    severityAccuracy: allMatches.length === 0 ? null : severityMatches / allMatches.length,
    totalCostUsd: costs.length === 0 ? null : costs.reduce((a, b) => a + b, 0),
    avgDurationMs:
      durations.length === 0 ? null : durations.reduce((a, b) => a + b, 0) / durations.length,
    byCategory,
  };
}

/**
 * Runs every case through `adapter` and scores the results. Pure
 * orchestration over `scoreCase`/`aggregateReport`; the CLI wrapper
 * (`apps/worker/src/scripts/eval-run.ts`) only adds argument parsing and
 * printing on top of this.
 */
export async function runEvaluation(
  cases: readonly EvalCase[],
  adapter: { review(evalCase: EvalCase): Promise<{ output: ModelReviewOutput; usage: EvalUsage }> },
  options: {
    ignoreGlobs?: readonly string[];
    minimumSeverity?: Severity;
    budget?: DiffBudget;
    tolerance?: number;
    provider?: string;
    model?: string;
    prices?: PriceTable;
  } = {},
): Promise<EvalReport> {
  const scored: CaseScore[] = [];
  for (const evalCase of cases) {
    const { output, usage } = await adapter.review(evalCase);
    scored.push(scoreCase(evalCase, output, usage, options));
  }
  return aggregateReport(scored);
}
