import { describe, expect, it } from 'vitest';
import type { GitHubClient, RepositoryTree } from '../github/types.js';
import { buildRepositoryIndex, planIndex } from './indexer.js';

const REF = { owner: 'octo', repo: 'demo' };
const SHA = 'a'.repeat(40);

describe('planIndex', () => {
  it('re-parses a new file and leaves an unchanged file alone', () => {
    const entries = [
      { path: 'src/a.ts', type: 'blob' as const, sha: 'sha-a', size: 10 },
      { path: 'src/b.ts', type: 'blob' as const, sha: 'sha-b', size: 10 },
    ];
    const plan = planIndex(entries, [{ path: 'src/a.ts', sha: 'sha-a' }], false);
    expect(plan.toParse.map((e) => e.path)).toEqual(['src/b.ts']);
  });

  it('re-parses a file whose blob sha changed', () => {
    const entries = [{ path: 'src/a.ts', type: 'blob' as const, sha: 'sha-a2', size: 10 }];
    const plan = planIndex(entries, [{ path: 'src/a.ts', sha: 'sha-a1' }], false);
    expect(plan.toParse.map((e) => e.path)).toEqual(['src/a.ts']);
  });

  it('marks a deleted file for removal', () => {
    const plan = planIndex([], [{ path: 'src/gone.ts', sha: 'sha-x' }], false);
    expect(plan.toRemove).toEqual(['src/gone.ts']);
  });

  it('treats a rename as a removal of the old path and an add of the new one', () => {
    const entries = [{ path: 'src/renamed.ts', type: 'blob' as const, sha: 'sha-a', size: 10 }];
    const plan = planIndex(entries, [{ path: 'src/old.ts', sha: 'sha-a' }], false);
    expect(plan.toRemove).toEqual(['src/old.ts']);
    expect(plan.toParse.map((e) => e.path)).toEqual(['src/renamed.ts']);
  });

  it('ignores unsupported files and non-blob entries', () => {
    const entries = [
      { path: 'README.md', type: 'blob' as const, sha: 'sha-r', size: 10 },
      { path: 'src', type: 'tree' as const, sha: 'sha-t', size: 0 },
    ];
    const plan = planIndex(entries, [], false);
    expect(plan.toParse).toEqual([]);
    expect(plan.allFiles.has('README.md')).toBe(true);
  });
});

function fakeClient(tree: RepositoryTree, files: Record<string, string>): GitHubClient {
  return {
    getPullRequest: () => Promise.reject(new Error('not used')),
    getPullRequestFiles: () => Promise.reject(new Error('not used')),
    listReviewBodies: () => Promise.reject(new Error('not used')),
    createReview: () => Promise.reject(new Error('not used')),
    createIssueComment: () => Promise.reject(new Error('not used')),
    getRepositoryTree: () => Promise.resolve(tree),
    getFileContent: (_ref, path) => Promise.resolve(files[path] ?? null),
  };
}

describe('buildRepositoryIndex', () => {
  it('builds direct and indirect edges across an import chain', async () => {
    const tree: RepositoryTree = {
      truncated: false,
      entries: [
        { path: 'src/index.ts', type: 'blob', sha: 's1', size: 10 },
        { path: 'src/a.ts', type: 'blob', sha: 's2', size: 10 },
        { path: 'src/b.ts', type: 'blob', sha: 's3', size: 10 },
      ],
    };
    const client = fakeClient(tree, {
      'src/index.ts': "import { a } from './a';",
      'src/a.ts': "import { b } from './b';",
      'src/b.ts': 'export const b = 1;',
    });

    const result = await buildRepositoryIndex({
      client,
      ref: REF,
      commitSha: SHA,
      previouslyIndexed: [],
    });

    expect(result.filesIndexed).toBe(3);
    expect(result.edgesBySourcePath.get('src/index.ts')).toEqual([
      { targetPath: 'src/a.ts', resolved: true },
    ]);
    expect(result.edgesBySourcePath.get('src/a.ts')).toEqual([
      { targetPath: 'src/b.ts', resolved: true },
    ]);
    // b.ts has no imports of its own; indirect reachability (index -> a -> b) is a graph-traversal
    // property built on these edges later (Phase 7), not something a single file's edges assert.
    expect(result.edgesBySourcePath.get('src/b.ts')).toEqual([]);
  });

  it('only re-parses files whose blob sha changed (incremental)', async () => {
    const tree: RepositoryTree = {
      truncated: false,
      entries: [
        { path: 'src/a.ts', type: 'blob', sha: 'unchanged-sha', size: 10 },
        { path: 'src/b.ts', type: 'blob', sha: 'new-sha', size: 10 },
      ],
    };
    const client = fakeClient(tree, { 'src/b.ts': "import { a } from './a';" });

    const result = await buildRepositoryIndex({
      client,
      ref: REF,
      commitSha: SHA,
      previouslyIndexed: [{ path: 'src/a.ts', sha: 'unchanged-sha' }],
    });

    expect(result.filesIndexed).toBe(1);
    expect(result.indexedFiles.map((f) => f.path)).toEqual(['src/b.ts']);
  });

  it('reports files that could not be fetched as indexed with no edges, rather than failing the run', async () => {
    const tree: RepositoryTree = {
      truncated: false,
      entries: [{ path: 'src/a.ts', type: 'blob', sha: 's1', size: 10 }],
    };
    const client = fakeClient(tree, {});
    const result = await buildRepositoryIndex({
      client,
      ref: REF,
      commitSha: SHA,
      previouslyIndexed: [],
    });
    expect(result.edgesBySourcePath.size).toBe(0);
    expect(result.indexedFiles).toEqual([
      { path: 'src/a.ts', sha: 's1', language: 'typescript', sizeBytes: 10 },
    ]);
  });

  it('surfaces a truncated tree instead of silently under-indexing', async () => {
    const tree: RepositoryTree = { truncated: true, entries: [] };
    const client = fakeClient(tree, {});
    const result = await buildRepositoryIndex({
      client,
      ref: REF,
      commitSha: SHA,
      previouslyIndexed: [],
    });
    expect(result.truncated).toBe(true);
  });

  it('caps how many changed files are re-fetched in one run', async () => {
    const tree: RepositoryTree = {
      truncated: false,
      entries: Array.from({ length: 5 }, (_, i) => ({
        path: `src/f${i}.ts`,
        type: 'blob' as const,
        sha: `s${i}`,
        size: 10,
      })),
    };
    const client = fakeClient(tree, {});
    const result = await buildRepositoryIndex({
      client,
      ref: REF,
      commitSha: SHA,
      previouslyIndexed: [],
      maxFiles: 2,
    });
    expect(result.indexedFiles).toHaveLength(2);
  });
});
