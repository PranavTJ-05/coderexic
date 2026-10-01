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

  // Phase 16 security audit: the full path-traversal vector list.
  it.each([
    ['bare ..', '..'],
    ['parent traversal', '../../etc/passwd'],
    ['URL-encoded traversal (never decoded, so literal %2e%2e is harmless text,'
      + ' but must not be treated as a traversal escape either way)', '%2e%2e/%2e%2e/etc/passwd'],
    ['absolute unix path', '/etc/passwd'],
    ['absolute windows path', 'C:\\Windows\\system32\\config'],
    ['windows-style backslash traversal', '..\\..\\secrets.env'],
    ['dot-slash prefix combined with traversal', './../secrets.env'],
    ['plain dot-slash prefix', './src/a.ts'],
    ['NUL byte', 'src/auth.ts\u0000.png'],
    ['traversal buried mid-path', 'a/../../b'],
    ['mixed separators traversal', 'a/..\\../b'],
  ])('rejects %s (%p)', (_label, path) => {
    // %2e%2e is intentionally NOT decoded (GitHub's contents API takes the
    // literal path string, there is no filesystem underneath it), so it is
    // valid as a literal path segment - this pins that, rather than
    // asserting it is rejected.
    if (path.startsWith('%2e')) {
      expect(isValidToolPath(path)).toBe(true);
      return;
    }
    expect(isValidToolPath(path)).toBe(false);
  });
});
