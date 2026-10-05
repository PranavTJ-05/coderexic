import { describe, expect, it, vi } from 'vitest';
import { isTransientDbError, withDbRetry } from './retry.js';

function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`pg error ${code}`), { code });
}

describe('isTransientDbError', () => {
  it.each(['08000', '08001', '08003', '08004', '08006', '40001', '40P01', '53300', '57P01'])(
    'treats SQLSTATE %s as transient',
    (code) => {
      expect(isTransientDbError(pgError(code))).toBe(true);
    },
  );

  it.each(['23505', '22P02', '42601', '42703'])(
    'treats SQLSTATE %s (constraint/syntax/input errors) as permanent',
    (code) => {
      expect(isTransientDbError(pgError(code))).toBe(false);
    },
  );

  it('is false for a plain Error with no code', () => {
    expect(isTransientDbError(new Error('boom'))).toBe(false);
  });

  it('is false for non-object values', () => {
    expect(isTransientDbError('boom')).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
  });
});

describe('withDbRetry', () => {
  it('returns the result on the first try without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withDbRetry(fn, { baseDelayMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure and succeeds once it clears', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(pgError('08006'))
      .mockRejectedValueOnce(pgError('08006'))
      .mockResolvedValueOnce('ok');

    await expect(withDbRetry(fn, { baseDelayMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('gives up and rethrows once retries are exhausted', async () => {
    const err = pgError('40P01');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withDbRetry(fn, { retries: 2, baseDelayMs: 1 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('never retries a non-transient error', async () => {
    const err = pgError('23505');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withDbRetry(fn, { baseDelayMs: 1 })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
