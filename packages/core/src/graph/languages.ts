/** Extensions the indexer parses for imports (ROADMAP.md Phase 6). */
export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  rb: 'ruby',
};

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function languageOf(path: string): string | null {
  return LANGUAGE_BY_EXTENSION[extensionOf(path)] ?? null;
}

export function isSupportedPath(path: string): boolean {
  return languageOf(path) !== null;
}
