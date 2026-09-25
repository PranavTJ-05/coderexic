import { GitHubFileError } from '../github/client.js';
import type { GitHubClient, RepoRef } from '../github/types.js';
import type { ReviewContextCache } from './cache.js';

export interface FetchedContent {
  content: string | null;
  /**
   * True only for a transient fetch error (network, rate limit, ...), never
   * for a genuine 404 or a permanent per-file problem. Callers must not
   * cache a transient failure as "file missing" - the same request could
   * succeed a moment later.
   */
  failed: boolean;
  /**
   * Set when GitHub answered but the file itself can never be returned as
   * text (a directory, over the size limit, binary, ...). Distinct from
   * `failed`: retrying this exact request will not help, so callers should
   * say so once and cache the outcome rather than prompting a retry loop.
   */
  unavailable: string | null;
}

/**
 * Shared by the context engine (import extraction from PR head) and the
 * agent tool executor (`get_file_content`/`get_imports`), so both treat a
 * GitHub fetch error the same way: a transient error is never cached and
 * never reported as "missing" (a prior version of this code cached every
 * error as a permanent 404); a permanent, per-file problem (binary, too
 * large, a directory) is reported once and cached, since retrying it is
 * pointless and would otherwise burn a Phase 9 tool-call budget.
 */
export async function fetchCachedContent(
  client: GitHubClient,
  ref: RepoRef,
  path: string,
  sha: string,
  maxBytes: number,
  cache?: ReviewContextCache,
): Promise<FetchedContent> {
  if (cache?.hasFile(path, sha)) {
    return { content: cache.getFile(path, sha) ?? null, failed: false, unavailable: null };
  }
  try {
    const content = await client.getFileContent(ref, path, sha, maxBytes);
    cache?.setFile(path, sha, content);
    return { content, failed: false, unavailable: null };
  } catch (err) {
    if (err instanceof GitHubFileError) {
      // Cached as "no content", the same outcome a caller sees for a 404 - the difference
      // (why) only matters to the executor, which reads `unavailable` before it's cached away.
      cache?.setFile(path, sha, null);
      return { content: null, failed: false, unavailable: err.message };
    }
    return { content: null, failed: true, unavailable: null };
  }
}
