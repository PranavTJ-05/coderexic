/** Normalizes `a/./b/../c` style segments produced by joining a relative import onto a directory. */
export function normalizeSegments(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

export function joinRelative(fromDir: string, importPath: string): string {
  const joined = fromDir ? `${fromDir}/${importPath}` : importPath;
  return normalizeSegments(joined);
}

/**
 * Tries a base path as-is, with each of `extensions` appended, and as an
 * index file inside a same-named directory - the general shape every
 * supported language's module resolution reduces to once you have a base
 * path and a set of real repo file paths to check against.
 */
export function resolveAgainstFiles(
  basePath: string,
  extensions: readonly string[],
  indexBasenames: readonly string[],
  allFiles: ReadonlySet<string>,
): string | null {
  if (allFiles.has(basePath)) return basePath;
  for (const ext of extensions) {
    const candidate = `${basePath}.${ext}`;
    if (allFiles.has(candidate)) return candidate;
  }
  for (const indexName of indexBasenames) {
    const candidate = `${basePath}/${indexName}`;
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}
