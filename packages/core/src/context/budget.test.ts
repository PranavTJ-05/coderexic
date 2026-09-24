import { describe, expect, it } from 'vitest';
import { estimateTokens, TokenBudget, truncateToTokens } from './budget.js';

describe('estimateTokens', () => {
  it('estimates roughly one token per four characters', () => {
    expect(estimateTokens('a'.repeat(40))).toBe(10);
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1);
  });
});

describe('TokenBudget', () => {
  it('consumes and tracks remaining budget', () => {
    const budget = new TokenBudget(100);
    expect(budget.remaining).toBe(100);
    expect(budget.tryConsume(40)).toBe(true);
    expect(budget.remaining).toBe(60);
  });

  it('rejects and leaves the budget unchanged when it does not fit', () => {
    const budget = new TokenBudget(10);
    expect(budget.tryConsume(20)).toBe(false);
    expect(budget.remaining).toBe(10);
  });

  it('never reports negative remaining budget', () => {
    const budget = new TokenBudget(5);
    budget.tryConsume(5);
    expect(budget.remaining).toBe(0);
  });

  it('consumes text by its estimated token count', () => {
    const budget = new TokenBudget(10);
    expect(budget.tryConsumeText('a'.repeat(40))).toBe(true);
    expect(budget.remaining).toBe(0);
  });
});

describe('truncateToTokens', () => {
  it('leaves short text untouched', () => {
    expect(truncateToTokens('short', 100)).toBe('short');
  });

  it('truncates long text and appends a marker', () => {
    const text = 'line one\n'.repeat(100);
    const result = truncateToTokens(text, 10);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain('[truncated: exceeded the context budget]');
  });
});
