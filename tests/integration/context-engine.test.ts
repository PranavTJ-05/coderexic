import {
  buildReviewContext,
  markRepositoryIndexed,
  replaceDependencyEdges,
  upsertIndexedFiles,
  type GitHubClient,
} from '@coderexic/core';
import { describe, expect, it } from 'vitest';
import { makeRepository } from './db/fixtures.js';
import { useTestDatabase } from './helpers/db.js';

const REF = { owner: 'octo', repo: 'demo' };
const HEAD_SHA = 'b'.repeat(40);

function fakeClient(files: Record<string, string>): GitHubClient {
  return {
    getPullRequest: () => Promise.reject(new Error('not used')),
    getPullRequestFiles: () => Promise.reject(new Error('not used')),
    listReviewBodies: () => Promise.reject(new Error('not used')),
    createReview: () => Promise.reject(new Error('not used')),
    createIssueComment: () => Promise.reject(new Error('not used')),
    getRepositoryTree: () => Promise.reject(new Error('not used')),
    getFileContent: (_ref, path) => Promise.resolve(files[path] ?? null),
  };
}

describe('buildReviewContext', () => {
  const { db } = useTestDatabase();

  it('returns a degraded empty result when the repository is not indexed', async () => {
    const repository = await makeRepository(db);
    const client = fakeClient({});
    const result = await buildReviewContext({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: ['src/a.ts'],
      indexStatus: 'PENDING',
    });
    expect(result).toMatchObject({ files: [], degraded: true });
    expect(result.note).toBeTruthy();
  });

  it('classifies direct imports, direct dependents, and related tests', async () => {
    const repository = await makeRepository(db);
    await markRepositoryIndexed(db, repository.id, HEAD_SHA);
    await upsertIndexedFiles(db, repository.id, [
      { path: 'src/a.ts', sha: 's1', language: 'typescript', sizeBytes: 10 },
      { path: 'src/b.ts', sha: 's2', language: 'typescript', sizeBytes: 10 },
      { path: 'src/c.ts', sha: 's3', language: 'typescript', sizeBytes: 10 },
      { path: 'src/a.test.ts', sha: 's4', language: 'typescript', sizeBytes: 10 },
    ]);
    // src/b.ts and src/a.test.ts both depend on (import) src/a.ts in the stored graph.
    await replaceDependencyEdges(
      db,
      repository.id,
      HEAD_SHA,
      ['src/b.ts', 'src/a.test.ts'],
      [
        { sourcePath: 'src/b.ts', targetPath: 'src/a.ts', resolved: true },
        { sourcePath: 'src/a.test.ts', targetPath: 'src/a.ts', resolved: true },
      ],
    );

    const client = fakeClient({
      'src/a.ts': "import { c } from './c';\nexport const a = c;\n",
    });

    const result = await buildReviewContext({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: ['src/a.ts'],
      indexStatus: 'READY',
    });

    expect(result.degraded).toBe(false);
    expect(result.files).toEqual(
      expect.arrayContaining([
        { path: 'src/c.ts', tier: 'direct_import' },
        { path: 'src/b.ts', tier: 'direct_dependent' },
        { path: 'src/a.test.ts', tier: 'related_test' },
      ]),
    );
  });

  it('excludes ignored paths and the changed files themselves', async () => {
    const repository = await makeRepository(db);
    await markRepositoryIndexed(db, repository.id, HEAD_SHA);
    await upsertIndexedFiles(db, repository.id, [
      { path: 'src/a.ts', sha: 's1', language: 'typescript', sizeBytes: 10 },
      { path: 'dist/c.ts', sha: 's3', language: 'typescript', sizeBytes: 10 },
    ]);
    const client = fakeClient({
      'src/a.ts': "import { c } from '../dist/c';\nexport const a = c;\n",
    });

    const result = await buildReviewContext({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: ['src/a.ts'],
      ignoreGlobs: ['dist'],
      indexStatus: 'READY',
    });

    expect(result.files.map((f) => f.path)).not.toContain('dist/c.ts');
    expect(result.files.map((f) => f.path)).not.toContain('src/a.ts');

    // Control: without the ignore glob, the same import does resolve, proving the
    // exclusion above came from the glob and not from the extractor failing to resolve it.
    const unfiltered = await buildReviewContext({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: ['src/a.ts'],
      indexStatus: 'READY',
    });
    expect(unfiltered.files.map((f) => f.path)).toContain('dist/c.ts');
  });

  it('surfaces dependents of a deleted file even though the deleted file itself is excluded', async () => {
    const repository = await makeRepository(db);
    await markRepositoryIndexed(db, repository.id, HEAD_SHA);
    await upsertIndexedFiles(db, repository.id, [
      { path: 'src/util.ts', sha: 's1', language: 'typescript', sizeBytes: 10 },
      { path: 'src/consumer.ts', sha: 's2', language: 'typescript', sizeBytes: 10 },
    ]);
    await replaceDependencyEdges(
      db,
      repository.id,
      HEAD_SHA,
      ['src/consumer.ts'],
      [{ sourcePath: 'src/consumer.ts', targetPath: 'src/util.ts', resolved: true }],
    );
    const client = fakeClient({});

    const result = await buildReviewContext({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: [],
      removedPaths: ['src/util.ts'],
      indexStatus: 'READY',
    });

    expect(result.files).toEqual(
      expect.arrayContaining([{ path: 'src/consumer.ts', tier: 'direct_dependent' }]),
    );
    expect(result.files.map((f) => f.path)).not.toContain('src/util.ts');
  });

  it('drops a related file that exceeds the size limit and notes the exclusion', async () => {
    const repository = await makeRepository(db);
    await markRepositoryIndexed(db, repository.id, HEAD_SHA);
    await upsertIndexedFiles(db, repository.id, [
      { path: 'src/a.ts', sha: 's1', language: 'typescript', sizeBytes: 10 },
      { path: 'src/huge.ts', sha: 's2', language: 'typescript', sizeBytes: 10_000_000 },
    ]);
    await replaceDependencyEdges(
      db,
      repository.id,
      HEAD_SHA,
      ['src/huge.ts'],
      [{ sourcePath: 'src/huge.ts', targetPath: 'src/a.ts', resolved: true }],
    );
    const client = fakeClient({});

    const result = await buildReviewContext({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: ['src/a.ts'],
      indexStatus: 'READY',
    });

    expect(result.files.map((f) => f.path)).not.toContain('src/huge.ts');
    expect(result.note).toContain('byte limit');
  });

  it('expands to a second-degree hop only when depth >= 2', async () => {
    const repository = await makeRepository(db);
    await markRepositoryIndexed(db, repository.id, HEAD_SHA);
    await upsertIndexedFiles(db, repository.id, [
      { path: 'src/a.ts', sha: 's1', language: 'typescript', sizeBytes: 10 },
      { path: 'src/b.ts', sha: 's2', language: 'typescript', sizeBytes: 10 },
      { path: 'src/c.ts', sha: 's3', language: 'typescript', sizeBytes: 10 },
    ]);
    // b depends on a (direct dependent of a); c depends on b (second degree from a).
    await replaceDependencyEdges(
      db,
      repository.id,
      HEAD_SHA,
      ['src/b.ts', 'src/c.ts'],
      [
        { sourcePath: 'src/b.ts', targetPath: 'src/a.ts', resolved: true },
        { sourcePath: 'src/c.ts', targetPath: 'src/b.ts', resolved: true },
      ],
    );
    const client = fakeClient({});

    const depth1 = await buildReviewContext({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: ['src/a.ts'],
      depth: 1,
      indexStatus: 'READY',
    });
    expect(depth1.files.map((f) => f.path)).not.toContain('src/c.ts');

    const depth2 = await buildReviewContext({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: ['src/a.ts'],
      depth: 2,
      indexStatus: 'READY',
    });
    expect(depth2.files).toEqual(
      expect.arrayContaining([{ path: 'src/c.ts', tier: 'second_degree' }]),
    );
  });

  it('truncates to maxFiles and notes the truncation', async () => {
    const repository = await makeRepository(db);
    await markRepositoryIndexed(db, repository.id, HEAD_SHA);
    const indexedFiles = Array.from({ length: 5 }, (_, i) => ({
      path: `src/dep${i}.ts`,
      sha: `sha${i}`,
      language: 'typescript',
      sizeBytes: 10,
    }));
    await upsertIndexedFiles(db, repository.id, [
      { path: 'src/a.ts', sha: 's1', language: 'typescript', sizeBytes: 10 },
      ...indexedFiles,
    ]);
    await replaceDependencyEdges(
      db,
      repository.id,
      HEAD_SHA,
      indexedFiles.map((f) => f.path),
      indexedFiles.map((f) => ({ sourcePath: f.path, targetPath: 'src/a.ts', resolved: true })),
    );
    const client = fakeClient({});

    const result = await buildReviewContext({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: ['src/a.ts'],
      maxFiles: 2,
      indexStatus: 'READY',
    });

    expect(result.files).toHaveLength(2);
    expect(result.note).toContain('truncated');
  });
});
