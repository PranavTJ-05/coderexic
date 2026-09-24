/**
 * AI_AGENT_SPEC.md §5 / ARCHITECTURE.md §14: a tool path must be
 * repo-relative, with no absolute paths and no `..` segment. The repo
 * itself is never model-supplied - it's fixed by the executor's own
 * construction (`repositoryId`/`ref`), so there's nothing to validate there.
 */
export function isValidToolPath(path: string): boolean {
  if (path.length === 0 || path.length > 1024) return false;
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  if (/^[a-zA-Z]:[/\\]/.test(path)) return false;
  const segments = path.split(/[/\\]/);
  return segments.every((segment) => segment !== '..' && segment !== '.');
}
