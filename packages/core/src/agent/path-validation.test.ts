import { describe, expect, it } from 'vitest';
import { isValidToolPath } from './path-validation.js';

describe('isValidToolPath', () => {
  it('accepts an ordinary repo-relative path', () => {
    expect(isValidToolPath('src/auth.ts')).toBe(true);
    expect(isValidToolPath('a.ts')).toBe(true);
  });

  it('rejects an absolute path', () => {
    expect(isValidToolPath('/etc/passwd')).toBe(false);
    expect(isValidToolPath('\\Windows\\system32')).toBe(false);
    expect(isValidToolPath('C:/secrets.txt')).toBe(false);
  });

  it('rejects a path with a .. segment', () => {
    expect(isValidToolPath('../secrets.env')).toBe(false);
    expect(isValidToolPath('src/../../etc/passwd')).toBe(false);
  });

  it('rejects an empty or oversized path', () => {
    expect(isValidToolPath('')).toBe(false);
    expect(isValidToolPath('a'.repeat(1025))).toBe(false);
  });
});
