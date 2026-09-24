/**
 * Per-review cache (AI_AGENT_SPEC.md §10): shared between the context
 * engine's own graph queries and Phase 8's tool executor, so a file the
 * engine already preselected is never re-fetched, and repeated graph
 * queries within one review are answered from memory. Scoped to a single
 * review job; never persisted, never shared across reviews.
 */
export const ALREADY_FETCHED_MESSAGE = 'You already fetched this file. Use the existing context.';

export class ReviewContextCache {
  private readonly files = new Map<string, string | null>();
  private readonly queries = new Map<string, unknown>();

  private fileKey(path: string, sha: string): string {
    return `${path}@${sha}`;
  }

  hasFile(path: string, sha: string): boolean {
    return this.files.has(this.fileKey(path, sha));
  }

  getFile(path: string, sha: string): string | null | undefined {
    return this.files.get(this.fileKey(path, sha));
  }

  setFile(path: string, sha: string, content: string | null): void {
    this.files.set(this.fileKey(path, sha), content);
  }

  get fetchedFileCount(): number {
    return this.files.size;
  }

  getQuery(key: string): unknown {
    return this.queries.get(key);
  }

  setQuery(key: string, value: unknown): void {
    this.queries.set(key, value);
  }
}
