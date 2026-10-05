import { describe, expect, it } from 'vitest';
import { createSignatureFailureLimiter } from './signature-failure-limiter.js';

describe('createSignatureFailureLimiter', () => {
  it('is not blocked before any failures', () => {
    const limiter = createSignatureFailureLimiter();
    expect(limiter.isBlocked('1.2.3.4')).toBe(false);
  });

  it('blocks a key once it exceeds maxFailures within the window', () => {
    const limiter = createSignatureFailureLimiter({ maxFailures: 3, windowMs: 60_000 });
    expect(limiter.recordFailure('1.2.3.4')).toBe(false);
    expect(limiter.recordFailure('1.2.3.4')).toBe(false);
    expect(limiter.recordFailure('1.2.3.4')).toBe(false);
    expect(limiter.recordFailure('1.2.3.4')).toBe(true);
    expect(limiter.isBlocked('1.2.3.4')).toBe(true);
  });

  it('tracks each key independently', () => {
    const limiter = createSignatureFailureLimiter({ maxFailures: 1, windowMs: 60_000 });
    limiter.recordFailure('1.1.1.1');
    limiter.recordFailure('1.1.1.1');
    expect(limiter.isBlocked('1.1.1.1')).toBe(true);
    expect(limiter.isBlocked('2.2.2.2')).toBe(false);
  });

  it('resets once the window elapses', () => {
    let now = 0;
    const limiter = createSignatureFailureLimiter({
      maxFailures: 1,
      windowMs: 1000,
      now: () => now,
    });
    limiter.recordFailure('1.2.3.4');
    limiter.recordFailure('1.2.3.4');
    expect(limiter.isBlocked('1.2.3.4')).toBe(true);
    now += 1001;
    expect(limiter.isBlocked('1.2.3.4')).toBe(false);
    expect(limiter.recordFailure('1.2.3.4')).toBe(false);
  });
});
