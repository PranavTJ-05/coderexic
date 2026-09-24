import { describe, expect, it } from 'vitest';
import { parseTsConfigAliases, resolveTsAliasCandidate } from './tsconfig.js';

describe('parseTsConfigAliases', () => {
  it('reads baseUrl and paths, tolerating comments and trailing commas', () => {
    const text = `{
      // a comment
      "compilerOptions": {
        "baseUrl": ".",
        "paths": { "@/*": ["src/*"], },
      },
    }`;
    expect(parseTsConfigAliases(text)).toEqual({ baseUrl: '.', paths: { '@/*': ['src/*'] } });
  });

  it('returns empty aliases for invalid JSON', () => {
    expect(parseTsConfigAliases('{ not json')).toEqual({ baseUrl: null, paths: {} });
  });

  it('returns empty aliases when compilerOptions is absent', () => {
    expect(parseTsConfigAliases('{}')).toEqual({ baseUrl: null, paths: {} });
  });
});

describe('resolveTsAliasCandidate', () => {
  it('expands a wildcard path pattern', () => {
    const candidates = resolveTsAliasCandidate('@/lib/foo', {
      baseUrl: null,
      paths: { '@/*': ['src/*'] },
    });
    expect(candidates).toEqual(['src/lib/foo']);
  });

  it('matches an exact (non-wildcard) pattern', () => {
    const candidates = resolveTsAliasCandidate('shared', {
      baseUrl: null,
      paths: { shared: ['src/shared/index.ts'] },
    });
    expect(candidates).toEqual(['src/shared/index.ts']);
  });

  it('falls back to baseUrl when no path pattern matches', () => {
    const candidates = resolveTsAliasCandidate('lib/foo', { baseUrl: 'src', paths: {} });
    expect(candidates).toEqual(['src/lib/foo']);
  });

  it('returns nothing for a relative import (never alias-resolved)', () => {
    expect(resolveTsAliasCandidate('./foo', { baseUrl: 'src', paths: {} })).toEqual([]);
  });
});
