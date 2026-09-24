import { describe, expect, it } from 'vitest';
import type { GitHubClient } from '../github/types.js';
import {
  CONFIG_FILENAMES,
  loadRepositoryConfig,
  loadRepositoryRules,
  RULES_FILENAMES,
} from './loader.js';

const REF = { owner: 'octo', repo: 'demo' };
const SHA = 'a'.repeat(40);

function fakeClient(files: Record<string, string>): GitHubClient {
  return {
    getPullRequest: () => Promise.reject(new Error('not used')),
    getPullRequestFiles: () => Promise.reject(new Error('not used')),
    getRepositoryTree: () => Promise.reject(new Error('not used')),
    listReviewBodies: () => Promise.reject(new Error('not used')),
    createReview: () => Promise.reject(new Error('not used')),
    createIssueComment: () => Promise.reject(new Error('not used')),
    getFileContent: (_ref, path) => Promise.resolve(files[path] ?? null),
  };
}

function throwingClient(): GitHubClient {
  return {
    getPullRequest: () => Promise.reject(new Error('not used')),
    getPullRequestFiles: () => Promise.reject(new Error('not used')),
    getRepositoryTree: () => Promise.reject(new Error('not used')),
    listReviewBodies: () => Promise.reject(new Error('not used')),
    createReview: () => Promise.reject(new Error('not used')),
    createIssueComment: () => Promise.reject(new Error('not used')),
    getFileContent: () => Promise.reject(new Error('file too large')),
  };
}

describe('loadRepositoryConfig', () => {
  it('returns defaults when no config file exists', async () => {
    const result = await loadRepositoryConfig(fakeClient({}), REF, SHA);
    expect(result.warnings).toEqual([]);
    expect(result.minSeverity).toBeNull();
  });

  it('parses .coderexic.yml when present', async () => {
    const result = await loadRepositoryConfig(
      fakeClient({ '.coderexic.yml': 'min_severity: high\nignore:\n  - "*.gen.ts"\n' }),
      REF,
      SHA,
    );
    expect(result.minSeverity).toBe('high');
    expect(result.ignore).toEqual(['*.gen.ts']);
  });

  it('prefers .coderexic.yml over .verix.yml', async () => {
    expect(CONFIG_FILENAMES[0]).toBe('.coderexic.yml');
    const result = await loadRepositoryConfig(
      fakeClient({
        '.coderexic.yml': 'language: rust\n',
        '.verix.yml': 'language: python\n',
      }),
      REF,
      SHA,
    );
    expect(result.language).toBe('rust');
  });

  it('falls back to .verix.yml when .coderexic.yml is absent', async () => {
    const result = await loadRepositoryConfig(
      fakeClient({ '.verix.yml': 'language: python\n' }),
      REF,
      SHA,
    );
    expect(result.language).toBe('python');
  });

  it('returns defaults with a warning for invalid YAML instead of throwing', async () => {
    const result = await loadRepositoryConfig(
      fakeClient({ '.coderexic.yml': 'min_severity: [unterminated' }),
      REF,
      SHA,
    );
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.minSeverity).toBeNull();
  });

  it('returns defaults with a warning instead of throwing when the file cannot be read', async () => {
    const result = await loadRepositoryConfig(throwingClient(), REF, SHA);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

describe('loadRepositoryRules', () => {
  it('returns null when no rules file exists', async () => {
    expect(await loadRepositoryRules(fakeClient({}), REF, SHA)).toBeNull();
  });

  it('CODEREXIC.md ranks first', async () => {
    expect(RULES_FILENAMES[0]).toBe('CODEREXIC.md');
    const result = await loadRepositoryRules(
      fakeClient({ 'CODEREXIC.md': 'Focus on security.', 'AGENTS.md': 'Focus on style.' }),
      REF,
      SHA,
    );
    expect(result).toEqual({ filename: 'CODEREXIC.md', content: 'Focus on security.' });
  });

  it('falls through the precedence list to AGENTS.md', async () => {
    const result = await loadRepositoryRules(fakeClient({ 'AGENTS.md': 'Be thorough.' }), REF, SHA);
    expect(result).toEqual({ filename: 'AGENTS.md', content: 'Be thorough.' });
  });

  it('skips a blank rules file and keeps looking', async () => {
    const result = await loadRepositoryRules(
      fakeClient({ 'CODEREXIC.md': '   \n  ', 'AGENTS.md': 'Real rules.' }),
      REF,
      SHA,
    );
    expect(result?.filename).toBe('AGENTS.md');
  });

  it('treats an unreadable file as absent and keeps looking', async () => {
    expect(await loadRepositoryRules(throwingClient(), REF, SHA)).toBeNull();
  });
});
