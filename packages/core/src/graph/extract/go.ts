import type { ExtractContext, ResolvedImport } from './types.js';

/** Matches both `"fmt"` and `alias "path"` forms inside single or grouped `import (...)` blocks. */
const IMPORT_PATH_RE = /"([^"\n]+)"/g;

/**
 * Regex-based, not a real Go parser. Only import paths under the module's
 * own prefix (from `go.mod`) are treated as internal; anything else -
 * stdlib or a third-party module - is external and dropped. A match picks
 * any `.go` file whose directory suffix equals the import path's package
 * directory, which is a heuristic (not a guarantee the package name in
 * that directory actually matches), hence `resolved: false`.
 */
export function extractGoImports(content: string, ctx: ExtractContext): ResolvedImport[] {
  if (!ctx.goModule) return [];
  const importBlockMatch = /import\s*\(([\s\S]*?)\)/.exec(content);
  const singleImportMatch = /import\s+"([^"\n]+)"/.exec(content);
  const body = importBlockMatch?.[1] ?? '';
  const paths = new Set<string>();
  for (const match of body.matchAll(IMPORT_PATH_RE)) {
    if (match[1]) paths.add(match[1]);
  }
  if (singleImportMatch?.[1]) paths.add(singleImportMatch[1]);

  const edges: ResolvedImport[] = [];
  for (const path of paths) {
    if (!path.startsWith(ctx.goModule)) continue; // stdlib or a third-party module
    const packageDir = path.slice(ctx.goModule.length).replace(/^\//, '');
    const match = [...ctx.allFiles].find(
      (file) =>
        file.endsWith('.go') && (file.startsWith(`${packageDir}/`) || file === `${packageDir}.go`),
    );
    if (match && match !== ctx.filePath) edges.push({ targetPath: match, resolved: false });
  }
  return edges;
}

/** Extracts the module prefix (the first line's path) from a `go.mod`'s text, or null if absent. */
export function parseGoModulePrefix(goModText: string): string | null {
  const match = /^\s*module\s+(\S+)/m.exec(goModText);
  return match?.[1] ?? null;
}
