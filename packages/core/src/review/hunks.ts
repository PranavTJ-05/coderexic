/**
 * Parses a unified diff patch (as GitHub returns in PRFile.patch) into the
 * new-file ("+") line numbers a review comment can legally anchor to:
 * GitHub's createReview API accepts comments only on lines inside a diff
 * hunk. AI_AGENT_SPEC.md §11 additionally restricts "applyable" suggestions
 * to added lines.
 */

export interface Hunk {
  /** First new-file line number covered by this hunk. */
  newStart: number;
  /** Last new-file line number covered by this hunk. */
  newEnd: number;
  /** New-file line numbers of "+" (added) lines within this hunk. */
  addedLines: ReadonlySet<number>;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: { start: number; line: number; added: Set<number> } | undefined;

  for (const row of patch.split('\n')) {
    const header = HUNK_HEADER.exec(row);
    if (header) {
      if (current) hunks.push(toHunk(current));
      const start = Number(header[1]);
      const count = header[2] === undefined ? 1 : Number(header[2]);
      current = { start, line: start, added: new Set() };
      // A zero-length hunk (a pure deletion) has no addressable new-file lines.
      if (count === 0) {
        hunks.push({ newStart: start, newEnd: start, addedLines: new Set() });
        current = undefined;
      }
      continue;
    }
    if (!current) continue;
    if (row.startsWith('+')) {
      current.added.add(current.line);
      current.line += 1;
    } else if (row.startsWith('-')) {
      // Removed lines consume no new-file line number.
    } else if (row.startsWith('\\')) {
      // "\ No newline at end of file": not a content line.
    } else {
      current.line += 1;
    }
  }
  if (current) hunks.push(toHunk(current));
  return hunks;
}

function toHunk(state: { start: number; line: number; added: Set<number> }): Hunk {
  return {
    newStart: state.start,
    newEnd: Math.max(state.start, state.line - 1),
    addedLines: state.added,
  };
}

/** The hunk containing new-file line `line`, if any. */
export function hunkAt(hunks: readonly Hunk[], line: number): Hunk | undefined {
  return hunks.find((hunk) => line >= hunk.newStart && line <= hunk.newEnd);
}

/** True if `line` is inside some hunk (addressable), added or context. */
export function isCommentableLine(hunks: readonly Hunk[], line: number): boolean {
  return hunkAt(hunks, line) !== undefined;
}

/** True if `line` was added ("+") in some hunk. */
export function isAddedLine(hunks: readonly Hunk[], line: number): boolean {
  const hunk = hunkAt(hunks, line);
  return hunk !== undefined && hunk.addedLines.has(line);
}

/** The first added line's new-file number, if the patch adds any lines. */
export function firstAddedLine(hunks: readonly Hunk[]): number | undefined {
  for (const hunk of hunks) {
    for (const line of hunk.addedLines) return line;
  }
  return undefined;
}
