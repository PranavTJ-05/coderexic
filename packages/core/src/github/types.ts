/** Provider-neutral GitHub data used by the rest of the application. */

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  author: string | null;
  state: 'open' | 'closed';
  draft: boolean;
  baseSha: string;
  headSha: string;
  baseRef: string;
  headRef: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export type PRFileStatus =
  'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';

export interface PRFile {
  filename: string;
  previousFilename: string | null;
  status: PRFileStatus;
  additions: number;
  deletions: number;
  /** Absent for binary files and very large diffs. */
  patch: string | null;
}

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size: number | null;
}

export interface RepositoryTree {
  entries: TreeEntry[];
  /** GitHub truncates very large trees; callers must handle a partial list. */
  truncated: boolean;
}

export interface ReviewComment {
  path: string;
  /** New-file line the comment anchors to (end of a range). */
  line: number;
  /** First line of a multi-line comment. */
  startLine?: number;
  body: string;
}

export interface CreateReviewInput {
  pullNumber: number;
  /** Head commit the comments refer to. */
  commitSha: string;
  body: string;
  comments: readonly ReviewComment[];
}

export interface GitHubClient {
  getPullRequest(ref: RepoRef, pullNumber: number): Promise<PullRequest>;
  getPullRequestFiles(ref: RepoRef, pullNumber: number): Promise<PRFile[]>;
  /**
   * Text content of a file at a commit, or null if it does not exist there.
   * Throws for directories, binary files and files above `maxBytes`.
   */
  getFileContent(
    ref: RepoRef,
    path: string,
    commitSha: string,
    maxBytes?: number,
  ): Promise<string | null>;
  getRepositoryTree(ref: RepoRef, commitSha: string): Promise<RepositoryTree>;
  /** Review body text, newest first; used to detect a review already posted by a retried job. */
  listReviewBodies(ref: RepoRef, pullNumber: number): Promise<(string | null)[]>;
  /** Posts a review with inline comments; returns the GitHub review ID. */
  createReview(ref: RepoRef, input: CreateReviewInput): Promise<number>;
  /** Posts a PR-level comment; returns the GitHub comment ID. */
  createIssueComment(ref: RepoRef, issueNumber: number, body: string): Promise<number>;
}
