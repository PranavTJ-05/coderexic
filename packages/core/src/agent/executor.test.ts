import { describe, expect, it, vi } from 'vitest';
import type { Executor } from '../db/client.js';
import type { GitHubClient } from '../github/types.js';
import { AgentToolExecutor } from './executor.js';

function fakeGitHubClient(): GitHubClient {
  return {
    getPullRequest: vi.fn(),
    getPullRequestFiles: vi.fn(),
    getFileContent: vi.fn().mockResolvedValue(null),
    getRepositoryTree: vi.fn(),
    listReviewBodies: vi.fn(),
    createReview: vi.fn(),
    createIssueComment: vi.fn(),
  };
}

function buildExecutor(client: GitHubClient = fakeGitHubClient()): AgentToolExecutor {
  return new AgentToolExecutor({
    db: {} as Executor,
    repositoryId: 'repo-1',
    client,
    ref: { owner: 'octo', repo: 'demo' },
    headSha: 'a'.repeat(40),
    changedPaths: ['src/a.ts'],
  });
}

// Phase 16 security audit: path-traversal vectors against all three
// path-taking tools. None of these should reach the GitHub client - the
// rejection must happen in argument validation, before any fetch.
const TRAVERSAL_VECTORS: readonly [string, string][] = [
  ['bare ..', '..'],
  ['parent traversal', '../../etc/passwd'],
  ['absolute unix path', '/etc/passwd'],
  ['absolute windows path', 'C:\\Windows\\system32\\config'],
  ['windows-style backslash traversal', '..\\..\\secrets.env'],
  ['dot-slash prefix combined with traversal', './../secrets.env'],
  ['NUL byte', 'src/auth.ts\u0000.png'],
  ['traversal buried mid-path', 'a/../../b'],
];

describe('AgentToolExecutor path traversal guard', () => {
  describe.each(['get_file_content', 'get_imports', 'get_dependents'] as const)(
    '%s',
    (toolName) => {
      it.each(TRAVERSAL_VECTORS)(
        'rejects %s (%p) without calling the GitHub client',
        async (_label, path) => {
          const client = fakeGitHubClient();
          // eslint-disable-next-line @typescript-eslint/unbound-method -- mock reference for assertion, never invoked unbound.
          const getFileContent = vi.mocked(client.getFileContent);
          const executor = buildExecutor(client);
          const result = await executor.execute(toolName, { path });
          expect(result.status).toBe('REJECTED');
          expect(result.text).toContain('Invalid path');
          expect(getFileContent).not.toHaveBeenCalled();
        },
      );
    },
  );

  it('accepts an ordinary repo-relative path for get_file_content', async () => {
    const client = fakeGitHubClient();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- mock reference for assertion, never invoked unbound.
    const getFileContent = vi.mocked(client.getFileContent);
    const executor = buildExecutor(client);
    const result = await executor.execute('get_file_content', { path: 'src/a.ts' });
    expect(result.status).toBe('SUCCEEDED');
    expect(getFileContent).toHaveBeenCalled();
  });

  it('rejects malformed arguments (missing path) cleanly for every path tool', async () => {
    const executor = buildExecutor();
    for (const toolName of ['get_file_content', 'get_imports', 'get_dependents']) {
      const result = await executor.execute(toolName, {});
      expect(result.status).toBe('REJECTED');
    }
  });

  it('rejects a non-object/garbage argument without throwing', async () => {
    const executor = buildExecutor();
    const result = await executor.execute('get_file_content', 'not-json-and-not-an-object');
    expect(result.status).toBe('REJECTED');
  });

  it('rejects an unknown tool name cleanly', async () => {
    const executor = buildExecutor();
    const result = await executor.execute('delete_everything', { path: 'src/a.ts' });
    expect(result.status).toBe('REJECTED');
  });
});
