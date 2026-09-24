import { describe, expect, it } from 'vitest';
import type { ModelFinding } from '../llm/types.js';
import {
  buildCreateReviewInput,
  buildReview,
  dedupeFindings,
  filterIgnoredPaths,
  hasReviewMarker,
  placeFindings,
  reviewMarker,
} from './findings.js';

function finding(overrides: Partial<ModelFinding> & { filename?: string }): ModelFinding {
  return {
    filename: 'src/a.ts',
    severity: 'medium',
    start_line: 2,
    end_line: 2,
    issue: 'issue',
    fix_type: 'warning',
    suggested_code: null,
    ...overrides,
  };
}

// New-file lines: 1 context, 2 added, 3 added, 4 context.
const PATCH_A = '@@ -1,2 +1,4 @@\n context1\n+added2\n+added3\n context4';

describe('dedupeFindings', () => {
  it('keeps the higher-severity finding among overlapping ranges in the same file', () => {
    const low = finding({ severity: 'low', start_line: 2, end_line: 3, issue: 'weak' });
    const critical = finding({ severity: 'critical', start_line: 3, end_line: 3, issue: 'strong' });
    expect(dedupeFindings([low, critical])).toEqual([critical]);
  });

  it('keeps non-overlapping findings and findings in different files', () => {
    const a = finding({ start_line: 1, end_line: 1 });
    const b = finding({ start_line: 10, end_line: 10 });
    const c = finding({ filename: 'src/b.ts', start_line: 1, end_line: 1 });
    expect(dedupeFindings([a, b, c])).toEqual([a, b, c]);
  });

  it('keeps the first of two equal-severity overlapping findings', () => {
    const first = finding({ start_line: 1, end_line: 2, issue: 'first' });
    const second = finding({ start_line: 2, end_line: 3, issue: 'second' });
    expect(dedupeFindings([first, second])).toEqual([first]);
  });
});

describe('placeFindings', () => {
  const filesByPath = new Map([['src/a.ts', PATCH_A]]);

  it('places a finding on a commentable line inline', () => {
    const [result] = placeFindings([finding({ start_line: 2, end_line: 2 })], filesByPath);
    expect(result!.placement.kind).toBe('inline');
    if (result!.placement.kind === 'inline') {
      expect(result!.placement.comment).toMatchObject({ path: 'src/a.ts', line: 2 });
      expect(result!.placement.comment.startLine).toBeUndefined();
    }
  });

  it('sets startLine only for a genuine multi-line range', () => {
    const [result] = placeFindings([finding({ start_line: 2, end_line: 3 })], filesByPath);
    expect(result!.placement.kind).toBe('inline');
    if (result!.placement.kind === 'inline') expect(result!.placement.comment.startLine).toBe(2);
  });

  it('falls back to summary-only for an unreviewed file', () => {
    const findings = [finding({ filename: 'other.ts' })];
    const result = placeFindings(findings, filesByPath)[0];
    expect(result!.placement.kind).toBe('summary-only');
    if (result!.placement.kind === 'summary-only') {
      expect(result!.placement.reason).toContain('not part');
    }
  });

  it('falls back to summary-only for a line outside the diff', () => {
    const findings = [finding({ start_line: 99, end_line: 99 })];
    const result = placeFindings(findings, filesByPath)[0];
    expect(result!.placement.kind).toBe('summary-only');
    if (result!.placement.kind === 'summary-only') {
      expect(result!.placement.reason).toContain('outside');
    }
  });

  it('falls back to summary-only when start and end span different hunks', () => {
    const twoHunks = '@@ -1,1 +1,1 @@\n+added1\n@@ -10,1 +10,1 @@\n+added10';
    const findings = [finding({ start_line: 1, end_line: 10 })];
    const result = placeFindings(findings, new Map([['src/a.ts', twoHunks]]))[0];
    expect(result!.placement.kind).toBe('summary-only');
    if (result!.placement.kind === 'summary-only') {
      expect(result!.placement.reason).toContain('hunks');
    }
  });

  it('downgrades an applyable suggestion whose line was not added, but still posts it inline', () => {
    const [result] = placeFindings(
      [finding({ start_line: 1, end_line: 1, fix_type: 'applyable', suggested_code: 'x' })],
      filesByPath,
    );
    expect(result!.placement.kind).toBe('inline');
    if (result!.placement.kind === 'inline') {
      expect(result!.placement.comment.body).not.toContain('```suggestion');
      expect(result!.placement.comment.body).toContain('Suggested approach');
    }
  });

  it('uses a GitHub suggestion block for an applyable finding on an added line', () => {
    const [result] = placeFindings(
      [
        finding({
          start_line: 2,
          end_line: 2,
          fix_type: 'applyable',
          suggested_code: 'const x = 1;',
        }),
      ],
      filesByPath,
    );
    expect(result!.placement.kind).toBe('inline');
    if (result!.placement.kind === 'inline') {
      expect(result!.placement.comment.body).toContain('```suggestion\nconst x = 1;\n```');
    }
  });
});

describe('buildReview', () => {
  it('splits into comments and summary-only, and marks db rows published accordingly', () => {
    const processed = placeFindings(
      [finding({ start_line: 2, end_line: 2 }), finding({ filename: 'other.ts' })],
      new Map([['src/a.ts', PATCH_A]]),
    );
    const built = buildReview(processed);
    expect(built.comments).toHaveLength(1);
    expect(built.summaryOnly).toHaveLength(1);
    expect(built.dbFindings.map((f) => f.published)).toEqual([true, false]);
  });
});

describe('review marker', () => {
  it('round-trips through hasReviewMarker', () => {
    const body = `Summary text\n\n${reviewMarker('job-1')}`;
    expect(hasReviewMarker(body, 'job-1')).toBe(true);
    expect(hasReviewMarker(body, 'job-2')).toBe(false);
    expect(hasReviewMarker(null, 'job-1')).toBe(false);
    expect(hasReviewMarker(undefined, 'job-1')).toBe(false);
  });
});

describe('buildCreateReviewInput', () => {
  it('embeds the summary, additional findings and the completion marker in the review body', () => {
    const processed = placeFindings(
      [finding({ filename: 'other.ts', issue: 'stray issue' })],
      new Map(),
    );
    const built = buildReview(processed);
    const input = buildCreateReviewInput('job-42', 7, 'a'.repeat(40), 'Looks mostly fine.', built);
    expect(input).toMatchObject({ pullNumber: 7, commitSha: 'a'.repeat(40), comments: [] });
    expect(input.body).toContain('Looks mostly fine.');
    expect(input.body).toContain('stray issue');
    expect(input.body).toContain(reviewMarker('job-42'));
  });
});

describe('filterIgnoredPaths', () => {
  it('returns findings unchanged when there are no ignore globs', () => {
    const findings = [finding({ filename: 'src/a.ts' })];
    expect(filterIgnoredPaths(findings, [])).toEqual(findings);
  });

  it('drops findings on a path matching an ignore glob', () => {
    const kept = finding({ filename: 'src/keep.ts' });
    const dropped = finding({ filename: 'dist/bundle.js' });
    expect(filterIgnoredPaths([kept, dropped], ['dist/**'])).toEqual([kept]);
  });

  it('matches against any of several ignore globs', () => {
    const dropped = finding({ filename: 'src/a.test.ts' });
    expect(filterIgnoredPaths([dropped], ['dist/**', '*.test.ts'])).toEqual([]);
  });
});
