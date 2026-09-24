import type { GitHubClient, RepoRef, TreeEntry } from '../github/types.js';
import type { ResolvedImport } from './extract/types.js';
import { extractorFor } from './extract/index.js';
import { parseGoModulePrefix } from './extract/go.js';
import { extensionOf, isSupportedPath, languageOf } from './languages.js';
import { EMPTY_TS_ALIASES, parseTsConfigAliases, type TsAliasConfig } from './tsconfig.js';

const DEFAULT_MAX_FILES = 3000;
const DEFAULT_CONCURRENCY = 10;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

export interface PreviouslyIndexedFile {
  path: string;
  sha: string | null;
}

export interface IndexPlan {
  /** Every blob path in the tree, for resolvers to check candidate paths against. */
  allFiles: ReadonlySet<string>;
  supported: TreeEntry[];
  /** New or content-changed supported files: the only ones re-parsed. */
  toParse: TreeEntry[];
  /** Previously indexed paths no longer present (deleted, renamed, or no longer supported). */
  toRemove: string[];
  truncated: boolean;
}

/**
 * Diffs the current tree against `indexed_files`' stored blob SHAs so only
 * changed files are re-fetched and re-parsed (ROADMAP.md Phase 6's
 * "Incremental update"). A rename falls out naturally: the old path is in
 * `toRemove`, the new path (a different blob) is in `toParse`.
 */
export function planIndex(
  entries: readonly TreeEntry[],
  previouslyIndexed: readonly PreviouslyIndexedFile[],
  truncated: boolean,
): IndexPlan {
  const allFiles = new Set(entries.filter((e) => e.type === 'blob').map((e) => e.path));
  const supported = entries.filter((e) => e.type === 'blob' && isSupportedPath(e.path));
  const supportedPaths = new Set(supported.map((e) => e.path));
  const previousShaByPath = new Map(previouslyIndexed.map((f) => [f.path, f.sha]));
  const toParse = supported.filter((e) => previousShaByPath.get(e.path) !== e.sha);
  const toRemove = previouslyIndexed.map((f) => f.path).filter((path) => !supportedPaths.has(path));
  return { allFiles, supported, toParse, toRemove, truncated };
}

export interface IndexedFileResult {
  path: string;
  sha: string;
  language: string | null;
}

export interface BuildIndexOptions {
  client: GitHubClient;
  ref: RepoRef;
  commitSha: string;
  previouslyIndexed: readonly PreviouslyIndexedFile[];
  /** Caps how many changed files are re-fetched and parsed in one run, protecting the installation's rate limit. */
  maxFiles?: number;
  concurrency?: number;
}

export interface BuildIndexResult {
  filesSeen: number;
  filesIndexed: number;
  edgesCreated: number;
  indexedFiles: IndexedFileResult[];
  removedPaths: string[];
  /** Edges are per-source-path, so the caller can replace only the edges of files it re-parsed. */
  edgesBySourcePath: Map<string, ResolvedImport[]>;
  /** True if GitHub truncated the tree listing: the repo has files this run could not see. */
  truncated: boolean;
}

async function loadTsAliases(
  client: GitHubClient,
  ref: RepoRef,
  commitSha: string,
): Promise<TsAliasConfig> {
  const text = await client
    .getFileContent(ref, 'tsconfig.json', commitSha, MAX_MANIFEST_BYTES)
    .catch(() => null);
  return text ? parseTsConfigAliases(text) : EMPTY_TS_ALIASES;
}

async function loadGoModule(
  client: GitHubClient,
  ref: RepoRef,
  commitSha: string,
): Promise<string | null> {
  const text = await client
    .getFileContent(ref, 'go.mod', commitSha, MAX_MANIFEST_BYTES)
    .catch(() => null);
  return text ? parseGoModulePrefix(text) : null;
}

/**
 * Builds (incrementally) the forward dependency graph for one commit:
 * fetches the repo tree, re-parses only changed supported files, and
 * resolves each one's imports to other repo files (ARCHITECTURE.md §8).
 */
export async function buildRepositoryIndex(options: BuildIndexOptions): Promise<BuildIndexResult> {
  const { client, ref, commitSha } = options;
  const tree = await client.getRepositoryTree(ref, commitSha);
  const plan = planIndex(tree.entries, options.previouslyIndexed, tree.truncated);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const filesToParse = plan.toParse.slice(0, maxFiles);

  const needsTs = filesToParse.some((f) =>
    ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(extensionOf(f.path)),
  );
  const needsGo = filesToParse.some((f) => extensionOf(f.path) === 'go');
  const [tsAliases, goModule] = await Promise.all([
    needsTs ? loadTsAliases(client, ref, commitSha) : Promise.resolve(EMPTY_TS_ALIASES),
    needsGo ? loadGoModule(client, ref, commitSha) : Promise.resolve(null),
  ]);

  const indexedFiles: IndexedFileResult[] = [];
  const edgesBySourcePath = new Map<string, ResolvedImport[]>();

  for (let i = 0; i < filesToParse.length; i += concurrency) {
    const batch = filesToParse.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (entry) => {
        const language = languageOf(entry.path);
        const extractor = extractorFor(entry.path);
        const content = await client
          .getFileContent(ref, entry.path, commitSha, MAX_FILE_BYTES)
          .catch(() => null);
        indexedFiles.push({ path: entry.path, sha: entry.sha, language });
        if (content === null || !extractor) return;
        const edges = extractor(content, {
          filePath: entry.path,
          allFiles: plan.allFiles,
          tsAliases,
          goModule,
        });
        edgesBySourcePath.set(entry.path, edges);
      }),
    );
  }

  let edgesCreated = 0;
  for (const edges of edgesBySourcePath.values()) edgesCreated += edges.length;

  return {
    filesSeen: tree.entries.length,
    filesIndexed: indexedFiles.length,
    edgesCreated,
    indexedFiles,
    removedPaths: plan.toRemove,
    edgesBySourcePath,
    truncated: tree.truncated,
  };
}
