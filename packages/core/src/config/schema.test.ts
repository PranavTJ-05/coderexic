import { describe, expect, it } from 'vitest';
import { CONFIG_LIMITS, EMPTY_REPOSITORY_CONFIG, parseRepositoryConfig } from './schema.js';

describe('parseRepositoryConfig', () => {
  it('returns defaults for an empty document', () => {
    expect(parseRepositoryConfig({})).toEqual(EMPTY_REPOSITORY_CONFIG);
  });

  it('returns defaults with a warning when the document is not a mapping', () => {
    const result = parseRepositoryConfig(['not', 'a', 'mapping']);
    expect(result.warnings).toHaveLength(1);
    expect(result.model).toBeNull();
  });

  it('parses every known field', () => {
    const result = parseRepositoryConfig({
      model: 'gemini',
      ignore: ['*.test.ts', 'dist/**'],
      min_severity: 'medium',
      language: 'typescript',
      depth: 3,
      max_files: 20,
    });
    expect(result).toMatchObject({
      model: 'gemini',
      ignore: ['*.test.ts', 'dist/**'],
      minSeverity: 'medium',
      language: 'typescript',
      depth: 3,
      maxFiles: 20,
      warnings: [],
    });
  });

  it('rejects an unsupported model provider with a warning, not a crash', () => {
    const result = parseRepositoryConfig({ model: 'openai' });
    expect(result.model).toBeNull();
    expect(result.warnings[0]).toContain('openai');
  });

  it('rejects an invalid min_severity with a warning', () => {
    const result = parseRepositoryConfig({ min_severity: 'urgent' });
    expect(result.minSeverity).toBeNull();
    expect(result.warnings[0]).toContain('urgent');
  });

  it('clamps depth to the system limits', () => {
    expect(parseRepositoryConfig({ depth: 0 }).depth).toBe(CONFIG_LIMITS.minDepth);
    expect(parseRepositoryConfig({ depth: 999 }).depth).toBe(CONFIG_LIMITS.maxDepth);
    expect(parseRepositoryConfig({ depth: 2.9 }).depth).toBe(2);
  });

  it('clamps max_files to the system limits', () => {
    expect(parseRepositoryConfig({ max_files: -5 }).maxFiles).toBe(CONFIG_LIMITS.minMaxFiles);
    expect(parseRepositoryConfig({ max_files: 10_000 }).maxFiles).toBe(CONFIG_LIMITS.maxMaxFiles);
  });

  it('reports a non-numeric depth as a warning and falls back for that field only', () => {
    const result = parseRepositoryConfig({ depth: 'deep', max_files: 5 });
    expect(result.depth).toBeNull();
    expect(result.maxFiles).toBe(5);
    expect(result.warnings[0]).toContain('depth');
  });

  it('ignores a non-array ignore field with a warning', () => {
    const result = parseRepositoryConfig({ ignore: 'dist/**' });
    expect(result.ignore).toEqual([]);
    expect(result.warnings[0]).toContain('ignore');
  });

  it('drops non-string entries and blanks from ignore, keeping valid ones', () => {
    const result = parseRepositoryConfig({ ignore: ['dist/**', '', '  '] });
    expect(result.ignore).toEqual(['dist/**']);
  });

  it('reports unknown keys as warnings without failing the rest of the document', () => {
    const result = parseRepositoryConfig({ min_severity: 'high', totally_made_up: true });
    expect(result.minSeverity).toBe('high');
    expect(result.warnings.some((w) => w.includes('totally_made_up'))).toBe(true);
  });
});
