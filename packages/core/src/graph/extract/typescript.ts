import ts from 'typescript';
import { dirOf, joinRelative, resolveAgainstFiles } from '../resolve.js';
import { EMPTY_TS_ALIASES, resolveTsAliasCandidate } from '../tsconfig.js';
import type { ExtractContext, ResolvedImport } from './types.js';

const EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'] as const;
const INDEX_BASENAMES = EXTENSIONS.map((ext) => `index.${ext}`);

function resolveRelative(
  importPath: string,
  filePath: string,
  allFiles: ReadonlySet<string>,
): string | null {
  const basePath = joinRelative(dirOf(filePath), importPath);
  return resolveAgainstFiles(basePath, EXTENSIONS, INDEX_BASENAMES, allFiles);
}

/**
 * Extracts imports with `ts.preProcessFile`, TypeScript's own lightweight
 * scanner: it covers ES `import`/`export ... from`, dynamic `import()` and
 * CommonJS `require()` in one pass, without a hand-rolled regex per style.
 * Only imports that resolve to a real repo file become edges; bare
 * specifiers (npm packages, Node builtins) are external and dropped.
 */
export function extractTypeScriptImports(content: string, ctx: ExtractContext): ResolvedImport[] {
  let info: ts.PreProcessedFileInfo;
  try {
    info = ts.preProcessFile(content, true, true);
  } catch {
    return [];
  }
  const aliases = ctx.tsAliases ?? EMPTY_TS_ALIASES;
  const edges: ResolvedImport[] = [];
  const seen = new Set<string>();

  for (const { fileName: importPath } of info.importedFiles) {
    let targetPath: string | null = null;
    if (importPath.startsWith('.')) {
      targetPath = resolveRelative(importPath, ctx.filePath, ctx.allFiles);
    } else {
      for (const candidateBase of resolveTsAliasCandidate(importPath, aliases)) {
        targetPath = resolveAgainstFiles(candidateBase, EXTENSIONS, INDEX_BASENAMES, ctx.allFiles);
        if (targetPath) break;
      }
    }
    if (targetPath && !seen.has(targetPath)) {
      seen.add(targetPath);
      edges.push({ targetPath, resolved: true });
    }
  }
  return edges;
}
