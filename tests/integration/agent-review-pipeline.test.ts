import {
  agentRuns,
  agentToolCalls,
  createLogger,
  markRepositoryIndexed,
  replaceDependencyEdges,
  reviewJobs,
  reviews,
  type AgentAdapter,
  type AgentChatResult,
  type CreateReviewInput,
  type GitHubApp,
  type GitHubClient,
  type ModelReviewOutput,
  type PRFile,
  type PullRequest,
  type ReviewModel,
} from '@coderexic/core';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { processReviewJob } from '../../apps/worker/src/review/pipeline.js';
import { makeReviewJob } from './db/fixtures.js';
import { useTestDatabase } from './helpers/db.js';

const logger = createLogger({ name: 'agent-review-pipeline-test', level: 'silent' });

const HEAD_SHA = 'a'.repeat(40);
const BASE_SHA = 'b'.repeat(40);
const PATCH = '@@ -1,2 +1,3 @@\n context\n+const user = helper();\n context';

function basePullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    title: 'Add user lookup',
    body: 'Adds a lookup by id.',
    author: 'octocat',
    state: 'open',
    draft: false,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    baseRef: 'main',
    headRef: 'feature',
    additions: 3,
    deletions: 0,
    changedFiles: 1,
    ...overrides,
  };
}

const PR_FILES: PRFile[] = [
  {
    filename: 'src/user.ts',
    previousFilename: null,
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: PATCH,
  },
];

interface FakeClient extends GitHubClient {
  createReviewCalls: CreateReviewInput[];
}

function fakeClient(repoFiles: Record<string, string> = {}): FakeClient {
  const createReviewCalls: CreateReviewInput[] = [];
  return {
    createReviewCalls,
    getPullRequest: () => Promise.resolve(basePullRequest()),
    getPullRequestFiles: () => Promise.resolve(PR_FILES),
    getFileContent: (_ref, path) => Promise.resolve(repoFiles[path] ?? null),
    getRepositoryTree: () => Promise.reject(new Error('not used in this test')),
    listReviewBodies: () => Promise.resolve([]),
    createReview: (_ref, input) => {
      createReviewCalls.push(input);
      return Promise.resolve(999);
    },
    createIssueComment: () => Promise.resolve(1000),
  };
}

function fakeGithubApp(client: GitHubClient): GitHubApp {
  return {
    getInstallationClient: () => Promise.resolve(client),
    getRepositoryInstallationId: () => Promise.reject(new Error('not used in this test')),
  };
}

/** Never called: proves the agent path is taken instead of the one-shot fallback. */
function unusedModel(): ReviewModel {
  return { generateReview: () => Promise.reject(new Error('one-shot model should not be called')) };
}

/** Replays a fixed script of turns, ignoring message history - enough to drive the loop end to end. */
function scriptedAdapter(script: readonly AgentChatResult[]): AgentAdapter {
  let turn = 0;
  return {
    chat: () => {
      const response = script[Math.min(turn, script.length - 1)];
      turn += 1;
      if (!response) throw new Error('no scripted response left');
      return Promise.resolve(response);
    },
  };
}

const FINDING_OUTPUT: ModelReviewOutput = {
  summary: 'Found a real issue.',
  reviews: [
    {
      filename: 'src/user.ts',
      severity: 'high',
      start_line: 2,
      end_line: 2,
      issue: 'Missing null check.',
      fix_type: 'warning',
      suggested_code: null,
    },
  ],
};

describe('worker: processReviewJob (agent loop)', () => {
  const { db } = useTestDatabase();

  it('goes diff -> get_imports -> get_dependents -> get_file_content -> submit_review, posts the review, and records the agent run', async () => {
    const { repository, job } = await makeReviewJob(db, HEAD_SHA);
    await markRepositoryIndexed(db, repository.id, BASE_SHA);
    await replaceDependencyEdges(
      db,
      repository.id,
      BASE_SHA,
      ['src/other.ts'],
      [{ sourcePath: 'src/other.ts', targetPath: 'src/user.ts', resolved: true }],
    );

    const client = fakeClient({
      'src/user.ts': 'import { helper } from "./helper";\nexport const user = helper();\n',
    });
    const adapter = scriptedAdapter([
      { text: null, toolCalls: [{ id: '1', name: 'get_imports', args: { path: 'src/user.ts' } }] },
      {
        text: null,
        toolCalls: [{ id: '2', name: 'get_dependents', args: { path: 'src/user.ts' } }],
      },
      {
        text: null,
        toolCalls: [{ id: '3', name: 'get_file_content', args: { path: 'src/user.ts' } }],
      },
      { text: null, toolCalls: [{ id: '4', name: 'submit_review', args: FINDING_OUTPUT }] },
    ]);

    await processReviewJob(
      {
        db,
        githubApp: fakeGithubApp(client),
        model: unusedModel(),
        agentAdapter: adapter,
        provider: 'test-agent',
        modelName: 'test-agent-model',
        logger,
      },
      job.id,
    );

    const [jobRow] = await db.select().from(reviewJobs).where(eq(reviewJobs.id, job.id));
    expect(jobRow?.status).toBe('SUCCEEDED');
    expect(client.createReviewCalls).toHaveLength(1);

    const [reviewRow] = await db.select().from(reviews).where(eq(reviews.reviewJobId, job.id));
    expect(reviewRow).toMatchObject({
      status: 'SUCCEEDED',
      agentTurns: 4,
      toolCalls: 4,
      filesFetched: 1,
    });

    const [runRow] = await db.select().from(agentRuns).where(eq(agentRuns.reviewId, reviewRow!.id));
    expect(runRow).toMatchObject({
      status: 'SUCCEEDED',
      terminationReason: 'SUBMITTED',
      turnCount: 4,
    });

    const callRows = await db
      .select()
      .from(agentToolCalls)
      .where(eq(agentToolCalls.agentRunId, runRow!.id))
      .orderBy(asc(agentToolCalls.turnNumber));
    expect(callRows.map((c) => c.toolName)).toEqual([
      'get_imports',
      'get_dependents',
      'get_file_content',
      'submit_review',
    ]);
    expect(callRows.every((c) => c.status === 'SUCCEEDED')).toBe(true);
    // Metadata only - never the tool result text or fetched file content (DATA_MODEL.md).
    expect(callRows.every((c) => c.resultSizeBytes !== null)).toBe(true);
  });

  it('finalizes as FAILED with terminationReason MAX_TURNS when the model never submits, and posts nothing', async () => {
    const { repository, job } = await makeReviewJob(db, HEAD_SHA);
    await markRepositoryIndexed(db, repository.id, BASE_SHA);
    const client = fakeClient();
    const adapter = scriptedAdapter([
      { text: null, toolCalls: [{ id: '1', name: 'get_imports', args: { path: 'src/user.ts' } }] },
    ]);

    await processReviewJob(
      {
        db,
        githubApp: fakeGithubApp(client),
        model: unusedModel(),
        agentAdapter: adapter,
        provider: 'test-agent',
        modelName: 'test-agent-model',
        logger,
        maxTurns: 2,
      },
      job.id,
    );

    const [jobRow] = await db.select().from(reviewJobs).where(eq(reviewJobs.id, job.id));
    expect(jobRow).toMatchObject({ status: 'FAILED', errorCode: 'MAX_TURNS' });
    expect(client.createReviewCalls).toHaveLength(0);

    const [reviewRow] = await db.select().from(reviews).where(eq(reviews.reviewJobId, job.id));
    expect(reviewRow?.status).toBe('FAILED');

    const [runRow] = await db.select().from(agentRuns).where(eq(agentRuns.reviewId, reviewRow!.id));
    expect(runRow).toMatchObject({ status: 'FAILED', terminationReason: 'MAX_TURNS' });
  });

  it('survives a malformed tool call with missing args instead of crashing the job', async () => {
    const { repository, job } = await makeReviewJob(db, HEAD_SHA);
    await markRepositoryIndexed(db, repository.id, BASE_SHA);
    const client = fakeClient();
    // Gemini can omit `args` entirely for a function call with no parameters filled in.
    const adapter = scriptedAdapter([
      { text: null, toolCalls: [{ id: '1', name: 'get_file_content', args: undefined }] },
      { text: null, toolCalls: [{ id: '2', name: 'submit_review', args: FINDING_OUTPUT }] },
    ]);

    await processReviewJob(
      {
        db,
        githubApp: fakeGithubApp(client),
        model: unusedModel(),
        agentAdapter: adapter,
        provider: 'test-agent',
        modelName: 'test-agent-model',
        logger,
      },
      job.id,
    );

    const [jobRow] = await db.select().from(reviewJobs).where(eq(reviewJobs.id, job.id));
    expect(jobRow?.status).toBe('SUCCEEDED');
    expect(client.createReviewCalls).toHaveLength(1);

    const [reviewRow] = await db.select().from(reviews).where(eq(reviews.reviewJobId, job.id));
    const [runRow] = await db.select().from(agentRuns).where(eq(agentRuns.reviewId, reviewRow!.id));
    const callRows = await db
      .select()
      .from(agentToolCalls)
      .where(eq(agentToolCalls.agentRunId, runRow!.id))
      .orderBy(asc(agentToolCalls.turnNumber));
    expect(callRows).toHaveLength(2);
    expect(callRows[0]).toMatchObject({ toolName: 'get_file_content', status: 'REJECTED' });
    expect(callRows[0]?.argumentsJson).toEqual({});
    expect(callRows[1]).toMatchObject({ toolName: 'submit_review', status: 'SUCCEEDED' });
  });

  it('marks the job, review and agent run TIMED_OUT when the deadline elapses, and posts nothing', async () => {
    const { repository, job } = await makeReviewJob(db, HEAD_SHA);
    await markRepositoryIndexed(db, repository.id, BASE_SHA);
    const client = fakeClient();
    const hangingAdapter: AgentAdapter = {
      chat: (_messages, _tools, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    };

    await processReviewJob(
      {
        db,
        githubApp: fakeGithubApp(client),
        model: unusedModel(),
        agentAdapter: hangingAdapter,
        provider: 'test-agent',
        modelName: 'test-agent-model',
        logger,
        agentDeadlineMs: 20,
      },
      job.id,
    );

    const [jobRow] = await db.select().from(reviewJobs).where(eq(reviewJobs.id, job.id));
    expect(jobRow).toMatchObject({ status: 'TIMED_OUT', errorCode: 'TIMEOUT' });
    expect(client.createReviewCalls).toHaveLength(0);

    const [reviewRow] = await db.select().from(reviews).where(eq(reviews.reviewJobId, job.id));
    expect(reviewRow?.status).toBe('TIMED_OUT');

    const [runRow] = await db.select().from(agentRuns).where(eq(agentRuns.reviewId, reviewRow!.id));
    expect(runRow).toMatchObject({ status: 'TIMED_OUT', terminationReason: 'TIMEOUT' });
  });
});
