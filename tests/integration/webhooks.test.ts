import { randomUUID } from 'node:crypto';
import {
  createIndexQueue,
  createLogger,
  createReviewQueue,
  indexRuns,
  installations,
  repositories,
  reviewJobs,
  signWebhookPayload,
  webhookEvents,
} from '@coderexic/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../../apps/api/src/server.js';
import { useTestDatabase } from './helpers/db.js';
import { useTestRedis } from './helpers/redis.js';

const SECRET = 'integration-webhook-secret-0123';
const INSTALLATION_ID = 31_337;
const sha = (c: string) => c.repeat(40);

const owner = { login: 'octocat', type: 'User' };
const repository = {
  id: 1296269,
  name: 'hello-world',
  full_name: 'octocat/hello-world',
  owner,
  default_branch: 'main',
};

function installationCreated(repos = [repository]) {
  return {
    action: 'created',
    installation: { id: INSTALLATION_ID, account: owner },
    repositories: repos.map(({ id, name, full_name }) => ({ id, name, full_name })),
  };
}

function pullRequest(action: string, headSha = sha('a'), number = 12) {
  return {
    action,
    number,
    installation: { id: INSTALLATION_ID },
    repository,
    pull_request: {
      state: 'open',
      draft: false,
      head: { sha: headSha },
      base: { sha: sha('b'), ref: 'main' },
    },
  };
}

describe('POST /webhooks/github', () => {
  const database = useTestDatabase();
  const { db } = database;
  const redis = useTestRedis();
  const reviewQueue = createReviewQueue(redis);
  const indexQueue = createIndexQueue(redis);
  let app: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    app = await buildServer({
      logger: createLogger({ name: 'webhook-test', level: 'silent' }),
      database,
      webhookSecret: SECRET,
      reviewQueue,
      indexQueue,
    });
  });
  afterAll(async () => {
    await app.close();
    await reviewQueue.obliterate({ force: true });
    await reviewQueue.close();
    await indexQueue.obliterate({ force: true });
    await indexQueue.close();
  });

  function deliver(
    event: string,
    payload: unknown,
    options: { delivery?: string; signature?: string | null } = {},
  ) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': options.delivery ?? randomUUID(),
    };
    const signature =
      options.signature === undefined ? signWebhookPayload(SECRET, body) : options.signature;
    if (signature !== null) headers['x-hub-signature-256'] = signature;
    return app.inject({ method: 'POST', url: '/webhooks/github', headers, payload: body });
  }

  describe('authentication', () => {
    it('rejects a missing signature with 401 and records nothing', async () => {
      const res = await deliver('ping', { zen: 'hi' }, { signature: null });
      expect(res.statusCode).toBe(401);
      expect(await db.select().from(webhookEvents)).toEqual([]);
    });

    it('rejects a signature made with another secret', async () => {
      const body = JSON.stringify({ zen: 'hi' });
      const res = await deliver('ping', body, {
        signature: signWebhookPayload('wrong-secret-0123456789', body),
      });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a payload that was altered after signing', async () => {
      const signature = signWebhookPayload(SECRET, JSON.stringify({ zen: 'hi' }));
      const res = await deliver('ping', JSON.stringify({ zen: 'tampered' }), { signature });
      expect(res.statusCode).toBe(401);
    });

    it('rejects a request without GitHub event headers', async () => {
      const body = '{}';
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signWebhookPayload(SECRET, body),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a non-JSON content type', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/github',
        headers: { 'content-type': 'text/plain' },
        payload: 'hello',
      });
      expect(res.statusCode).toBe(415);
    });
  });

  it('acknowledges ping and records it as ignored', async () => {
    const res = await deliver(
      'ping',
      { zen: 'Keep it logically awesome.', hook_id: 1 },
      { delivery: 'ping-1' },
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ignored' });
    const [event] = await db.select().from(webhookEvents);
    expect(event).toMatchObject({
      githubEventId: 'ping-1',
      eventName: 'ping',
      deliveryStatus: 'IGNORED',
    });
  });

  it('accepts payloads larger than the default 1 MB body limit', async () => {
    const res = await deliver('ping', { zen: 'x'.repeat(2 * 1024 * 1024) });
    expect(res.statusCode).toBe(200);
  });

  describe('installation events', () => {
    it('installation.created stores the installation and its repositories', async () => {
      const second = { ...repository, id: 42, name: 'other', full_name: 'octocat/other' };
      const res = await deliver('installation', installationCreated([repository, second]));
      expect(res.json()).toEqual({ status: 'processed' });

      const [installation] = await db.select().from(installations);
      expect(installation).toMatchObject({
        githubInstallationId: INSTALLATION_ID,
        ownerLogin: 'octocat',
        ownerType: 'User',
      });
      const repos = await db.select().from(repositories);
      expect(repos.map((r) => r.fullName).sort()).toEqual(['octocat/hello-world', 'octocat/other']);
      const [event] = await db.select().from(webhookEvents);
      expect(event!.installationId).toBe(installation!.id);
    });

    it('installation_repositories adds and soft-removes repositories', async () => {
      await deliver('installation', installationCreated());
      const res = await deliver('installation_repositories', {
        action: 'added',
        installation: { id: INSTALLATION_ID, account: owner },
        repositories_added: [{ id: 77, name: 'new', full_name: 'octocat/new' }],
        repositories_removed: [
          { id: repository.id, name: repository.name, full_name: repository.full_name },
        ],
      });
      expect(res.statusCode).toBe(200);
      const repos = await db.select().from(repositories);
      const byName = Object.fromEntries(repos.map((r) => [r.name, r.removedAt]));
      expect(byName.new).toBeNull();
      expect(byName['hello-world']).toBeInstanceOf(Date);
    });

    it('installation.deleted soft-removes the installation and repositories', async () => {
      await deliver('installation', installationCreated());
      await deliver('installation', { ...installationCreated(), action: 'deleted' });
      const [installation] = await db.select().from(installations);
      expect(installation!.removedAt).toBeInstanceOf(Date);
      const [repo] = await db.select().from(repositories);
      expect(repo!.removedAt).toBeInstanceOf(Date);
    });
  });

  describe('pull_request events', () => {
    it('opened creates a pending automatic review job', async () => {
      const res = await deliver('pull_request', pullRequest('opened'), { delivery: 'pr-1' });
      expect(res.json()).toEqual({ status: 'processed' });
      const [job] = await db.select().from(reviewJobs);
      expect(job).toMatchObject({
        pullRequestNumber: 12,
        headSha: sha('a'),
        baseSha: sha('b'),
        triggerType: 'automatic',
        status: 'PENDING',
        githubEventId: 'pr-1',
      });
      const queued = await reviewQueue.getJob(job!.id);
      expect(queued?.data).toEqual({ reviewJobId: job!.id });
    });

    it('records the installation and repository if their events were missed', async () => {
      await deliver('pull_request', pullRequest('opened'));
      const [repo] = await db.select().from(repositories);
      expect(repo).toMatchObject({ fullName: 'octocat/hello-world', defaultBranch: 'main' });
      expect(await db.select().from(installations)).toHaveLength(1);
    });

    it('a redelivered event does not create a second job', async () => {
      const first = await deliver('pull_request', pullRequest('opened'), {
        delivery: 'same-delivery',
      });
      const again = await deliver('pull_request', pullRequest('opened'), {
        delivery: 'same-delivery',
      });
      expect(first.json()).toEqual({ status: 'processed' });
      expect(again.json()).toEqual({ status: 'duplicate' });
      expect(await db.select().from(reviewJobs)).toHaveLength(1);
      expect(await db.select().from(webhookEvents)).toHaveLength(1);
    });

    it('a different delivery for the same commit reuses the existing job', async () => {
      await deliver('pull_request', pullRequest('opened'));
      await deliver('pull_request', pullRequest('reopened'));
      expect(await db.select().from(reviewJobs)).toHaveLength(1);
    });

    it('synchronize with a new commit creates another job', async () => {
      await deliver('pull_request', pullRequest('opened', sha('a')));
      await deliver('pull_request', pullRequest('synchronize', sha('c')));
      const jobs = await db.select().from(reviewJobs);
      expect(jobs.map((j) => j.headSha).sort()).toEqual([sha('a'), sha('c')]);
    });

    it('a late event does not bring back an uninstalled installation', async () => {
      await deliver('installation', installationCreated());
      await deliver('installation', { ...installationCreated(), action: 'deleted' });
      const res = await deliver('pull_request', pullRequest('opened'));
      expect(res.json()).toEqual({ status: 'ignored' });
      const [installation] = await db.select().from(installations);
      expect(installation!.removedAt).toBeInstanceOf(Date);
      expect(await db.select().from(reviewJobs)).toEqual([]);
    });

    it('a late event does not bring back a deselected repository', async () => {
      await deliver('installation', installationCreated());
      await deliver('installation_repositories', {
        action: 'removed',
        installation: { id: INSTALLATION_ID, account: owner },
        repositories_added: [],
        repositories_removed: [
          { id: repository.id, name: repository.name, full_name: repository.full_name },
        ],
      });
      expect(
        (
          await deliver('push', {
            ref: 'refs/heads/main',
            after: sha('d'),
            deleted: false,
            installation: { id: INSTALLATION_ID },
            repository,
          })
        ).json(),
      ).toEqual({ status: 'ignored' });
      const [repo] = await db.select().from(repositories);
      expect(repo).toMatchObject({ headSha: null });
      expect(repo!.removedAt).toBeInstanceOf(Date);
    });

    it('reinstalling makes the repository reviewable again', async () => {
      await deliver('installation', installationCreated());
      await deliver('installation', { ...installationCreated(), action: 'deleted' });
      await deliver('installation', installationCreated());
      expect((await deliver('pull_request', pullRequest('opened'))).json()).toEqual({
        status: 'processed',
      });
    });

    it.each(['closed', 'labeled', 'edited'])('%s is ignored', async (action) => {
      const res = await deliver('pull_request', pullRequest(action));
      expect(res.json()).toEqual({ status: 'ignored' });
      expect(await db.select().from(reviewJobs)).toEqual([]);
    });

    it('a draft pull request is not reviewed', async () => {
      const payload = pullRequest('opened');
      payload.pull_request.draft = true;
      const res = await deliver('pull_request', payload);
      expect(res.json()).toEqual({ status: 'ignored' });
      expect(await db.select().from(reviewJobs)).toEqual([]);
    });

    it('ready_for_review starts a review, like opened', async () => {
      const res = await deliver('pull_request', pullRequest('ready_for_review'));
      expect(res.json()).toEqual({ status: 'processed' });
      expect(await db.select().from(reviewJobs)).toHaveLength(1);
    });

    it('a malformed payload returns 400 and is recorded as failed', async () => {
      const res = await deliver(
        'pull_request',
        { action: 'opened', number: 1 },
        { delivery: 'bad-1' },
      );
      expect(res.statusCode).toBe(400);
      const [event] = await db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.githubEventId, 'bad-1'));
      expect(event!.deliveryStatus).toBe('FAILED');
      expect(await db.select().from(reviewJobs)).toEqual([]);
    });

    it('a failed delivery is processed when GitHub redelivers it', async () => {
      await deliver('pull_request', { action: 'opened', number: 1 }, { delivery: 'retry-1' });
      const res = await deliver('pull_request', pullRequest('opened'), { delivery: 'retry-1' });
      expect(res.json()).toEqual({ status: 'processed' });
      expect(await db.select().from(reviewJobs)).toHaveLength(1);
    });
  });

  describe('push events', () => {
    const push = (ref: string, deleted = false) => ({
      ref,
      after: sha('d'),
      deleted,
      installation: { id: INSTALLATION_ID },
      repository,
    });

    it('a push to the default branch records the new head commit and starts an index run', async () => {
      const res = await deliver('push', push('refs/heads/main'));
      expect(res.json()).toEqual({ status: 'processed' });
      const [repo] = await db.select().from(repositories);
      expect(repo!.headSha).toBe(sha('d'));

      const [run] = await db.select().from(indexRuns).where(eq(indexRuns.repositoryId, repo!.id));
      expect(run).toMatchObject({ commitSha: sha('d'), status: 'PENDING' });
      const job = await indexQueue.getJob(run!.id);
      expect(job?.data).toEqual({ indexRunId: run!.id });
    });

    it('a redelivered push for the same commit does not start a second index run', async () => {
      const payload = push('refs/heads/main');
      await deliver('push', payload);
      await deliver('push', payload, { delivery: randomUUID() });
      const [repo] = await db.select().from(repositories);
      const runs = await db.select().from(indexRuns).where(eq(indexRuns.repositoryId, repo!.id));
      expect(runs).toHaveLength(1);
    });

    it('pushes to other branches and branch deletions are ignored', async () => {
      expect((await deliver('push', push('refs/heads/feature'))).json()).toEqual({
        status: 'ignored',
      });
      expect((await deliver('push', push('refs/heads/main', true))).json()).toEqual({
        status: 'ignored',
      });
      expect(await db.select().from(repositories)).toEqual([]);
    });
  });

  describe('issue_comment events', () => {
    function issueComment(overrides: {
      action?: string;
      issueNumber?: number;
      issueState?: string;
      isPullRequest?: boolean;
      body?: string;
      authorAssociation?: string;
      userType?: string;
    }) {
      return {
        action: overrides.action ?? 'created',
        installation: { id: INSTALLATION_ID },
        repository,
        issue: {
          number: overrides.issueNumber ?? 12,
          state: overrides.issueState ?? 'open',
          ...((overrides.isPullRequest ?? true) ? { pull_request: {} } : {}),
        },
        comment: {
          id: 5,
          body: overrides.body ?? '/review review',
          user: { login: 'commenter', type: overrides.userType ?? 'User' },
          ...(overrides.authorAssociation !== undefined && {
            author_association: overrides.authorAssociation,
          }),
        },
      };
    }

    it('an authorized command creates a manual review job', async () => {
      const res = await deliver('issue_comment', issueComment({ authorAssociation: 'OWNER' }));
      expect(res.json()).toEqual({ status: 'processed' });
      const jobs = await db.select().from(reviewJobs);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        triggerType: 'manual',
        pullRequestNumber: 12,
        status: 'PENDING',
      });
    });

    it('a comment with no command is recorded without starting a review', async () => {
      const res = await deliver(
        'issue_comment',
        issueComment({ body: 'looks good to me', authorAssociation: 'OWNER' }),
      );
      expect(res.json()).toEqual({ status: 'ignored' });
      expect(await db.select().from(reviewJobs)).toEqual([]);
    });

    it('a comment not on a pull request is ignored', async () => {
      const res = await deliver(
        'issue_comment',
        issueComment({ isPullRequest: false, authorAssociation: 'OWNER' }),
      );
      expect(res.json()).toEqual({ status: 'ignored' });
      expect(await db.select().from(reviewJobs)).toEqual([]);
    });

    it('a command on a closed pull request is ignored', async () => {
      const res = await deliver(
        'issue_comment',
        issueComment({ issueState: 'closed', authorAssociation: 'OWNER' }),
      );
      expect(res.json()).toEqual({ status: 'ignored' });
      expect(await db.select().from(reviewJobs)).toEqual([]);
    });

    it('an edited comment does not re-trigger a review', async () => {
      const res = await deliver(
        'issue_comment',
        issueComment({ action: 'edited', authorAssociation: 'OWNER' }),
      );
      expect(res.json()).toEqual({ status: 'ignored' });
      expect(await db.select().from(reviewJobs)).toEqual([]);
    });

    it('an unauthorized commenter is silently ignored, no review job', async () => {
      const res = await deliver(
        'issue_comment',
        issueComment({ authorAssociation: 'CONTRIBUTOR' }),
      );
      expect(res.json()).toEqual({ status: 'ignored' });
      expect(await db.select().from(reviewJobs)).toEqual([]);
    });

    it('a missing author_association is treated as unauthorized', async () => {
      const res = await deliver('issue_comment', issueComment({}));
      expect(res.json()).toEqual({ status: 'ignored' });
      expect(await db.select().from(reviewJobs)).toEqual([]);
    });

    it('a bot commenter is ignored even with an authorized association', async () => {
      const res = await deliver(
        'issue_comment',
        issueComment({ authorAssociation: 'OWNER', userType: 'Bot' }),
      );
      expect(res.json()).toEqual({ status: 'ignored' });
      expect(await db.select().from(reviewJobs)).toEqual([]);
    });

    it('a second authorized command while one is already in flight is ignored', async () => {
      const first = await deliver('issue_comment', issueComment({ authorAssociation: 'OWNER' }));
      expect(first.json()).toEqual({ status: 'processed' });
      const second = await deliver('issue_comment', issueComment({ authorAssociation: 'MEMBER' }));
      expect(second.json()).toEqual({ status: 'ignored' });
      expect(await db.select().from(reviewJobs)).toHaveLength(1);
    });

    it('a stale RUNNING row past the active-job window does not block a new command', async () => {
      const first = await deliver('issue_comment', issueComment({ authorAssociation: 'OWNER' }));
      expect(first.json()).toEqual({ status: 'processed' });
      const [stale] = await db.select().from(reviewJobs);
      await db
        .update(reviewJobs)
        .set({ status: 'RUNNING', createdAt: new Date(Date.now() - 31 * 60 * 1000) })
        .where(eq(reviewJobs.id, stale!.id));

      const second = await deliver('issue_comment', issueComment({ authorAssociation: 'MEMBER' }));
      expect(second.json()).toEqual({ status: 'processed' });
      expect(await db.select().from(reviewJobs)).toHaveLength(2);
    });

    it('a redelivered command is acknowledged as a duplicate, not a second job', async () => {
      const deliveryId = randomUUID();
      const payload = issueComment({ authorAssociation: 'OWNER' });
      await deliver('issue_comment', payload, { delivery: deliveryId });
      const redelivered = await deliver('issue_comment', payload, { delivery: deliveryId });
      expect(redelivered.json()).toEqual({ status: 'duplicate' });
      expect(await db.select().from(reviewJobs)).toHaveLength(1);
    });
  });
});
