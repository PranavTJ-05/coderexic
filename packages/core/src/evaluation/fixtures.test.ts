import { describe, expect, it } from 'vitest';
import type { ModelFinding } from '../llm/types.js';
import {
  DEFAULT_DIFF_BUDGET,
  firstAddedLine,
  hunkAt,
  isAddedLine,
  parseHunks,
  selectReviewableFiles,
} from '../review/index.js';
import { ALL_EVAL_CASES, FALSE_POSITIVE_CASES, KNOWN_BUG_CASES } from './fixtures/index.js';
import { aggregateReport, scoreCase } from './scoring.js';

describe('eval fixtures', () => {
  it('has at least 25 cases, with both categories represented', () => {
    expect(ALL_EVAL_CASES.length).toBeGreaterThanOrEqual(25);
    expect(KNOWN_BUG_CASES.length).toBeGreaterThan(0);
    expect(FALSE_POSITIVE_CASES.length).toBeGreaterThan(0);
  });

  it('has unique case ids', () => {
    const ids = ALL_EVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every false-positive case has no expected findings, and every known-bug case has at least one', () => {
    for (const c of FALSE_POSITIVE_CASES) expect(c.expectedFindings).toHaveLength(0);
    for (const c of KNOWN_BUG_CASES) expect(c.expectedFindings.length).toBeGreaterThan(0);
  });

  it('every case file survives selectReviewableFiles with the production default budget', () => {
    for (const evalCase of ALL_EVAL_CASES) {
      const selection = selectReviewableFiles(evalCase.files, { budget: DEFAULT_DIFF_BUDGET });
      expect(
        selection.skipped,
        `${evalCase.id}: expected no files skipped, got ${JSON.stringify(selection.skipped)}`,
      ).toHaveLength(0);
      expect(selection.files).toHaveLength(evalCase.files.length);
    }
  });

  it('every expected finding lands entirely on added lines within one hunk (so placeFindings can place it inline)', () => {
    for (const evalCase of ALL_EVAL_CASES) {
      const hunksByFile = new Map(
        evalCase.files.map((f) => [f.filename, parseHunks(f.patch ?? '')]),
      );
      for (const finding of evalCase.expectedFindings) {
        const hunks = hunksByFile.get(finding.filename);
        expect(hunks, `${evalCase.id}: no file "${finding.filename}" in this case`).toBeDefined();
        if (!hunks) continue;

        const startHunk = hunkAt(hunks, finding.startLine);
        const endHunk = hunkAt(hunks, finding.endLine);
        expect(
          startHunk,
          `${evalCase.id}: start line ${finding.startLine} is outside every hunk`,
        ).toBeDefined();
        expect(startHunk).toBe(endHunk);

        for (let line = finding.startLine; line <= finding.endLine; line++) {
          expect(
            isAddedLine(hunks, line),
            `${evalCase.id}: line ${line} of "${finding.filename}" is not an added ("+") line`,
          ).toBe(true);
        }
      }
    }
  });

  it('no two expected findings in the same case and file overlap (dedupeFindings would drop one)', () => {
    for (const evalCase of ALL_EVAL_CASES) {
      const byFile = new Map<string, typeof evalCase.expectedFindings>();
      for (const f of evalCase.expectedFindings) {
        byFile.set(f.filename, [...(byFile.get(f.filename) ?? []), f]);
      }
      for (const [filename, findings] of byFile) {
        for (let i = 0; i < findings.length; i++) {
          for (let j = i + 1; j < findings.length; j++) {
            const a = findings[i];
            const b = findings[j];
            if (!a || !b) continue;
            const overlaps = a.startLine <= b.endLine && b.startLine <= a.endLine;
            expect(
              overlaps,
              `${evalCase.id}: expected findings on "${filename}" overlap (${a.startLine}-${a.endLine} vs ${b.startLine}-${b.endLine})`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it('an oracle model that reports exactly the expected findings scores precision=recall=1 on every known-bug case', () => {
    for (const evalCase of KNOWN_BUG_CASES) {
      const oracleFindings: ModelFinding[] = evalCase.expectedFindings.map((f) => ({
        filename: f.filename,
        severity: f.severity,
        start_line: f.startLine,
        end_line: f.endLine,
        issue: f.description,
        fix_type: 'warning',
        suggested_code: null,
      }));
      const score = scoreCase(
        evalCase,
        { summary: 'oracle', reviews: oracleFindings },
        { durationMs: 0 },
      );
      expect(score.precision, `${evalCase.id}: precision`).toBe(1);
      expect(score.recall, `${evalCase.id}: recall`).toBe(1);
      expect(score.matchedCount).toBe(evalCase.expectedFindings.length);
    }
  });

  it('a model that reports nothing scores recall=0 on every known-bug case and precision=null (no predictions)', () => {
    for (const evalCase of KNOWN_BUG_CASES) {
      const score = scoreCase(evalCase, { summary: 'empty', reviews: [] }, { durationMs: 0 });
      expect(score.recall).toBe(0);
      expect(score.precision).toBeNull();
    }
  });

  it('an oracle model reports no findings on false-positive cases and gets precision=null, recall=null', () => {
    for (const evalCase of FALSE_POSITIVE_CASES) {
      const score = scoreCase(evalCase, { summary: 'oracle', reviews: [] }, { durationMs: 0 });
      expect(score.precision).toBeNull();
      expect(score.recall).toBeNull();
      expect(score.predictedCount).toBe(0);
    }
  });

  it('matching is keyed by filename: a right-line-wrong-file prediction does not match', () => {
    const decoyCase = KNOWN_BUG_CASES.find((c) => c.id === 'decoy-clean-second-file');
    expect(decoyCase).toBeDefined();
    if (!decoyCase) return;
    const realFinding = decoyCase.expectedFindings[0];
    expect(realFinding).toBeDefined();
    if (!realFinding) return;

    // Same line range, same severity, but reported against the *other* (clean) file.
    const wrongFileGuess: ModelFinding = {
      filename: 'src/tmp/cleanup.ts',
      severity: realFinding.severity,
      start_line: realFinding.startLine,
      end_line: realFinding.endLine,
      issue: 'wrong file',
      fix_type: 'warning',
      suggested_code: null,
    };
    const score = scoreCase(
      decoyCase,
      { summary: 'wrong file', reviews: [wrongFileGuess] },
      { durationMs: 0 },
    );
    expect(score.matchedCount).toBe(0);
    expect(score.recall).toBe(0);
  });

  /**
   * The fixture suite must reward a model that actually finds bugs, not one
   * that always guesses "the first added line of the first changed file" -
   * a strategy that needs zero understanding of what the diff does. If it
   * scored well here, precision/recall on this suite would measure "did
   * the model point at new code" rather than review quality - the
   * fixtures, not the scorer, would be broken. Every known-bug case has a
   * few leading no-op added lines before the actual bug precisely so this
   * guesser misses it (`LINE_MATCH_TOLERANCE` isn't enough to bridge the
   * gap), and multi-file cases put the bug on a file the guesser doesn't
   * even look at often enough to matter.
   */
  it('a first-added-line guesser scores far below a perfect model', () => {
    const scores = ALL_EVAL_CASES.map((evalCase) => {
      const reviews: ModelFinding[] = [];
      const firstFile = evalCase.files[0];
      const guessLine = firstFile ? firstAddedLine(parseHunks(firstFile.patch ?? '')) : undefined;
      if (firstFile && guessLine !== undefined) {
        reviews.push({
          filename: firstFile.filename,
          severity: 'medium',
          start_line: guessLine,
          end_line: guessLine,
          issue: 'something looks off here',
          fix_type: 'warning',
          suggested_code: null,
        });
      }
      return scoreCase(evalCase, { summary: 'guess', reviews }, { durationMs: 0 });
    });

    const report = aggregateReport(scores);
    expect(report.recall, 'guesser recall').not.toBeNull();
    expect(report.precision, 'guesser precision').not.toBeNull();
    if (report.recall !== null) expect(report.recall).toBeLessThan(0.3);
    if (report.precision !== null) expect(report.precision).toBeLessThan(0.3);
  });

  /**
   * A prediction spanning an entire hunk necessarily overlaps any expected
   * sub-range inside it, so precision/recall alone can't penalize a model
   * that reports one giant vague range per file instead of pinpointing the
   * bug. `lineAccuracy` (exact-range match over matched pairs only) is the
   * metric that catches this - documented here so the gap in
   * precision/recall is a known, deliberate limitation, not an oversight.
   */
  it('a whole-hunk-span guesser gets full recall but ~zero line accuracy', () => {
    const scores = KNOWN_BUG_CASES.map((evalCase) => {
      const reviews: ModelFinding[] = evalCase.files.flatMap((file) => {
        const hunks = parseHunks(file.patch ?? '');
        if (hunks.length === 0) return [];
        const first = hunks[0];
        const last = hunks[hunks.length - 1];
        if (!first || !last) return [];
        return [
          {
            filename: file.filename,
            severity: 'medium' as const,
            start_line: first.newStart,
            end_line: last.newEnd,
            issue: 'something in this hunk looks off',
            fix_type: 'warning' as const,
            suggested_code: null,
          },
        ];
      });
      return scoreCase(evalCase, { summary: 'guess', reviews }, { durationMs: 0 });
    });

    const report = aggregateReport(scores);
    expect(report.recall).toBe(1);
    expect(report.lineAccuracy, 'line accuracy').not.toBeNull();
    if (report.lineAccuracy !== null) expect(report.lineAccuracy).toBeLessThan(0.1);
  });
});
