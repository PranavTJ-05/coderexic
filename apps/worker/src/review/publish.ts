import type { BuiltReview, GitHubClient, Logger, PullRequest, RepoRef } from '@coderexic/core';
import { buildCreateReviewInput } from '@coderexic/core';

/**
 * Posts the review, degrading gracefully if GitHub rejects the inline
 * comments (PRODUCT_SPEC.md §10): retries with no comments, then falls
 * back to a plain PR comment. Returns an error message only if every
 * attempt failed.
 */
export async function publishReview(
  client: GitHubClient,
  ref: RepoRef,
  pr: PullRequest,
  reviewJobId: string,
  summary: string,
  built: BuiltReview,
  log: Logger,
): Promise<string | undefined> {
  const input = buildCreateReviewInput(reviewJobId, pr.number, pr.headSha, summary, built);

  try {
    await client.createReview(ref, input);
    return undefined;
  } catch (err) {
    log.warn({ err }, 'createReview with inline comments failed, retrying without comments');
  }

  if (input.comments.length > 0) {
    try {
      await client.createReview(ref, { ...input, comments: [] });
      return undefined;
    } catch (err) {
      log.warn({ err }, 'createReview without comments failed, falling back to an issue comment');
    }
  }

  try {
    await client.createIssueComment(ref, pr.number, input.body);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : 'unknown error publishing review';
  }
}
