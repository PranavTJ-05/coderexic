import {
  AgentToolExecutor,
  ALREADY_FETCHED_MESSAGE,
  GitHubFileError,
  markRepositoryIndexed,
  replaceDependencyEdges,
  ReviewContextCache,
  upsertIndexedFiles,
  type GitHubClient,
} from '@coderexic/core';
import { describe, expect, it } from 'vitest';
import { makeRepository } from './db/fixtures.js';
import { useTestDatabase } from './helpers/db.js';

const REF = { owner: 'octo', repo: 'demo' };
const HEAD_SHA = 'b'.repeat(40);

function fakeClient(
  files: Record<string, string>,
  overrides: Partial<GitHubClient> = {},
): GitHubClient {
  return {
    getPullRequest: () => Promise.reject(new Error('not used')),
    getPullRequestFiles: () => Promise.reject(new Error('not used')),
    listReviewBodies: () => Promise.reject(new Error('not used')),
    createReview: () => Promise.reject(new Error('not used')),
    createIssueComment: () => Promise.reject(new Error('not used')),
    getRepositoryTree: () => Promise.reject(new Error('not used')),
    getFileContent: (_ref, path) => Promise.resolve(files[path] ?? null),
    ...overrides,
  };
}

describe('AgentToolExecutor', () => {
  const { db } = useTestDatabase();

  it('get_file_content returns fenced content, then refuses a repeat fetch', async () => {
    const repository = await makeRepository(db);
    const client = fakeClient({ 'src/a.ts': 'export const a = 1;\n' });
    const executor = new AgentToolExecutor({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: ['src/a.ts'],
    });

    const first = await executor.execute('get_file_content', { path: 'src/a.ts' });
    expect(first.text).toContain('export const a = 1;');
    expect(first.text).toContain('<<<FILE');

    const second = await executor.execute('get_file_content', { path: 'src/a.ts' });
    expect(second.text).toBe(ALREADY_FETCHED_MESSAGE);
  });

  it('get_file_content reuses a cached fetch without refusing it (cache != delivered)', async () => {
    const repository = await makeRepository(db);
    // getFileContent would reject if actually called, proving the cache hit avoided the fetch.
    const client = fakeClient(
      {},
      { getFileContent: () => Promise.reject(new Error('should not be called')) },
    );
    const cache = new ReviewContextCache();
    cache.setFile('src/a.ts', HEAD_SHA, 'export const a = 1;\n');
    const executor = new AgentToolExecutor({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: ['src/a.ts'],
      cache,
    });

    const result = await executor.execute('get_file_content', { path: 'src/a.ts' });
    expect(result.text).toContain('export const a = 1;');
  });

  it('get_file_content reports a missing file', async () => {
    const repository = await makeRepository(db);
    const client = fakeClient({});
    const executor = new AgentToolExecutor({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: ['src/missing.ts'],
    });
    const result = await executor.execute('get_file_content', { path: 'src/missing.ts' });
    expect(result.text).toContain('not found');
  });

  it('rejects a path outside the repo', async () => {
    const repository = await makeRepository(db);
    const client = fakeClient({});
    const executor = new AgentToolExecutor({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: [],
    });
    const result = await executor.execute('get_file_content', { path: '../secrets.env' });
    expect(result.text).toContain('Invalid path');
  });

  it('get_imports extracts imports from PR head content', async () => {
    const repository = await makeRepository(db);
    const client = fakeClient({
      'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
    });
    await upsertIndexedFiles(db, repository.id, [
      { path: 'src/b.ts', sha: 's2', language: 'typescript', sizeBytes: 10 },
    ]);
    const executor = new AgentToolExecutor({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: ['src/a.ts'],
    });
    const result = await executor.execute('get_imports', { path: 'src/a.ts' });
    expect(result.text).toContain('src/a.ts imports:');
    expect(result.text).toContain('- src/b.ts');
  });

  it('get_dependents reads the stored reverse graph', async () => {
    const repository = await makeRepository(db);
    await markRepositoryIndexed(db, repository.id, HEAD_SHA);
    await upsertIndexedFiles(db, repository.id, [
      { path: 'src/a.ts', sha: 's1', language: 'typescript', sizeBytes: 10 },
      { path: 'src/b.ts', sha: 's2', language: 'typescript', sizeBytes: 10 },
    ]);
    await replaceDependencyEdges(
      db,
      repository.id,
      HEAD_SHA,
      ['src/b.ts'],
      [{ sourcePath: 'src/b.ts', targetPath: 'src/a.ts', resolved: true }],
    );
    const client = fakeClient({});
    const executor = new AgentToolExecutor({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: [],
    });
    const result = await executor.execute('get_dependents', { path: 'src/a.ts' });
    expect(result.text).toContain('Files that depend on src/a.ts:');
    expect(result.text).toContain('- src/b.ts');
  });

  it('submit_review accepts a valid payload for a changed file and signals done', async () => {
    const repository = await makeRepository(db);
    const client = fakeClient({});
    const executor = new AgentToolExecutor({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: ['src/a.ts'],
    });
    const result = await executor.execute('submit_review', {
      summary: 'Looks fine.',
      reviews: [
        {
          filename: 'src/a.ts',
          severity: 'low',
          start_line: 1,
          end_line: 1,
          issue: 'Minor nit.',
          fix_type: 'warning',
          suggested_code: null,
        },
      ],
    });
    expect(result.done).toBe(true);
    expect(result.output).toMatchObject({
      summary: 'Looks fine.',
      reviews: [{ filename: 'src/a.ts', severity: 'low' }],
    });
  });

  it('submit_review rejects a finding on a file outside the PR', async () => {
    const repository = await makeRepository(db);
    const client = fakeClient({});
    const executor = new AgentToolExecutor({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: ['src/a.ts'],
    });
    const result = await executor.execute('submit_review', {
      summary: 'Looks fine.',
      reviews: [
        {
          filename: 'src/unrelated.ts',
          severity: 'low',
          start_line: 1,
          end_line: 1,
          issue: 'Minor nit.',
          fix_type: 'warning',
          suggested_code: null,
        },
      ],
    });
    expect(result.done).toBeUndefined();
    expect(result.text).toContain('not in this PR');
  });

  it('submit_review rejects a schema-invalid payload', async () => {
    const repository = await makeRepository(db);
    const client = fakeClient({});
    const executor = new AgentToolExecutor({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: [],
    });
    const result = await executor.execute('submit_review', { summary: 'oops' });
    expect(result.done).toBeUndefined();
    expect(result.text).toContain('invalid');
  });

  it('truncates an oversized tool result while keeping the fence closed', async () => {
    const repository = await makeRepository(db);
    const bigContent = 'x'.repeat(1000);
    const client = fakeClient({ 'src/a.ts': bigContent });
    const executor = new AgentToolExecutor({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: ['src/a.ts'],
      maxToolResultBytes: 100,
    });
    const result = await executor.execute('get_file_content', { path: 'src/a.ts' });
    expect(result.text).toContain('truncated');
    expect(result.text).toContain('FILE>>>');
    expect(result.text.trimEnd().endsWith('FILE>>>')).toBe(true);
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThan(300);
  });

  it('treats a transient fetch error as retryable, not "not found", and does not cache it', async () => {
    const repository = await makeRepository(db);
    let calls = 0;
    const client = fakeClient(
      {},
      {
        getFileContent: () => {
          calls += 1;
          if (calls === 1) return Promise.reject(new Error('ECONNRESET'));
          return Promise.resolve('export const a = 1;\n');
        },
      },
    );
    const executor = new AgentToolExecutor({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: ['src/a.ts'],
    });

    const first = await executor.execute('get_file_content', { path: 'src/a.ts' });
    expect(first.text).toContain('temporary error');
    expect(first.text).not.toContain('not found');

    const second = await executor.execute('get_file_content', { path: 'src/a.ts' });
    expect(second.text).toContain('export const a = 1;');
    expect(calls).toBe(2);
  });

  it('reports a binary file as unavailable rather than a retryable error, and does not re-fetch it', async () => {
    const repository = await makeRepository(db);
    let calls = 0;
    const client = fakeClient(
      {},
      {
        getFileContent: (_ref, path) => {
          calls += 1;
          return Promise.reject(new GitHubFileError('file is binary', path));
        },
      },
    );
    const executor = new AgentToolExecutor({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: ['src/a.bin'],
    });

    const first = await executor.execute('get_file_content', { path: 'src/a.bin' });
    expect(first.text).toContain('binary');
    expect(first.text).not.toContain('retry');

    await executor.execute('get_file_content', { path: 'src/a.bin' });
    expect(calls).toBe(1);
  });

  it('times out a slow tool call without poisoning a later successful retry', async () => {
    const repository = await makeRepository(db);
    let calls = 0;
    const client = fakeClient(
      {},
      {
        getFileContent: () => {
          calls += 1;
          const delay = calls === 1 ? 200 : 0;
          return new Promise((resolve) => {
            setTimeout(() => {
              resolve('export const a = 1;\n');
            }, delay);
          });
        },
      },
    );
    const executor = new AgentToolExecutor({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: ['src/a.ts'],
      toolTimeoutMs: 20,
    });

    const first = await executor.execute('get_file_content', { path: 'src/a.ts' });
    expect(first.text).toContain('timed out');

    // Let the slow first fetch actually settle before retrying.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const second = await executor.execute('get_file_content', { path: 'src/a.ts' });
    expect(second.text).toContain('export const a = 1;');
    expect(second.text).not.toBe(ALREADY_FETCHED_MESSAGE);
  });

  it('accepts tool arguments as a raw JSON string (OpenAI-style adapters)', async () => {
    const repository = await makeRepository(db);
    const client = fakeClient({ 'src/a.ts': 'export const a = 1;\n' });
    const executor = new AgentToolExecutor({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: ['src/a.ts'],
    });
    const result = await executor.execute('get_file_content', JSON.stringify({ path: 'src/a.ts' }));
    expect(result.text).toContain('export const a = 1;');
  });

  it('caches a repeated get_dependents query rather than re-querying', async () => {
    const repository = await makeRepository(db);
    await markRepositoryIndexed(db, repository.id, HEAD_SHA);
    await upsertIndexedFiles(db, repository.id, [
      { path: 'src/a.ts', sha: 's1', language: 'typescript', sizeBytes: 10 },
      { path: 'src/b.ts', sha: 's2', language: 'typescript', sizeBytes: 10 },
    ]);
    await replaceDependencyEdges(
      db,
      repository.id,
      HEAD_SHA,
      ['src/b.ts'],
      [{ sourcePath: 'src/b.ts', targetPath: 'src/a.ts', resolved: true }],
    );
    const client = fakeClient({});
    const executor = new AgentToolExecutor({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: [],
    });
    const first = await executor.execute('get_dependents', { path: 'src/a.ts' });
    // A second, differently-sourced edge would only show up if the query re-ran.
    await replaceDependencyEdges(
      db,
      repository.id,
      HEAD_SHA,
      ['src/c.ts'],
      [{ sourcePath: 'src/c.ts', targetPath: 'src/a.ts', resolved: true }],
    );
    const second = await executor.execute('get_dependents', { path: 'src/a.ts' });
    expect(second.text).toBe(first.text);
    expect(second.text).not.toContain('src/c.ts');
  });

  it('returns unknown tool name gracefully', async () => {
    const repository = await makeRepository(db);
    const client = fakeClient({});
    const executor = new AgentToolExecutor({
      db,
      repositoryId: repository.id,
      client,
      ref: REF,
      headSha: HEAD_SHA,
      changedPaths: [],
    });
    const result = await executor.execute('delete_repo', {});
    expect(result.text).toContain('Unknown tool');
  });
});
