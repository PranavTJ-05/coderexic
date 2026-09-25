import {
  ACTIVE_JOB_WINDOW_MS,
  automaticReviewKey,
  createIndexRun,
  createReviewJob,
  findActiveReviewJob,
  findInstallationByGithubId,
  findRepository,
  hasReviewCommand,
  installationEventSchema,
  installationRepositoriesEventSchema,
  issueCommentEventSchema,
  manualReviewKey,
  markInstallationRemoved,
  markRepositoriesRemoved,
  pullRequestEventSchema,
  pushEventSchema,
  updateRepositoryHead,
  upsertInstallation,
  upsertRepository,
  ZERO_SHA,
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
  /** Set when this event created or matched a review job, so the route can enqueue it. */
  reviewJobId?: string;
  /** Set when this event started an index run, so the route can enqueue it. */
  indexRunId?: string;
}

/** The payload passed signature checks but does not match the expected shape. */
export class WebhookPayloadError extends Error {
  constructor(readonly eventName: string) {
    super(`invalid ${eventName} payload`);
    this.name = 'WebhookPayloadError';
  }
}

/** Pull request actions that start an automatic review. */
export const REVIEW_ACTIONS = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);

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
  if (event.pull_request.draft) return ignored('pull request is a draft');

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
  return { status: 'PROCESSED', installationId: installation.id, reviewJobId: job.id };
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
  // Only the default branch reaches here (checked above), and its new commit is already
  // known from the webhook payload, so this needs no GitHub API call to start indexing
  // (webhook handlers only write to the database - see AGENTS.md's GitHub client rule).
  const indexRun = await createIndexRun(ctx.db, repository.id, event.after);
  ctx.log.info(
    { repository: repository.fullName, headSha: event.after, indexRunId: indexRun.id },
    'default branch head updated; index run started',
  );
  return { status: 'PROCESSED', installationId: installation.id, indexRunId: indexRun.id };
}

/** GitHub's collaboration-level associations authorized to trigger a manual review. */
const AUTHORIZED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

async function onIssueComment(ctx: WebhookContext, payload: unknown): Promise<WebhookOutcome> {
  const event = parse(issueCommentEventSchema, 'issue_comment', payload);
  if (event.action !== 'created') return ignored(`issue_comment.${event.action} not handled`);
  if (!event.issue.pull_request) return ignored('comment is not on a pull request');
  if (event.issue.state !== 'open') return ignored('pull request is not open');
  if (!hasReviewCommand(event.comment.body)) return ignored('no recognized command');
  // A bot (including this app itself) can never trigger a review, regardless
  // of author_association.
  if (event.comment.user.type === 'Bot') return ignored('comment author is a bot');
  if (
    !event.comment.author_association ||
    !AUTHORIZED_ASSOCIATIONS.has(event.comment.author_association)
  ) {
    // Silently ignored, not a rejection reply - replying would let anyone
    // make the bot post on a PR it wouldn't otherwise touch.
    return ignored('commenter is not authorized to trigger a review');
  }

  const active = await activeRepository(ctx.db, event.installation.id, event.repository);
  if (!active) return ignored('installation or repository was removed');
  const { installation, repository } = active;

  const inFlight = await findActiveReviewJob(
    ctx.db,
    repository.id,
    event.issue.number,
    new Date(Date.now() - ACTIVE_JOB_WINDOW_MS),
  );
  if (inFlight) return ignored('a review is already queued or running for this pull request');

  // headSha is a placeholder (ZERO_SHA): this handler never calls the
  // GitHub API, so the real head sha isn't known yet. The worker resolves
  // it via updateReviewJobHeadSha once it fetches the pull request.
  const { job, created } = await createReviewJob(ctx.db, {
    repositoryId: repository.id,
    installationId: installation.id,
    pullRequestNumber: event.issue.number,
    headSha: ZERO_SHA,
    triggerType: 'manual',
    idempotencyKey: manualReviewKey(ctx.deliveryId),
    githubEventId: ctx.deliveryId,
  });
  ctx.log.info(
    {
      reviewJobId: job.id,
      repository: repository.fullName,
      pullRequest: event.issue.number,
      created,
    },
    created ? 'manual review job created' : 'manual review job already exists',
  );
  return { status: 'PROCESSED', installationId: installation.id, reviewJobId: job.id };
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
