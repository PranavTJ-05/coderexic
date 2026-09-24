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
});
