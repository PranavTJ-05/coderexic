import { describe, expect, it } from 'vitest';
import { hasReviewCommand } from './commands.js';

describe('hasReviewCommand', () => {
  it('matches the exact command on its own line', () => {
    expect(hasReviewCommand('/review review')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(hasReviewCommand('/Review Review')).toBe(true);
  });

  it('matches surrounded by other text on separate lines', () => {
    expect(hasReviewCommand('please take another look\n/review review\nthanks')).toBe(true);
  });

  it('tolerates surrounding whitespace on the command line', () => {
    expect(hasReviewCommand('   /review review   ')).toBe(true);
  });

  it('does not match a quoted (reply) line', () => {
    expect(hasReviewCommand('> /review review\nI agree')).toBe(false);
  });

  it('does not match a command embedded mid-sentence', () => {
    expect(hasReviewCommand('can you run /review review please')).toBe(false);
  });

  it('does not match an unrelated command', () => {
    expect(hasReviewCommand('/review status')).toBe(false);
  });

  it('does not match plain text', () => {
    expect(hasReviewCommand('looks good to me')).toBe(false);
  });

  it('does not match an empty body', () => {
    expect(hasReviewCommand('')).toBe(false);
  });

  it('does not match a command inside a fenced code block', () => {
    expect(hasReviewCommand('to trigger a review, comment:\n```\n/review review\n```')).toBe(false);
  });

  it('still matches a command after a closed fence', () => {
    expect(hasReviewCommand('```\nsome code\n```\n/review review')).toBe(true);
  });
});
