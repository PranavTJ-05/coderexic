import { dirOf, resolveAgainstFiles } from '../resolve.js';
import type { ExtractContext, ResolvedImport } from './types.js';

const EXTENSIONS = ['py'] as const;
const INDEX_BASENAMES = ['__init__.py'];
/** Common Python layouts this heuristic checks a module against, beyond the repo root. */
const SOURCE_ROOTS = ['', 'src/'];

const IMPORT_RE = /^\s*import\s+([\w.]+)/gm;
/** Requires a leading identifier char so a relative `from .foo import x` is left to the relative regex below. */
const FROM_IMPORT_RE = /^\s*from\s+([a-zA-Z_]\w*(?:\.\w+)*)\s+import\b/gm;

function resolveAbsoluteModule(module: string, allFiles: ReadonlySet<string>): string | null {
  const asPath = module.replace(/\./g, '/');
  for (const root of SOURCE_ROOTS) {
    const resolved = resolveAgainstFiles(`${root}${asPath}`, EXTENSIONS, INDEX_BASENAMES, allFiles);
    if (resolved) return resolved;
  }
  return null;
}

/** Dots count parent-package levels above the current file's directory. */
function relativeBaseDir(dots: number, filePath: string): string {
  let dir = dirOf(filePath);
  for (let i = 0; i < dots - 1; i++) dir = dirOf(dir);
  return dir;
}

/** Names imported by `from X import a, b as c, (d, e)`, aliases and parens stripped, `*` dropped. */
function parseImportedNames(importList: string): string[] {
  return importList
    .replace(/[()]/g, ' ')
    .split(',')
    .map((part) => (part.trim().split(/\s+as\s+/)[0] ?? '').trim())
    .filter((name) => name.length > 0 && name !== '*');
}

/**
 * Regex-based, not a real Python parser: covers the common `import x.y` and
 * `from x.y import z` forms, including relative imports and `src/` layouts.
 * A heuristic, not a language server - unusual constructs (conditional
 * imports built from strings, `importlib`) are invisible to it.
 */
export function extractPythonImports(content: string, ctx: ExtractContext): ResolvedImport[] {
  const edges: ResolvedImport[] = [];
  const seen = new Set<string>();
  const add = (targetPath: string | null) => {
    if (targetPath && !seen.has(targetPath)) {
      seen.add(targetPath);
      edges.push({ targetPath, resolved: true });
    }
  };

  for (const match of content.matchAll(IMPORT_RE)) {
    if (match[1]) add(resolveAbsoluteModule(match[1], ctx.allFiles));
  }
  for (const match of content.matchAll(FROM_IMPORT_RE)) {
    if (match[1]) add(resolveAbsoluteModule(match[1], ctx.allFiles));
  }
  for (const match of content.matchAll(/^\s*from\s+(\.+)([\w.]*)\s+import\s+(.+)$/gm)) {
    const dots = match[1]?.length;
    const modulePart = match[2];
    const importList = match[3];
    if (dots === undefined || modulePart === undefined || importList === undefined) continue;
    const baseDir = relativeBaseDir(dots, ctx.filePath);
    if (modulePart) {
      const basePath = baseDir
        ? `${baseDir}/${modulePart.replace(/\./g, '/')}`
        : modulePart.replace(/\./g, '/');
      add(resolveAgainstFiles(basePath, EXTENSIONS, INDEX_BASENAMES, ctx.allFiles));
    } else {
      // `from . import x, y`: each imported name may itself be a submodule of the current package.
      for (const name of parseImportedNames(importList)) {
        const basePath = baseDir ? `${baseDir}/${name}` : name;
        add(resolveAgainstFiles(basePath, EXTENSIONS, INDEX_BASENAMES, ctx.allFiles));
      }
    }
  }
  return edges;
}
