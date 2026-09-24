import { parse as parseYaml } from 'yaml';
import type { GitHubClient, RepoRef } from '../github/types.js';
import {
  EMPTY_REPOSITORY_CONFIG,
  parseRepositoryConfig,
  type ParsedRepositoryConfig,
} from './schema.js';

/** First match wins; Coderexic's own filename ranks first (PRODUCT_SPEC.md §11). */
export const CONFIG_FILENAMES = ['.coderexic.yml', '.verix.yml'] as const;

/** First match wins; Coderexic's own filenames rank first (PRODUCT_SPEC.md §11). */
export const RULES_FILENAMES = [
  'CODEREXIC.md',
  'VERIX.md',
  '.verix.md',
  'CLAUDE.md',
  'AGENTS.md',
  '.cursorrules',
] as const;

const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_RULES_BYTES = 64 * 1024;

/** Bounds YAML alias expansion explicitly, against a billion-laughs style config. */
const YAML_PARSE_OPTIONS = { maxAliasCount: 100 } as const;

export interface RepositoryRulesFile {
  filename: string;
  content: string;
}

/**
 * Loads `.coderexic.yml` (or `.verix.yml`) at `commitSha`. Callers must
 * always pass the PR's base sha, never its head: reading from head would
 * let a PR edit its own review rules to silence findings about itself.
 *
 * Never throws: a missing file returns the defaults, and a file that can't
 * be read or parsed returns the defaults with a warning attached, so a bad
 * repo config degrades the review rather than failing the job
 * (PRODUCT_SPEC.md §18).
 */
export async function loadRepositoryConfig(
  client: GitHubClient,
  ref: RepoRef,
  commitSha: string,
): Promise<ParsedRepositoryConfig> {
  for (const filename of CONFIG_FILENAMES) {
    let raw: string | null;
    try {
      raw = await client.getFileContent(ref, filename, commitSha, MAX_CONFIG_BYTES);
    } catch {
      // Oversized, a directory, or a transient GitHub error: treat as bad config, not a crash.
      return {
        ...EMPTY_REPOSITORY_CONFIG,
        warnings: [`could not read ${filename}; using defaults`],
      };
    }
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = parseYaml(raw, YAML_PARSE_OPTIONS);
    } catch {
      return {
        ...EMPTY_REPOSITORY_CONFIG,
        warnings: [`${filename} is not valid YAML; using defaults`],
      };
    }
    return parseRepositoryConfig(parsed);
  }
  return EMPTY_REPOSITORY_CONFIG;
}

/**
 * Loads the repository's review-rules file at `commitSha` (always the PR's
 * base sha, for the same reason as {@link loadRepositoryConfig}). Returns
 * `null` if none of `RULES_FILENAMES` exists there.
 */
export async function loadRepositoryRules(
  client: GitHubClient,
  ref: RepoRef,
  commitSha: string,
): Promise<RepositoryRulesFile | null> {
  for (const filename of RULES_FILENAMES) {
    let content: string | null;
    try {
      content = await client.getFileContent(ref, filename, commitSha, MAX_RULES_BYTES);
    } catch {
      continue;
    }
    if (content !== null && content.trim().length > 0) {
      return { filename, content: content.trim() };
    }
  }
  return null;
}
