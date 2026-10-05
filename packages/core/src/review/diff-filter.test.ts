import { describe, expect, it } from 'vitest';
import type { PRFile } from '../github/types.js';
import { DEFAULT_DIFF_BUDGET, matchesGlob, selectReviewableFiles } from './diff-filter.js';

function file(overrides: Partial<PRFile> & { filename: string }): PRFile {
  return {
    previousFilename: null,
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: '@@ -1 +1 @@\n-a\n+b',
    ...overrides,
  };
}

describe('matchesGlob', () => {
  it.each([
    ['dist/**', 'dist/index.js', true],
    ['dist/**', 'src/dist/index.js', false],
    ['**/dist/**', 'src/dist/index.js', true],
    ['*.min.js', 'app.min.js', true],
    ['*.min.js', 'src/app.min.js', true],
    ['*.test.ts', 'src/deep/a.test.ts', true],
  ])('%s against %s -> %s', (pattern, filename, expected) => {
    expect(matchesGlob(filename, pattern)).toBe(expected);
  });

  // Phase 16 resource-exhaustion audit: a confirmed finding, not a
  // hypothetical one. `node:path`'s built-in `matchesGlob` has catastrophic
  // backtracking when a pattern mixes `*` with even a single `!` against a
  // long-enough filename - directly reproduced with `timeout node -e`
  // outside the test runner (a vitest timeout cannot interrupt a
  // synchronous hang; see docs/security-audit.md for the raw numbers).
  // `.coderexic.yml`'s `ignore` field is untrusted repo input, and the
  // filename side comes from a PR's own changed files (attacker-controlled
  // on a fork PR), so both sides of this call can be adversarial.
  it('resolves a pathological glob/filename pair quickly instead of hanging (confirmed ReDoS, now fixed)', () => {
    const pathological = '*'.repeat(10) + '!';
    const longFilename = 'a'.repeat(4000) + '.ts';
    const start = performance.now();
    const result = matchesGlob(longFilename, pathological);
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(500);
    expect(result).toBe(false);
  });

  it('resolves a deeply nested ** pattern against a long path quickly', () => {
    const pattern = Array.from({ length: 30 }, () => '**').join('/') + '/target.ts';
    const longPath = Array.from({ length: 2000 }, (_, i) => `seg${i}`).join('/') + '/other.ts';
    const start = performance.now();
    matchesGlob(longPath, pattern);
    const elapsedMs = performance.now() - start;
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('never matches a pattern containing ! (not a supported feature, and the ReDoS trigger)', () => {
    expect(matchesGlob('src/a.ts', '*!*')).toBe(false);
    expect(matchesGlob('anything', '!')).toBe(false);
  });

  it('rejects an oversized pattern or filename without matching', () => {
    expect(matchesGlob('a'.repeat(5000) + '.ts', '*.ts')).toBe(false);
    expect(matchesGlob('a.ts', '*'.repeat(5000) + '.ts')).toBe(false);
  });
});

describe('selectReviewableFiles', () => {
  it('excludes removed files, files with no patch, lockfiles and binary types', () => {
    const files = [
      file({ filename: 'src/a.ts' }),
      file({ filename: 'old.ts', status: 'removed', patch: null }),
      file({ filename: 'huge.bin', patch: null }),
      file({ filename: 'package-lock.json' }),
      file({ filename: 'logo.png' }),
    ];
    const { files: selected, skipped } = selectReviewableFiles(files);
    expect(selected.map((f) => f.filename)).toEqual(['src/a.ts']);
    expect(skipped).toHaveLength(4);
  });

  it('applies caller-provided ignore globs', () => {
    const files = [file({ filename: 'src/a.ts' }), file({ filename: 'dist/a.js' })];
    const { files: selected } = selectReviewableFiles(files, { ignoreGlobs: ['dist/**'] });
    expect(selected.map((f) => f.filename)).toEqual(['src/a.ts']);
  });

  it('drops a single file whose patch exceeds the per-file byte limit', () => {
    const files = [file({ filename: 'big.ts', patch: 'x'.repeat(100) })];
    const { files: selected, skipped } = selectReviewableFiles(files, {
      budget: { ...DEFAULT_DIFF_BUDGET, maxFileBytes: 50 },
    });
    expect(selected).toEqual([]);
    expect(skipped[0]).toMatchObject({ filename: 'big.ts' });
  });

  it('keeps the largest files within the total byte budget and drops the rest', () => {
    const files = [
      file({ filename: 'small.ts', patch: 'x'.repeat(10) }),
      file({ filename: 'medium.ts', patch: 'x'.repeat(30) }),
      file({ filename: 'large.ts', patch: 'x'.repeat(50) }),
    ];
    const { files: selected } = selectReviewableFiles(files, {
      budget: { maxTotalBytes: 40, maxFiles: 10, maxFileBytes: 1000 },
    });
    // Order is restored to the PR's original order after selection.
    expect(selected.map((f) => f.filename)).toEqual(['small.ts', 'medium.ts']);
  });

  it('caps the number of selected files', () => {
    const files = Array.from({ length: 5 }, (_, i) => file({ filename: `f${i}.ts` }));
    const { files: selected, skipped } = selectReviewableFiles(files, {
      budget: { ...DEFAULT_DIFF_BUDGET, maxFiles: 2 },
    });
    expect(selected).toHaveLength(2);
    expect(skipped).toHaveLength(3);
  });

  // Phase 16 resource-exhaustion audit: GitHub itself caps listFiles at
  // 3000 entries, but nothing stops a fork PR from hitting that cap, and
  // this runs on every push with no size-based early exit. Proves the
  // default budget handles that volume quickly and the output stays small
  // regardless of how many files came in.
  it('handles a 3000-file PR (GitHub\'s own listFiles cap) quickly under the default budget', () => {
    const files = Array.from({ length: 3000 }, (_, i) =>
      file({ filename: `src/f${i}.ts`, patch: '@@ -1 +1 @@\n-a\n+b'.repeat(20) }),
    );
    const start = performance.now();
    const { files: selected, skipped } = selectReviewableFiles(files);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(500);
    expect(selected.length).toBeLessThanOrEqual(DEFAULT_DIFF_BUDGET.maxFiles);
    expect(selected.length + skipped.length).toBe(3000);
  });
});
