import type { ExtractContext, ResolvedImport } from './types.js';

const IMPORT_RE = /^\s*import\s+(static\s+)?([\w.]+?)(?:\.\*)?\s*;/gm;
/** Conventional Java/Maven/Gradle source roots a fully-qualified class name is resolved against. */
const SOURCE_ROOTS = ['src/main/java/', 'src/test/java/', 'src/'];

function tryResolve(
  segments: string[],
  allFiles: ReadonlySet<string>,
  filePath: string,
): string | null {
  const asPath = segments.join('/');
  for (const root of SOURCE_ROOTS) {
    const candidate = `${root}${asPath}.java`;
    if (allFiles.has(candidate) && candidate !== filePath) return candidate;
  }
  return null;
}

/**
 * Regex-based, not a real Java parser: maps a fully-qualified import to a
 * `.java` file by trying each conventional source root. A wildcard import
 * (`import com.acme.*;`) names a package, not a single file, so it is
 * dropped rather than guessed at. A static import's last segment names a
 * member, not a class, so both the full path and the path minus its last
 * segment are tried.
 */
export function extractJavaImports(content: string, ctx: ExtractContext): ResolvedImport[] {
  const edges: ResolvedImport[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(IMPORT_RE)) {
    if (match[0].includes('.*')) continue;
    const isStatic = match[1] !== undefined;
    const fullPath = match[2];
    if (!fullPath) continue;
    const segments = fullPath.split('.');
    const candidates = isStatic ? [segments, segments.slice(0, -1)] : [segments];
    for (const candidateSegments of candidates) {
      const target = tryResolve(candidateSegments, ctx.allFiles, ctx.filePath);
      if (target && !seen.has(target)) {
        seen.add(target);
        edges.push({ targetPath: target, resolved: true });
      }
      if (target) break;
    }
  }
  return edges;
}
