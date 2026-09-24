/**
 * Context token budget (AI_AGENT_SPEC.md §17). A chars/4 estimate, not a
 * real tokenizer: model-exact tokenization would mean adding and justifying
 * (ARCHITECTURE.md §22) a provider-specific dependency for a number that's
 * only ever used as a soft cap, never billed or shown to a person.
 */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Tracks remaining budget across a review's diff, system prompt, rules,
 * tool results and conversation history (§17's five inputs) as they're
 * added. Never goes negative; a request bigger than what's left is
 * rejected outright rather than silently overspending.
 */
export class TokenBudget {
  private used = 0;

  constructor(readonly totalTokens: number) {}

  get remaining(): number {
    return Math.max(0, this.totalTokens - this.used);
  }

  /** True and accounted for if it fits; false and unchanged if it doesn't. */
  tryConsume(tokens: number): boolean {
    if (tokens > this.remaining) return false;
    this.used += tokens;
    return true;
  }

  tryConsumeText(text: string): boolean {
    return this.tryConsume(estimateTokens(text));
  }
}

/** Truncates text to fit within a token count, preferring to cut cleanly at a line boundary. */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  const truncated = text.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf('\n');
  const cut = lastNewline > maxChars * 0.5 ? truncated.slice(0, lastNewline) : truncated;
  return `${cut}\n... [truncated: exceeded the context budget]`;
}
