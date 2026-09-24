import { describe, expect, it } from 'vitest';
import { isTestFile, rankRelatedFiles } from './rank.js';

describe('isTestFile', () => {
  it('matches common test-file conventions across languages', () => {
    expect(isTestFile('src/foo.test.ts')).toBe(true);
    expect(isTestFile('src/foo.spec.ts')).toBe(true);
    expect(isTestFile('src/foo_test.go')).toBe(true);
    expect(isTestFile('src/foo_spec.rb')).toBe(true);
    expect(isTestFile('tests/test_foo.py')).toBe(true);
    expect(isTestFile('__tests__/foo.ts')).toBe(true);
    expect(isTestFile('tests/foo.ts')).toBe(true);
  });

  it('does not match a plain source file', () => {
    expect(isTestFile('src/foo.ts')).toBe(false);
    expect(isTestFile('src/testament.ts')).toBe(false);
  });
});

describe('rankRelatedFiles', () => {
  it('sorts by tier priority, then path', () => {
    const ranked = rankRelatedFiles([
      { path: 'b.ts', tier: 'second_degree' },
      { path: 'a.ts', tier: 'direct_import' },
      { path: 'c.ts', tier: 'direct_dependent' },
      { path: 'd.test.ts', tier: 'related_test' },
    ]);
    expect(ranked.map((f) => f.path)).toEqual(['a.ts', 'c.ts', 'd.test.ts', 'b.ts']);
  });

  it('keeps only the highest-priority tier for a path classified more than once', () => {
    const ranked = rankRelatedFiles([
      { path: 'a.ts', tier: 'second_degree' },
      { path: 'a.ts', tier: 'direct_import' },
    ]);
    expect(ranked).toEqual([{ path: 'a.ts', tier: 'direct_import' }]);
  });

  it('breaks ties within a tier alphabetically', () => {
    const ranked = rankRelatedFiles([
      { path: 'z.ts', tier: 'direct_import' },
      { path: 'a.ts', tier: 'direct_import' },
    ]);
    expect(ranked.map((f) => f.path)).toEqual(['a.ts', 'z.ts']);
  });
});
