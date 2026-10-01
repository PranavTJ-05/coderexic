import { describe, expect, it } from 'vitest';
import { neutralizeMentions } from './mention-guard.js';

describe('neutralizeMentions', () => {
  it('inserts a zero-width space after a plain user mention', () => {
    const result = neutralizeMentions('cc @someuser please review');
    expect(result).toBe('cc @​someuser please review');
    expect(result).not.toContain('@someuser');
  });

  it('neutralizes an org/team mention', () => {
    const result = neutralizeMentions('ping @someorg/some-team about this');
    expect(result).toBe('ping @​someorg/some-team about this');
  });

  it('neutralizes multiple mentions in the same text', () => {
    const result = neutralizeMentions('@alice and @bob should look at this');
    expect(result).toBe('@​alice and @​bob should look at this');
  });

  it('leaves text with no @ untouched', () => {
    expect(neutralizeMentions('nothing to see here')).toBe('nothing to see here');
  });

  it('does not touch an @ inside inline code (a decorator or annotation)', () => {
    const result = neutralizeMentions('the `@Component` decorator is missing');
    expect(result).toBe('the `@Component` decorator is missing');
  });

  it('does not touch an @ inside a fenced code block', () => {
    const text = 'see:\n```\n@property var x: Int\n```\nfor the fix';
    expect(neutralizeMentions(text)).toBe(text);
  });

  it('still neutralizes a mention outside a code span in the same string', () => {
    const result = neutralizeMentions('`@Component` is fine but ping @someorg/team too');
    expect(result).toBe('`@Component` is fine but ping @​someorg/team too');
  });

  it('does not alter an email-shaped string beyond the leading @ segment', () => {
    // Not a real mention case this app ever emits, but confirms the pattern
    // only ever touches text immediately after `@`.
    const result = neutralizeMentions('contact user@example.com');
    expect(result).toBe('contact user@​example.com');
  });
});
