import ts from 'typescript';

export interface TsAliasConfig {
  baseUrl: string | null;
  /** e.g. `{"@/*": ["src/*"]}`. Only exact and single-`*`-wildcard patterns are supported. */
  paths: Record<string, string[]>;
}

export const EMPTY_TS_ALIASES: TsAliasConfig = { baseUrl: null, paths: {} };

/**
 * Reads `compilerOptions.baseUrl`/`paths` out of a tsconfig.json's text.
 * Uses TypeScript's own JSONC-tolerant parser (comments, trailing commas),
 * per ARCHITECTURE.md-style "don't hand-roll a parser for someone else's
 * format" caution. Does not follow `extends`: that would mean fetching an
 * arbitrary chain of other repo files, which is out of scope for Phase 6 -
 * an extending config simply falls back to no aliases.
 */
export function parseTsConfigAliases(tsconfigText: string): TsAliasConfig {
  const result = ts.parseConfigFileTextToJson('tsconfig.json', tsconfigText);
  const config: unknown = result.config;
  if (result.error || typeof config !== 'object' || config === null) return EMPTY_TS_ALIASES;
  const compilerOptions = (config as { compilerOptions?: unknown }).compilerOptions;
  if (typeof compilerOptions !== 'object' || compilerOptions === null) return EMPTY_TS_ALIASES;
  const co = compilerOptions as Record<string, unknown>;
  const baseUrl = typeof co.baseUrl === 'string' ? co.baseUrl : null;
  const rawPaths = co.paths;
  const paths: Record<string, string[]> = {};
  if (typeof rawPaths === 'object' && rawPaths !== null) {
    for (const [pattern, targets] of Object.entries(rawPaths as Record<string, unknown>)) {
      if (Array.isArray(targets) && targets.every((t) => typeof t === 'string')) {
        paths[pattern] = targets;
      }
    }
  }
  return { baseUrl, paths };
}

/** Resolves a bare-looking import against `paths` (falling back to `baseUrl`), or null if neither applies. */
export function resolveTsAliasCandidate(importPath: string, aliases: TsAliasConfig): string[] {
  const candidates: string[] = [];
  for (const [pattern, targets] of Object.entries(aliases.paths)) {
    const starIndex = pattern.indexOf('*');
    if (starIndex === -1) {
      if (pattern === importPath) {
        for (const target of targets) if (!target.includes('*')) candidates.push(target);
      }
      continue;
    }
    const prefix = pattern.slice(0, starIndex);
    const suffix = pattern.slice(starIndex + 1);
    if (importPath.startsWith(prefix) && importPath.endsWith(suffix)) {
      const matched = importPath.slice(prefix.length, importPath.length - suffix.length);
      for (const target of targets) candidates.push(target.replace('*', matched));
    }
  }
  if (candidates.length === 0 && aliases.baseUrl !== null && !importPath.startsWith('.')) {
    candidates.push(`${aliases.baseUrl}/${importPath}`.replace(/^\.\//, ''));
  }
  return candidates;
}
