import { z } from 'zod';

/**
 * Zod schemas for the parts of GitHub webhook payloads Coderexic uses.
 * Payloads are untrusted input: unknown fields are dropped, and a payload
 * missing a required field fails validation instead of reaching handlers.
 */

const account = z.object({
  login: z.string().min(1),
  type: z.string().min(1),
});

const installationRef = z.object({ id: z.number().int().positive() });

const installationRepo = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  full_name: z.string().regex(/^[^/]+\/[^/]+$/),
});

const repository = installationRepo.extend({
  owner: account,
  default_branch: z.string().min(1),
});

const sha = z.string().regex(/^[0-9a-f]{40}$/);

export const installationEventSchema = z.object({
  action: z.string(),
  installation: installationRef.extend({ account }),
  repositories: z.array(installationRepo).optional(),
});

export const installationRepositoriesEventSchema = z.object({
  action: z.string(),
  installation: installationRef.extend({ account }),
  repositories_added: z.array(installationRepo),
  repositories_removed: z.array(installationRepo),
});

export const pullRequestEventSchema = z.object({
  action: z.string(),
  number: z.number().int().positive(),
  installation: installationRef,
  repository,
  pull_request: z.object({
    state: z.string(),
    draft: z.boolean().optional(),
    head: z.object({ sha }),
    base: z.object({ sha, ref: z.string() }),
  }),
});

export const pushEventSchema = z.object({
  ref: z.string(),
  after: sha,
  deleted: z.boolean(),
  installation: installationRef,
  repository,
});

export const issueCommentEventSchema = z.object({
  action: z.string(),
  installation: installationRef,
  repository,
  issue: z.object({
    number: z.number().int().positive(),
    state: z.string(),
    /** Present only when the issue is a pull request. */
    pull_request: z.object({}).optional(),
  }),
  comment: z.object({
    id: z.number().int().positive(),
    body: z.string(),
    user: account,
    /**
     * `.optional()`, not required: an absent value is treated as
     * unauthorized by the handler, not rejected as a bad payload.
     */
    author_association: z.string().optional(),
  }),
});

export type InstallationEvent = z.infer<typeof installationEventSchema>;
export type InstallationRepositoriesEvent = z.infer<typeof installationRepositoriesEventSchema>;
export type PullRequestEvent = z.infer<typeof pullRequestEventSchema>;
export type PushEvent = z.infer<typeof pushEventSchema>;
export type IssueCommentEvent = z.infer<typeof issueCommentEventSchema>;
export type WebhookRepository = z.infer<typeof repository>;
