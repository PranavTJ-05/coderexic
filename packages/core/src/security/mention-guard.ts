/**
 * Neutralizes GitHub `@mentions` in model-authored text before it is posted
 * as a review comment (ROADMAP.md Phase 16). A review is posted *as the
 * GitHub App*, so an unneutralized `@org/team` or `@user` the model copies
 * or invents (e.g. from a prompt-injection attempt in repo content) would
 * actually ping real people - this is a real finding, not a hypothetical
 * one (AI_AGENT_SPEC.md §13's untrusted-input boundary covers tool output,
 * not what the model is later allowed to make us post).
 *
 * A zero-width space is inserted right after `@`, which GitHub renders as
 * plain text (no notification, no link) while remaining visually almost
 * identical to the original mention - the same trick `llm/prompt.ts`'s
 * `escapeRulesFence` uses for fence delimiters, applied to `@` instead.
 *
 * Only text outside backtick-delimited code spans is touched: GitHub never
 * sends mention notifications for `@` inside inline code or a fenced code
 * block, and this content can legitimately contain `@Something`-shaped
 * code (decorators, annotations, npm scopes) that must reach the comment
 * unmodified.
 */
const ZERO_WIDTH_SPACE = '​';

const MENTION_PATTERN =
  /@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)?)/g;

const CODE_SPAN_PATTERN = /```[\s\S]*?```|``[^`]*``|`[^`\n]*`/g;

function neutralizeOutsideCode(segment: string): string {
  return segment.replace(MENTION_PATTERN, `@${ZERO_WIDTH_SPACE}$1`);
}

export function neutralizeMentions(text: string): string {
  if (!text.includes('@')) return text;
  let result = '';
  let lastIndex = 0;
  for (const match of text.matchAll(CODE_SPAN_PATTERN)) {
    const start = match.index;
    result += neutralizeOutsideCode(text.slice(lastIndex, start));
    result += match[0];
    lastIndex = start + match[0].length;
  }
  result += neutralizeOutsideCode(text.slice(lastIndex));
  return result;
}
