import { dirOf, joinRelative, resolveAgainstFiles } from '../resolve.js';
import type { ExtractContext, ResolvedImport } from './types.js';

const EXTENSIONS = ['rb'] as const;
const REQUIRE_RELATIVE_RE = /^\s*require_relative\s+['"]([^'"]+)['"]/gm;
const REQUIRE_RE = /^\s*require\s+['"]([^'"]+)['"]/gm;

/**
 * Regex-based, not a real Ruby parser. `require_relative` resolves against
 * the current file's directory; plain `require` is treated as a `lib/`-
 * rooted load path (the common convention for an in-repo gem layout) and
 * otherwise as an external gem, which is dropped.
 */
export function extractRubyImports(content: string, ctx: ExtractContext): ResolvedImport[] {
  const edges: ResolvedImport[] = [];
  const seen = new Set<string>();
  const add = (targetPath: string | null) => {
    if (targetPath && !seen.has(targetPath)) {
      seen.add(targetPath);
      edges.push({ targetPath, resolved: true });
    }
  };

  for (const match of content.matchAll(REQUIRE_RELATIVE_RE)) {
    if (!match[1]) continue;
    const basePath = joinRelative(dirOf(ctx.filePath), match[1]);
    add(resolveAgainstFiles(basePath, EXTENSIONS, [], ctx.allFiles));
  }
  for (const match of content.matchAll(REQUIRE_RE)) {
    if (!match[1]) continue;
    add(resolveAgainstFiles(`lib/${match[1]}`, EXTENSIONS, [], ctx.allFiles));
  }
  return edges;
}
