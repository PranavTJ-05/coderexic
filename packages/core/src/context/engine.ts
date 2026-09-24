import type { Executor } from '../db/client.js';
import type { IndexStatus } from '../db/schema.js';
import {
  getForwardEdgesForPaths,
  getReverseEdgesForPaths,
  listIndexedFiles,
} from '../db/store/graph.js';
import { extractorFor } from '../graph/extract/index.js';
import { loadGoModule, loadTsAliases } from '../graph/indexer.js';
import { extensionOf } from '../graph/languages.js';
import { EMPTY_TS_ALIASES } from '../graph/tsconfig.js';
import type { GitHubClient, RepoRef } from '../github/types.js';
import { matchesGlob } from '../review/diff-filter.js';
import type { ReviewContextCache } from './cache.js';
import { fetchCachedContent } from './fetch-content.js';
import { isTestFile, rankRelatedFiles, type ContextTier, type RelatedFile } from './rank.js';

const DEFAULT_DEPTH = 1;
const DEFAULT_MAX_FILES = 10;
const MAX_HEAD_FILE_BYTES = 512 * 1024;
/** A related file this large is dropped rather than handed to the model (ROADMAP.md Phase 7 "File size limits"). */
const MAX_RELATED_FILE_BYTES = 256 * 1024;

export interface BuildContextOptions {
  db: Executor;
  repositoryId: string;
  client: GitHubClient;
  ref: RepoRef;
  headSha: string;
  changedPaths: readonly string[];
  /**
   * Paths gone at head: deletions, and a rename's old path (pass the old
   * path here and the new path in `changedPaths`). Excluded from the
   * result and never fetched, but their stored dependents still surface —
   * "ten files imported the file this PR deletes" is exactly what a
   * reviewer needs to see.
   */
  removedPaths?: readonly string[];
  ignoreGlobs?: readonly string[];
  indexStatus: IndexStatus;
  /** 1 = direct imports/dependents/tests only. >=2 = also one hop past that frontier; values above 2 behave the same as 2 (no further hops). */
  depth?: number;
  maxFiles?: number;
  cache?: ReviewContextCache;
}

export interface BuildContextResult {
  files: RelatedFile[];
  degraded: boolean;
  note: string | null;
}

/**
 * Builds the related-file list for a review (AI_AGENT_SPEC.md §18): what a
 * changed file imports, what depends on it, its related tests, and
 * (optionally) one more hop out. Direct imports are re-extracted from the
 * PR's own head content, since the stored graph reflects only the indexed
 * default branch and knows nothing about a PR's own new/edited imports;
 * dependents come from that stored graph, since "what depends on this file"
 * is a repo-wide question the PR's diff alone can't answer.
 */
export async function buildReviewContext(
  options: BuildContextOptions,
): Promise<BuildContextResult> {
  const { db, repositoryId, client, ref, headSha, indexStatus } = options;

  if (indexStatus !== 'READY') {
    return {
      files: [],
      degraded: true,
      note: 'Repository index is not ready; review proceeds with only the changed files from the diff.',
    };
  }

  const depth = clamp(options.depth ?? DEFAULT_DEPTH, 1, 5);
  const maxFiles = clamp(options.maxFiles ?? DEFAULT_MAX_FILES, 1, 30);
  const removedPaths = new Set(options.removedPaths ?? []);
  const changedPaths = options.changedPaths.filter((path) => !removedPaths.has(path));
  const ignoreGlobs = options.ignoreGlobs ?? [];
  const cache = options.cache;

  const isIgnored = (path: string): boolean =>
    ignoreGlobs.some((pattern) => matchesGlob(path, pattern));
  const excluded = new Set([...changedPaths, ...removedPaths]);
  // Reverse edges (dependents) are looked up for both changed and removed paths, so a
  // deletion's dependents still surface even though the deleted file itself is excluded.
  const changedOrRemoved = [...changedPaths, ...removedPaths];

  const indexed = await listIndexedFiles(db, repositoryId);
  const sizeByPath = new Map(indexed.map((f) => [f.path, f.sizeBytes]));
  const allFiles = new Set(indexed.map((f) => f.path));
  for (const path of changedPaths) allFiles.add(path);
  for (const path of removedPaths) allFiles.delete(path);

  const needsTs = changedPaths.some((path) =>
    ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(extensionOf(path)),
  );
  const needsGo = changedPaths.some((path) => extensionOf(path) === 'go');
  const [tsAliases, goModule] = await Promise.all([
    needsTs ? loadTsAliases(client, ref, headSha) : Promise.resolve(EMPTY_TS_ALIASES),
    needsGo ? loadGoModule(client, ref, headSha) : Promise.resolve(null),
  ]);

  const classified: { path: string; tier: ContextTier }[] = [];

  const directImportPaths = new Set<string>();
  await Promise.all(
    changedPaths.map(async (path) => {
      const extractor = extractorFor(path);
      if (!extractor) return;
      const { content } = await fetchCachedContent(
        client,
        ref,
        path,
        headSha,
        MAX_HEAD_FILE_BYTES,
        cache,
      );
      if (content === null) return;
      const edges = extractor(content, { filePath: path, allFiles, tsAliases, goModule });
      for (const edge of edges) {
        if (excluded.has(edge.targetPath) || isIgnored(edge.targetPath)) continue;
        directImportPaths.add(edge.targetPath);
        classified.push({ path: edge.targetPath, tier: 'direct_import' });
      }
    }),
  );

  const reverseEdges = await getReverseEdgesForPaths(db, repositoryId, changedOrRemoved);
  const directDependentPaths = new Set<string>();
  for (const edge of reverseEdges) {
    const path = edge.sourcePath;
    if (excluded.has(path) || isIgnored(path)) continue;
    directDependentPaths.add(path);
    classified.push({ path, tier: isTestFile(path) ? 'related_test' : 'direct_dependent' });
  }

  if (depth >= 2) {
    const frontier = [...directImportPaths, ...directDependentPaths].filter(
      (path) => !excluded.has(path),
    );
    if (frontier.length > 0) {
      const [forward, reverse] = await Promise.all([
        getForwardEdgesForPaths(db, repositoryId, frontier),
        getReverseEdgesForPaths(db, repositoryId, frontier),
      ]);
      for (const edge of forward) {
        if (excluded.has(edge.targetPath) || isIgnored(edge.targetPath)) continue;
        classified.push({ path: edge.targetPath, tier: 'second_degree' });
      }
      for (const edge of reverse) {
        if (excluded.has(edge.sourcePath) || isIgnored(edge.sourcePath)) continue;
        classified.push({ path: edge.sourcePath, tier: 'second_degree' });
      }
    }
  }

  const ranked = rankRelatedFiles(classified);

  let droppedForSize = 0;
  const sized = ranked.filter((f) => {
    const size = sizeByPath.get(f.path);
    if (size !== undefined && size !== null && size > MAX_RELATED_FILE_BYTES) {
      droppedForSize += 1;
      return false;
    }
    return true;
  });

  const truncated = sized.length > maxFiles;
  const files = sized.slice(0, maxFiles);

  const notes: string[] = [];
  if (droppedForSize > 0) {
    notes.push(
      `${droppedForSize} related file(s) excluded for exceeding the ${MAX_RELATED_FILE_BYTES}-byte limit.`,
    );
  }
  if (truncated) {
    notes.push(`Related-file list truncated to ${maxFiles} of ${sized.length} candidates.`);
  }

  return {
    files,
    degraded: false,
    note: notes.length > 0 ? notes.join(' ') : null,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
