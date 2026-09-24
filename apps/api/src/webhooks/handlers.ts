import {
  automaticReviewKey,
  createReviewJob,
  findInstallationByGithubId,
  findRepository,
  installationEventSchema,
  installationRepositoriesEventSchema,
  issueCommentEventSchema,
  markInstallationRemoved,
  markRepositoriesRemoved,
  pullRequestEventSchema,
  pushEventSchema,
  updateRepositoryHead,
  upsertInstallation,
  upsertRepository,
  type Executor,
  type Installation,
  type Repository,
  type WebhookRepository,
} from '@coderexic/core';
import type { FastifyBaseLogger } from 'fastify';
import type { z } from 'zod';

export interface WebhookContext {
  db: Executor;
  log: FastifyBaseLogger;
  deliveryId: string;
}

export interface WebhookOutcome {
  status: 'PROCESSED' | 'IGNORED';
  /** Internal installation ID, linked to the stored delivery. */
  installationId?: string;
  reason?: string;
}

/** The payload passed signature checks but does not match the expected shape. */
export class WebhookPayloadError extends Error {
  constructor(readonly eventName: string) {
    super(`invalid ${eventName} payload`);
    this.name = 'WebhookPayloadError';
  }
}

/** Pull request actions that start an automatic review. */
export const REVIEW_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

function parse<T extends z.ZodType>(schema: T, eventName: string, payload: unknown): z.infer<T> {
  const result = schema.safeParse(payload);
  if (!result.success) throw new WebhookPayloadError(eventName);
  return result.data;
}

const ignored = (reason: string, installationId?: string): WebhookOutcome => ({
  status: 'IGNORED',
  reason,
  ...(installationId !== undefined && { installationId }),
});

function ownerOf(fullName: string): string {
  return fullName.slice(0, fullName.indexOf('/'));
}

async function syncRepository(
  db: Executor,
  installation: Installation,
  repository: WebhookRepository,
): Promise<Repository> {
  return upsertRepository(db, {
    installationId: installation.id,
    githubRepositoryId: repository.id,
    fullName: repository.full_name,
    ownerLogin: repository.owner.login,
    name: repository.name,
    defaultBranch: repository.default_branch,
  });
}

/**
 * Resolves the installation and repository a repository event belongs to.
 * Records them if their own events were missed, but returns undefined for
 * an uninstalled installation or a deselected repository, so a late or
 * redelivered event never brings them back.
 */
async function activeRepository(
  db: Executor,
  githubInstallationId: number,
  repository: WebhookRepository,
): Promise<{ installation: Installation; repository: Repository } | undefined> {
  const known = await findInstallationByGithubId(db, githubInstallationId);
  if (known?.removedAt) return undefined;
  const installation =
    known ??
    (await upsertInstallation(db, {
      githubInstallationId,
      ownerType: repository.owner.type,
      ownerLogin: repository.owner.login,
    }));
  const knownRepo = await findRepository(db, installation.id, repository.id);
  if (knownRepo?.removedAt) return undefined;
  return { installation, repository: await syncRepository(db, installation, repository) };
}

async function onInstallation(ctx: WebhookContext, payload: unknown): Promise<WebhookOutcome> {
  const event = parse(installationEventSchema, 'installation', payload);
  const githubInstallationId = event.installation.id;
  switch (event.action) {
    case 'created':
    case 'new_permissions_accepted':
    case 'unsuspend': {
      const installation = await upsertInstallation(ctx.db, {
        githubInstallationId,
        ownerType: event.installation.account.type,
        ownerLogin: event.installation.account.login,
      });
      for (const repo of event.repositories ?? []) {
        await upsertRepository(ctx.db, {
          installationId: installation.id,
          githubRepositoryId: repo.id,
          fullName: repo.full_name,
          ownerLogin: ownerOf(repo.full_name),
          name: repo.name,
        });
      }
      ctx.log.info(
        { githubInstallationId, repositories: event.repositories?.length ?? 0 },
        'installation synced',
      );
      return { status: 'PROCESSED', installationId: installation.id };
    }
    case 'deleted': {
      const installation = await markInstallationRemoved(ctx.db, githubInstallationId);
      ctx.log.info({ githubInstallationId }, 'installation removed');
      return installation
        ? { status: 'PROCESSED', installationId: installation.id }
        : ignored('unknown installation');
    }
    default:
      return ignored(`installation.${event.action} not handled`);
  }
}

async function onInstallationRepositories(
  ctx: WebhookContext,
  payload: unknown,
): Promise<WebhookOutcome> {
  const event = parse(installationRepositoriesEventSchema, 'installation_repositories', payload);
  const installation = await upsertInstallation(ctx.db, {
    githubInstallationId: event.installation.id,
    ownerType: event.installation.account.type,
    ownerLogin: event.installation.account.login,
  });
  for (const repo of event.repositories_added) {
    await upsertRepository(ctx.db, {
      installationId: installation.id,
      githubRepositoryId: repo.id,
      fullName: repo.full_name,
      ownerLogin: ownerOf(repo.full_name),
      name: repo.name,
    });
  }
  const removed = await markRepositoriesRemoved(
    ctx.db,
    installation.id,
    event.repositories_removed.map((repo) => repo.id),
  );
  ctx.log.info(
    {
      githubInstallationId: event.installation.id,
      added: event.repositories_added.length,
      removed,
    },
    'installation repositories synced',
  );
  return { status: 'PROCESSED', installationId: installation.id };
}

async function onPullRequest(ctx: WebhookContext, payload: unknown): Promise<WebhookOutcome> {
  const event = parse(pullRequestEventSchema, 'pull_request', payload);
  if (!REVIEW_ACTIONS.has(event.action))
    return ignored(`pull_request.${event.action} not reviewed`);
  if (event.pull_request.state !== 'open') return ignored('pull request is not open');

  const active = await activeRepository(ctx.db, event.installation.id, event.repository);
  if (!active) return ignored('installation or repository was removed');
  const { installation, repository } = active;
  const headSha = event.pull_request.head.sha;
  const { job, created } = await createReviewJob(ctx.db, {
    repositoryId: repository.id,
    installationId: installation.id,
    pullRequestNumber: event.number,
    headSha,
    baseSha: event.pull_request.base.sha,
    triggerType: 'automatic',
    idempotencyKey: automaticReviewKey(repository.id, event.number, headSha),
    githubEventId: ctx.deliveryId,
  });
  ctx.log.info(
    {
      reviewJobId: job.id,
      repository: repository.fullName,
      pullRequest: event.number,
      headSha,
      created,
    },
    created ? 'review job created' : 'review job already exists',
  );
  return { status: 'PROCESSED', installationId: installation.id };
}

async function onPush(ctx: WebhookContext, payload: unknown): Promise<WebhookOutcome> {
  const event = parse(pushEventSchema, 'push', payload);
  if (event.deleted) return ignored('branch deleted');
  if (event.ref !== `refs/heads/${event.repository.default_branch}`) {
    return ignored('push is not to the default branch');
  }
  const active = await activeRepository(ctx.db, event.installation.id, event.repository);
  if (!active) return ignored('installation or repository was removed');
  const { installation, repository } = active;
  await updateRepositoryHead(ctx.db, repository.id, event.after);
  ctx.log.info(
    { repository: repository.fullName, headSha: event.after },
    'default branch head updated',
  );
  return { status: 'PROCESSED', installationId: installation.id };
}

function onIssueComment(_ctx: WebhookContext, payload: unknown): Promise<WebhookOutcome> {
  const event = parse(issueCommentEventSchema, 'issue_comment', payload);
  if (!event.issue.pull_request)
    return Promise.resolve(ignored('comment is not on a pull request'));
  // Manual review commands (`/review review`) are handled in Phase 12.
  return Promise.resolve(
    ignored(`issue_comment.${event.action} recorded; commands not handled yet`),
  );
}

const HANDLERS: Record<string, (ctx: WebhookContext, payload: unknown) => Promise<WebhookOutcome>> =
  {
    installation: onInstallation,
    installation_repositories: onInstallationRepositories,
    pull_request: onPullRequest,
    push: onPush,
    issue_comment: onIssueComment,
  };

/**
 * Applies one verified webhook event to the database. Runs inside the
 * caller's transaction and makes no GitHub API calls, so it stays fast.
 */
export async function handleWebhookEvent(
  ctx: WebhookContext,
  eventName: string,
  payload: unknown,
): Promise<WebhookOutcome> {
  const handler = HANDLERS[eventName];
  return handler ? handler(ctx, payload) : ignored(`event ${eventName} not handled`);
}
