import {
  createIndexQueue,
  createIndexRun,
  createLogger,
  dependencyEdges,
  indexedFiles,
  indexRuns,
  repositories,
  type GitHubApp,
  type GitHubClient,
  type RepositoryTree,
} from '@coderexic/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { processIndexRun } from '../../apps/worker/src/index-run/pipeline.js';
import { createIndexWorker } from '../../apps/worker/src/index-run/worker.js';
import { makeIndexRun } from './db/fixtures.js';
import { useTestDatabase } from './helpers/db.js';
import { useTestRedis } from './helpers/redis.js';

const logger = createLogger({ name: 'index-run-pipeline-test', level: 'silent' });

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

function fakeGithubApp(client: GitHubClient): GitHubApp {
  return {
    getInstallationClient: () => Promise.resolve(client),
    getRepositoryInstallationId: () => Promise.reject(new Error('not used')),
  };
}

describe('worker: processIndexRun', () => {
  const { db } = useTestDatabase();

  it('indexes a repo, persists edges and files, and marks the run and repo READY', async () => {
    const { repository, run } = await makeIndexRun(db);
    const tree: RepositoryTree = {
      truncated: false,
      entries: [
        { path: 'src/index.ts', type: 'blob', sha: 's1', size: 10 },
        { path: 'src/a.ts', type: 'blob', sha: 's2', size: 10 },
      ],
    };
    const client = fakeClient(tree, { 'src/index.ts': "import { a } from './a';" });
    const deps = { db, githubApp: fakeGithubApp(client), logger };

    await processIndexRun(deps, run.id);

    const [storedRun] = await db.select().from(indexRuns).where(eq(indexRuns.id, run.id));
    expect(storedRun).toMatchObject({
      status: 'SUCCEEDED',
      filesSeen: 2,
      filesIndexed: 2,
      edgesCreated: 1,
    });
    const [repo] = await db.select().from(repositories).where(eq(repositories.id, repository.id));
    expect(repo?.indexStatus).toBe('READY');

    const files = await db
      .select()
      .from(indexedFiles)
      .where(eq(indexedFiles.repositoryId, repository.id));
    expect(files.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/index.ts']);

    const edges = await db
      .select()
      .from(dependencyEdges)
      .where(eq(dependencyEdges.repositoryId, repository.id));
    expect(edges).toMatchObject([
      { sourcePath: 'src/index.ts', targetPath: 'src/a.ts', resolved: true },
    ]);
  });

  it('is a no-op for a run that is not PENDING (already claimed or finished)', async () => {
    const { run } = await makeIndexRun(db);
    const tree: RepositoryTree = { truncated: false, entries: [] };
    const client = fakeClient(tree, {});
    const deps = { db, githubApp: fakeGithubApp(client), logger };

    await processIndexRun(deps, run.id);
    const [storedRun] = await db.select().from(indexRuns).where(eq(indexRuns.id, run.id));
    expect(storedRun?.status).toBe('SUCCEEDED');

    // A retried delivery, or the stale-run sweep, calling the same run again.
    await processIndexRun(deps, run.id);
    const [again] = await db.select().from(indexRuns).where(eq(indexRuns.id, run.id));
    expect(again?.completedAt).toEqual(storedRun?.completedAt);
  });

  it('marks the run and repo FAILED when the GitHub tree fetch fails', async () => {
    const { repository, run } = await makeIndexRun(db);
    const client: GitHubClient = {
      ...fakeClient({ truncated: false, entries: [] }, {}),
      getRepositoryTree: () => Promise.reject(new Error('rate limited')),
    };
    const deps = { db, githubApp: fakeGithubApp(client), logger };

    await expect(processIndexRun(deps, run.id)).rejects.toThrow('rate limited');

    const [storedRun] = await db.select().from(indexRuns).where(eq(indexRuns.id, run.id));
    expect(storedRun).toMatchObject({ status: 'FAILED' });
    const [repo] = await db.select().from(repositories).where(eq(repositories.id, repository.id));
    expect(repo?.indexStatus).toBe('FAILED');
  });

  it('on a second run, only re-parses the changed file and keeps the other file untouched', async () => {
    const { repository, run: firstRun } = await makeIndexRun(db);
    const tree1: RepositoryTree = {
      truncated: false,
      entries: [
        { path: 'src/a.ts', type: 'blob', sha: 'sha-a', size: 10 },
        { path: 'src/b.ts', type: 'blob', sha: 'sha-b', size: 10 },
      ],
    };
    const client1 = fakeClient(tree1, {
      'src/a.ts': "import { x } from './b';",
      'src/b.ts': 'export const x = 1;',
    });
    await processIndexRun({ db, githubApp: fakeGithubApp(client1), logger }, firstRun.id);

    const secondRun = await createIndexRun(db, repository.id, 'c'.repeat(40));
    const tree2: RepositoryTree = {
      truncated: false,
      entries: [
        { path: 'src/a.ts', type: 'blob', sha: 'sha-a-changed', size: 10 },
        { path: 'src/b.ts', type: 'blob', sha: 'sha-b', size: 10 },
      ],
    };
    const client2 = fakeClient(tree2, { 'src/a.ts': "import { y } from './b';" });
    await processIndexRun({ db, githubApp: fakeGithubApp(client2), logger }, secondRun.id);

    const [secondRunRow] = await db.select().from(indexRuns).where(eq(indexRuns.id, secondRun.id));
    // Only src/a.ts changed; src/b.ts was not re-fetched or re-parsed.
    expect(secondRunRow).toMatchObject({ filesIndexed: 1 });

    const edges = await db
      .select()
      .from(dependencyEdges)
      .where(eq(dependencyEdges.repositoryId, repository.id));
    expect(edges).toMatchObject([
      { sourcePath: 'src/a.ts', targetPath: 'src/b.ts', resolved: true },
    ]);
  });
});

describe('worker: createIndexWorker end to end', () => {
  const { db } = useTestDatabase();
  const redis = useTestRedis();

  it('picks a run up from the real Redis queue and processes it', async () => {
    const { run } = await makeIndexRun(db);
    const tree: RepositoryTree = { truncated: false, entries: [] };
    const client = fakeClient(tree, {});
    const worker = createIndexWorker({
      logger,
      db,
      connection: redis,
      githubApp: fakeGithubApp(client),
      concurrency: 1,
      sweepIntervalMs: 3_600_000,
      staleAfterMs: 3_600_000,
    });
    const producer = createIndexQueue(redis);

    try {
      await worker.start();
      await producer.add('index', { indexRunId: run.id }, { jobId: run.id });

      const deadline = Date.now() + 10_000;
      let status: string | undefined;
      while (Date.now() < deadline) {
        const [row] = await db.select().from(indexRuns).where(eq(indexRuns.id, run.id));
        status = row?.status;
        if (status && status !== 'PENDING' && status !== 'RUNNING') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(status).toBe('SUCCEEDED');
    } finally {
      await worker.stop();
      await producer.obliterate({ force: true }).catch(() => undefined);
      await producer.close();
    }
  }, 15_000);
});
