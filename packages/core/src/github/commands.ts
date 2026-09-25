/**
 * PRODUCT_SPEC.md §14's manual trigger: a PR comment containing `/review
 * review` on its own line queues a fresh review of the PR's current head.
 */
const COMMAND_LINE = /^\/review\s+review$/i;

const FENCE_LINE = /^```/;

/**
 * True if `commentBody` contains an unquoted, unfenced `/review review`
 * line. A line that starts with `>` (a quoted reply, e.g. GitHub's "Quote
 * reply") is skipped, so replying to an earlier command comment doesn't
 * re-trigger it. Lines inside a fenced code block (between a pair of
 * ` ``` ` lines) are also skipped, so a comment documenting the command
 * doesn't trigger it either.
 */
export function hasReviewCommand(commentBody: string): boolean {
  let inFence = false;
  for (const line of commentBody.split('\n')) {
    if (FENCE_LINE.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.trimStart().startsWith('>')) continue;
    if (COMMAND_LINE.test(line.trim())) return true;
  }
  return false;
}
