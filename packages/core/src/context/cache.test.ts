import { describe, expect, it } from 'vitest';
import { ReviewContextCache } from './cache.js';

describe('ReviewContextCache', () => {
  it('stores and retrieves file content by path and sha', () => {
    const cache = new ReviewContextCache();
    expect(cache.hasFile('a.ts', 'sha1')).toBe(false);
    cache.setFile('a.ts', 'sha1', 'content');
    expect(cache.hasFile('a.ts', 'sha1')).toBe(true);
    expect(cache.getFile('a.ts', 'sha1')).toBe('content');
    expect(cache.fetchedFileCount).toBe(1);
  });

  it('treats the same path at a different sha as a different entry', () => {
    const cache = new ReviewContextCache();
    cache.setFile('a.ts', 'sha1', 'v1');
    expect(cache.hasFile('a.ts', 'sha2')).toBe(false);
  });

  it('caches a null result (file missing) distinctly from unfetched', () => {
    const cache = new ReviewContextCache();
    cache.setFile('a.ts', 'sha1', null);
    expect(cache.hasFile('a.ts', 'sha1')).toBe(true);
    expect(cache.getFile('a.ts', 'sha1')).toBeNull();
  });

  it('stores and retrieves arbitrary query results by key', () => {
    const cache = new ReviewContextCache();
    expect(cache.getQuery('edges')).toBeUndefined();
    cache.setQuery('edges', [1, 2, 3]);
    expect(cache.getQuery('edges')).toEqual([1, 2, 3]);
  });
});
