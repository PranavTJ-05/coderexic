import type { PRFile } from '../../github/types.js';

/**
 * Builds a single-hunk unified diff patch with a correct `@@ -a,b +c,d @@`
 * header, so fixture patches are never hand-counted (a wrong header count
 * doesn't break `parseHunks`, which recomputes line numbers from the body
 * regardless - but a wrong count would still make a fixture unrealistic and
 * confusing to read).
 *
 * `lines` are prefixed the way a unified diff body is: `' '` for context,
 * `'+'` for added, `'-'` for removed. `oldStart`/`newStart` are the first
 * line number on each side.
 */
export function patch(oldStart: number, newStart: number, lines: readonly string[]): string {
  const oldCount = lines.filter((l) => !l.startsWith('+')).length;
  const newCount = lines.filter((l) => !l.startsWith('-')).length;
  const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
  return [header, ...lines].join('\n');
}

/** A `PRFile` for a fixture case: always `modified` with real additions/deletions. */
export function modifiedFile(
  filename: string,
  oldStart: number,
  newStart: number,
  lines: readonly string[],
): PRFile {
  const additions = lines.filter((l) => l.startsWith('+')).length;
  const deletions = lines.filter((l) => l.startsWith('-')).length;
  return {
    filename,
    previousFilename: null,
    status: 'modified',
    additions,
    deletions,
    patch: patch(oldStart, newStart, lines),
  };
}
