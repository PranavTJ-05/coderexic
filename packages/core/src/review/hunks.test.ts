import { describe, expect, it } from 'vitest';
import { firstAddedLine, hunkAt, isAddedLine, isCommentableLine, parseHunks } from './hunks.js';

const SIMPLE_PATCH = [
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' const d = 5;',
].join('\n');

describe('parseHunks', () => {
  it('maps added and context lines to new-file line numbers', () => {
    const [hunk] = parseHunks(SIMPLE_PATCH);
    expect(hunk).toMatchObject({ newStart: 1, newEnd: 4 });
    expect([...hunk!.addedLines]).toEqual([2, 3]);
  });

  it('handles multiple hunks in one patch', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      '-old top',
      '+new top',
      ' context',
      '@@ -10,2 +10,3 @@',
      ' context',
      '+added',
      ' more context',
    ].join('\n');
    const hunks = parseHunks(patch);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ newStart: 1, newEnd: 2 });
    expect(hunks[1]).toMatchObject({ newStart: 10, newEnd: 12 });
    expect([...hunks[1]!.addedLines]).toEqual([11]);
  });

  it('treats a hunk header without a count as covering exactly one line', () => {
    const [hunk] = parseHunks('@@ -5 +5 @@\n+only line');
    expect(hunk).toMatchObject({ newStart: 5, newEnd: 5 });
  });

  it('gives a pure-deletion hunk (new count 0) no addressable lines', () => {
    const hunks = parseHunks('@@ -1,2 +1,0 @@\n-gone\n-also gone');
    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.addedLines.size).toBe(0);
  });

  it('ignores the "no newline at end of file" marker', () => {
    const [hunk] = parseHunks('@@ -1,1 +1,1 @@\n-a\n+b\n\\ No newline at end of file');
    expect(hunk).toMatchObject({ newStart: 1, newEnd: 1 });
  });

  it('returns no hunks for a patch with no headers', () => {
    expect(parseHunks('')).toEqual([]);
  });
});

describe('line queries', () => {
  const hunks = parseHunks(SIMPLE_PATCH);

  it('finds the hunk containing a line, or none', () => {
    expect(hunkAt(hunks, 3)).toBeDefined();
    expect(hunkAt(hunks, 99)).toBeUndefined();
  });

  it('distinguishes commentable from added lines', () => {
    expect(isCommentableLine(hunks, 1)).toBe(true); // context
    expect(isAddedLine(hunks, 1)).toBe(false);
    expect(isCommentableLine(hunks, 2)).toBe(true);
    expect(isAddedLine(hunks, 2)).toBe(true);
    expect(isCommentableLine(hunks, 99)).toBe(false);
    expect(isAddedLine(hunks, 99)).toBe(false);
  });

  it('finds the first added line across hunks', () => {
    expect(firstAddedLine(hunks)).toBe(2);
    expect(firstAddedLine(parseHunks('@@ -1,1 +1,1 @@\n context only'))).toBeUndefined();
  });
});
