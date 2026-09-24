import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../logger.js';
import { createGitHubApp, GitHubFileError, shouldRetryRateLimit } from './client.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

interface Recorded {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}

type Route = (
  request: Recorded,
  url: URL,
) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

/** A fake api.github.com: routes are tried in order; unmatched requests 404. */
function fakeGitHub(routes: Route[]) {
  const requests: Recorded[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const recorded: Recorded = {
      method: init?.method ?? 'GET',
      path: decodeURIComponent(url.pathname),
      auth: headers.get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    requests.push(recorded);
    for (const route of routes) {
      const response = route(recorded, url);
      if (response) {
        return Promise.resolve(
          new Response(JSON.stringify(response.body ?? {}), {
            status: response.status ?? 200,
            headers: { 'content-type': 'application/json', ...response.headers },
          }),
        );
      }
    }
    return Promise.resolve(
      new Response(JSON.stringify({ message: 'Not Found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch, requests };
}

const accessToken: Route = (r) =>
  r.method === 'POST' && r.path === '/app/installations/99/access_tokens'
    ? {
        status: 201,
        body: {
          token: 'ghs_fake_installation_token',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: { contents: 'read', pull_requests: 'write' },
          repository_selection: 'selected',
        },
      }
    : undefined;

const on =
  (
    method: string,
    path: string,
    body: unknown,
    status = 200,
    headers?: Record<string, string>,
  ): Route =>
  (r) =>
    r.method === method && r.path === path
      ? { status, body, ...(headers && { headers }) }
      : undefined;

const ref = { owner: 'octocat', repo: 'hello' };
const logger = createLogger({ name: 'github-test', level: 'silent' });

async function clientWith(routes: Route[]) {
  const fake = fakeGitHub([accessToken, ...routes]);
  const app = createGitHubApp({
    credentials: { appId: 4242, privateKey },
    logger,
    fetch: fake.fetch,
    throttle: false,
  });
  return { client: await app.getInstallationClient(99), app, requests: fake.requests };
}

const base64 = (text: string) => Buffer.from(text).toString('base64');

describe('createGitHubApp', () => {
  it('authenticates as the app with an RS256 JWT, then uses the installation token', async () => {
    const { client, requests } = await clientWith([
      on('GET', '/repos/octocat/hello/pulls/5', {
        number: 5,
        title: 't',
        body: null,
        user: { login: 'dev' },
        state: 'open',
        draft: false,
        base: { sha: 'b'.repeat(40), ref: 'main' },
        head: { sha: 'h'.repeat(40), ref: 'feature' },
        additions: 1,
        deletions: 0,
        changed_files: 1,
      }),
    ]);
    await client.getPullRequest(ref, 5);

    const tokenRequest = requests.find((r) => r.path.endsWith('/access_tokens'))!;
    const jwt = tokenRequest.auth!.replace(/^bearer /i, '');
    const [header, payload, signature] = jwt.split('.') as [string, string, string];
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({ iss: 4242 });

    const apiRequest = requests.find((r) => r.path === '/repos/octocat/hello/pulls/5')!;
    expect(apiRequest.auth).toBe('token ghs_fake_installation_token');
  });

  it('looks up the installation that covers a repository', async () => {
    const { app } = await clientWith([on('GET', '/repos/octocat/hello/installation', { id: 99 })]);
    expect(await app.getRepositoryInstallationId(ref)).toBe(99);
  });
});

describe('GitHubClient', () => {
  it('maps pull request metadata', async () => {
    const { client } = await clientWith([
      on('GET', '/repos/octocat/hello/pulls/5', {
        number: 5,
        title: 'Add login',
        body: 'Adds login',
        user: { login: 'dev' },
        state: 'open',
        draft: true,
        base: { sha: 'b'.repeat(40), ref: 'main' },
        head: { sha: 'h'.repeat(40), ref: 'feature' },
        additions: 10,
        deletions: 2,
        changed_files: 3,
      }),
    ]);
    expect(await client.getPullRequest(ref, 5)).toEqual({
      number: 5,
      title: 'Add login',
      body: 'Adds login',
      author: 'dev',
      state: 'open',
      draft: true,
      baseSha: 'b'.repeat(40),
      headSha: 'h'.repeat(40),
      baseRef: 'main',
      headRef: 'feature',
      additions: 10,
      deletions: 2,
      changedFiles: 3,
    });
  });

  it('pages through all changed files and keeps missing patches as null', async () => {
    const file = (n: number) => ({
      filename: `f${n}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: '@@',
    });
    const page1 = Array.from({ length: 100 }, (_, i) => file(i));
    const { client } = await clientWith([
      (r, url) =>
        r.path === '/repos/octocat/hello/pulls/5/files'
          ? url.searchParams.get('page') === '2'
            ? {
                body: [
                  {
                    filename: 'logo.png',
                    status: 'renamed',
                    previous_filename: 'old.png',
                    additions: 0,
                    deletions: 0,
                  },
                ],
              }
            : {
                body: page1,
                headers: {
                  link: '<https://api.github.com/repos/octocat/hello/pulls/5/files?per_page=100&page=2>; rel="next"',
                },
              }
          : undefined,
    ]);
    const files = await client.getPullRequestFiles(ref, 5);
    expect(files).toHaveLength(101);
    expect(files[100]).toEqual({
      filename: 'logo.png',
      previousFilename: 'old.png',
      status: 'renamed',
      additions: 0,
      deletions: 0,
      patch: null,
    });
  });

  describe('getFileContent', () => {
    const content = (path: string, body: unknown): Route =>
      on('GET', `/repos/octocat/hello/contents/${path}`, body);

    it('decodes a text file at the requested commit', async () => {
      const { client, requests } = await clientWith([
        content('src/a.ts', {
          type: 'file',
          size: 13,
          encoding: 'base64',
          content: base64('export {};\n'),
        }),
      ]);
      expect(await client.getFileContent(ref, 'src/a.ts', 'c'.repeat(40))).toBe('export {};\n');
      expect(requests.at(-1)!.path).toBe('/repos/octocat/hello/contents/src/a.ts');
    });

    it('returns null for a file missing at that commit', async () => {
      const { client } = await clientWith([]);
      expect(await client.getFileContent(ref, 'gone.ts', 'c'.repeat(40))).toBeNull();
    });

    it.each([
      ['a directory', [{ type: 'file', name: 'x' }], /not a file/],
      [
        'an oversized file',
        { type: 'file', size: 5_000_000, encoding: 'base64', content: '' },
        /larger than/,
      ],
      [
        'a binary file',
        { type: 'file', size: 4, encoding: 'base64', content: base64('\u0000PNG') },
        /binary/,
      ],
      [
        'a file without inline content',
        { type: 'file', size: 10, encoding: 'none', content: '' },
        /not available/,
      ],
    ])('refuses %s', async (_label, body, message) => {
      const { client } = await clientWith([content('x', body)]);
      const error = await client
        .getFileContent(ref, 'x', 'c'.repeat(40))
        .catch((err: unknown) => err);
      expect(error).toBeInstanceOf(GitHubFileError);
      expect((error as Error).message).toMatch(message);
    });
  });

  it('returns the recursive tree and flags truncation', async () => {
    const { client } = await clientWith([
      on('GET', `/repos/octocat/hello/git/trees/${'c'.repeat(40)}`, {
        truncated: true,
        tree: [
          { path: 'src', type: 'tree', sha: 's1' },
          { path: 'src/a.ts', type: 'blob', sha: 's2', size: 12 },
        ],
      }),
    ]);
    expect(await client.getRepositoryTree(ref, 'c'.repeat(40))).toEqual({
      truncated: true,
      entries: [
        { path: 'src', type: 'tree', sha: 's1', size: null },
        { path: 'src/a.ts', type: 'blob', sha: 's2', size: 12 },
      ],
    });
  });

  it('publishes a COMMENT review with single- and multi-line comments on the new side', async () => {
    const { client, requests } = await clientWith([
      on('POST', '/repos/octocat/hello/pulls/5/reviews', { id: 777 }),
    ]);
    const id = await client.createReview(ref, {
      pullNumber: 5,
      commitSha: 'h'.repeat(40),
      body: 'Summary',
      comments: [
        { path: 'a.ts', line: 3, body: 'one line' },
        { path: 'a.ts', line: 9, startLine: 7, body: 'range' },
      ],
    });
    expect(id).toBe(777);
    expect(requests.at(-1)!.body).toEqual({
      commit_id: 'h'.repeat(40),
      body: 'Summary',
      event: 'COMMENT',
      comments: [
        { path: 'a.ts', line: 3, side: 'RIGHT', body: 'one line' },
        { path: 'a.ts', line: 9, side: 'RIGHT', start_line: 7, start_side: 'RIGHT', body: 'range' },
      ],
    });
  });

  it('posts a PR-level comment', async () => {
    const { client, requests } = await clientWith([
      on('POST', '/repos/octocat/hello/issues/5/comments', { id: 55 }),
    ]);
    expect(await client.createIssueComment(ref, 5, 'fallback')).toBe(55);
    expect(requests.at(-1)!.body).toEqual({ body: 'fallback' });
  });

  it('surfaces permission errors instead of swallowing them', async () => {
    const { client } = await clientWith([
      on(
        'POST',
        '/repos/octocat/hello/issues/5/comments',
        { message: 'Resource not accessible by integration' },
        403,
      ),
    ]);
    await expect(client.createIssueComment(ref, 5, 'x')).rejects.toMatchObject({ status: 403 });
  });
});

describe('shouldRetryRateLimit', () => {
  it.each([
    [30, 0, true],
    [60, 1, true],
    [61, 0, false],
    [5, 2, false],
  ])('retryAfter=%is retryCount=%i -> %s', (retryAfter, retryCount, expected) => {
    expect(shouldRetryRateLimit(retryAfter, retryCount)).toBe(expected);
  });
});
