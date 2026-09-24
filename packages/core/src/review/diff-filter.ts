import { matchesGlob as nodeMatchesGlob } from 'node:path';
import type { PRFile } from '../github/types.js';

/** Common generated/vendored files that are noisy or meaningless to review. */
const DEFAULT_EXCLUDED_NAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'npm-shrinkwrap.json',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'composer.lock',
  'go.sum',
]);

const DEFAULT_EXCLUDED_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.svg',
  '.webp',
  '.bmp',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.jar',
  '.wasm',
  '.min.js',
  '.min.css',
]);

export interface DiffBudget {
  /** Total bytes of patch text sent to the model. */
  maxTotalBytes: number;
  /** Files considered after this many are dropped, largest patches first. */
  maxFiles: number;
  /** A single file's patch above this size is dropped, not truncated. */
  maxFileBytes: number;
}

export const DEFAULT_DIFF_BUDGET: DiffBudget = {
  maxTotalBytes: 60_000,
  maxFiles: 40,
  maxFileBytes: 20_000,
};

export interface ReviewableFile {
  filename: string;
  status: PRFile['status'];
  patch: string;
}

export interface DiffSelection {
  files: ReviewableFile[];
  /** Files with real changes that were left out for budget or exclusion reasons. */
  skipped: { filename: string; reason: string }[];
}

function extensionOf(filename: string): string {
  const lower = filename.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot === -1 ? '' : lower.slice(dot);
}

function isExcludedByDefault(filename: string, ignoreGlobs: readonly string[]): string | undefined {
  const base = filename.slice(filename.lastIndexOf('/') + 1);
  if (DEFAULT_EXCLUDED_NAMES.has(base)) return 'lockfile';
  if (DEFAULT_EXCLUDED_EXTENSIONS.has(extensionOf(base))) return 'binary or generated file type';
  for (const glob of ignoreGlobs) {
    if (matchesGlob(filename, glob)) return `matched ignore pattern "${glob}"`;
  }
  return undefined;
}

/**
 * Matches PRODUCT_SPEC.md §11's `ignore` patterns. `path.matchesGlob` treats
 * a pattern without `**` as matching only one path segment, so a bare
 * `dist` or `*.min.js` would not reach nested files the way repository
 * owners expect; a leading/trailing `**` makes those patterns work like
 * common .gitignore-style globs.
 */
export function matchesGlob(filename: string, pattern: string): boolean {
  const expanded = pattern.includes('/') || pattern.startsWith('**') ? pattern : `**/${pattern}`;
  return nodeMatchesGlob(filename, expanded) || nodeMatchesGlob(filename, `${expanded}/**`);
}

/**
 * Picks which changed files go to the model, applying PRODUCT_SPEC.md §16's
 * per-review limits so a large PR never blows the context or token budget.
 * Files are dropped (not truncated) once the budget runs out, largest
 * patches first, so the model never sees a file cut off mid-hunk.
 */
export function selectReviewableFiles(
  files: readonly PRFile[],
  options: { ignoreGlobs?: readonly string[]; budget?: DiffBudget } = {},
): DiffSelection {
  const budget = options.budget ?? DEFAULT_DIFF_BUDGET;
  const ignoreGlobs = options.ignoreGlobs ?? [];
  const skipped: DiffSelection['skipped'] = [];
  const candidates: ReviewableFile[] = [];

  for (const file of files) {
    if (file.status === 'removed') {
      skipped.push({ filename: file.filename, reason: 'file removed' });
      continue;
    }
    if (!file.patch) {
      skipped.push({
        filename: file.filename,
        reason: 'no patch (binary or too large for GitHub to diff)',
      });
      continue;
    }
    const excludeReason = isExcludedByDefault(file.filename, ignoreGlobs);
    if (excludeReason) {
      skipped.push({ filename: file.filename, reason: excludeReason });
      continue;
    }
    if (Buffer.byteLength(file.patch, 'utf8') > budget.maxFileBytes) {
      skipped.push({ filename: file.filename, reason: 'patch exceeds the per-file size limit' });
      continue;
    }
    candidates.push({ filename: file.filename, status: file.status, patch: file.patch });
  }

  candidates.sort(
    (a, b) => Buffer.byteLength(b.patch, 'utf8') - Buffer.byteLength(a.patch, 'utf8'),
  );
  const selected: ReviewableFile[] = [];
  let totalBytes = 0;
  for (const file of candidates) {
    const size = Buffer.byteLength(file.patch, 'utf8');
    const overFileLimit = selected.length >= budget.maxFiles;
    const overByteLimit = totalBytes + size > budget.maxTotalBytes;
    if (overFileLimit || overByteLimit) {
      skipped.push({
        filename: file.filename,
        reason: overFileLimit
          ? 'exceeds the per-review file count limit'
          : 'exceeds the per-review byte budget',
      });
      continue;
    }
    selected.push(file);
    totalBytes += size;
  }
  // Restore the PR's original file order for the model's prompt.
  const order = new Map(files.map((f, i) => [f.filename, i]));
  selected.sort((a, b) => (order.get(a.filename) ?? 0) - (order.get(b.filename) ?? 0));

  return { files: selected, skipped };
}
