import { App, Octokit, RequestError } from 'octokit';
import type { Logger } from '../logger.js';
import type { GitHubAppCredentials } from './config.js';
import type {
  CreateReviewInput,
  GitHubClient,
  PRFile,
  PullRequest,
  RepoRef,
  RepositoryTree,
} from './types.js';

type OctokitInstance = InstanceType<typeof Octokit>;

export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

export class GitHubFileError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'GitHubFileError';
  }
}

/**
 * Rate-limit policy: retry at most twice, and only when GitHub asks us to wait
 * a minute or less. Longer waits fail the request so the job can be retried
 * later instead of holding a worker.
 */
export function shouldRetryRateLimit(retryAfterSeconds: number, retryCount: number): boolean {
  return retryCount < 2 && retryAfterSeconds <= 60;
}

export interface GitHubAppOptions {
  credentials: GitHubAppCredentials;
  logger: Logger;
  /** Overrides the HTTP transport (tests). */
  fetch?: typeof globalThis.fetch;
  /** Disables client-side throttling (tests). */
  throttle?: boolean;
  baseUrl?: string;
}

export interface GitHubApp {
  /** A client scoped to one installation; tokens are cached and refreshed. */
  getInstallationClient(githubInstallationId: number): Promise<GitHubClient>;
  /** Looks up which installation covers a repository (app-level call). */
  getRepositoryInstallationId(ref: RepoRef): Promise<number>;
}

export function createGitHubApp({
  credentials,
  logger,
  fetch,
  throttle = true,
  baseUrl,
}: GitHubAppOptions): GitHubApp {
  const log = logger.child({ component: 'github' });
  const onLimit =
    (kind: string) =>
    (
      retryAfter: number,
      options: { method: string; url: string; request: { retryCount: number } },
    ) => {
      const retry = shouldRetryRateLimit(retryAfter, options.request.retryCount);
      log.warn(
        { kind, method: options.method, url: options.url, retryAfter, retry },
        'github rate limit',
      );
      return retry;
    };
  const CustomOctokit = Octokit.defaults({
    ...(baseUrl && { baseUrl }),
    userAgent: 'coderexic',
    request: fetch ? { fetch } : {},
    throttle: {
      enabled: throttle,
      onRateLimit: onLimit('primary'),
      onSecondaryRateLimit: onLimit('secondary'),
    },
    log: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string) => {
        log.warn(message);
      },
      error: (message: string) => {
        log.error(message);
      },
    },
  });
  const app = new App({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    Octokit: CustomOctokit,
  });

  return {
    async getInstallationClient(githubInstallationId) {
      const octokit = await app.getInstallationOctokit(githubInstallationId);
      return createGitHubClient(octokit);
    },
    async getRepositoryInstallationId({ owner, repo }) {
      const { data } = await app.octokit.request('GET /repos/{owner}/{repo}/installation', {
        owner,
        repo,
      });
      return data.id;
    },
  };
}

/** Adapts an authenticated Octokit to the GitHubClient interface. */
export function createGitHubClient(octokit: OctokitInstance): GitHubClient {
  return {
    async getPullRequest({ owner, repo }, pullNumber): Promise<PullRequest> {
      const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
      return {
        number: data.number,
        title: data.title,
        body: data.body,
        author: data.user.login,
        state: data.state === 'open' ? 'open' : 'closed',
        draft: data.draft ?? false,
        baseSha: data.base.sha,
        headSha: data.head.sha,
        baseRef: data.base.ref,
        headRef: data.head.ref,
        additions: data.additions,
        deletions: data.deletions,
        changedFiles: data.changed_files,
      };
    },

    async getPullRequestFiles({ owner, repo }, pullNumber): Promise<PRFile[]> {
      const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
      });
      return files.map((file) => ({
        filename: file.filename,
        previousFilename: file.previous_filename ?? null,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch ?? null,
      }));
    },

    async getFileContent({ owner, repo }, path, commitSha, maxBytes = DEFAULT_MAX_FILE_BYTES) {
      let data;
      try {
        ({ data } = await octokit.rest.repos.getContent({ owner, repo, path, ref: commitSha }));
      } catch (err) {
        if (err instanceof RequestError && err.status === 404) return null;
        throw err;
      }
      if (Array.isArray(data) || data.type !== 'file') {
        throw new GitHubFileError('path is not a file', path);
      }
      if (data.size > maxBytes) {
        throw new GitHubFileError(`file is larger than ${maxBytes} bytes`, path);
      }
      // Files above 1 MB come back without inline content.
      if (data.encoding !== 'base64' || typeof data.content !== 'string') {
        throw new GitHubFileError('file content is not available inline', path);
      }
      const bytes = Buffer.from(data.content, 'base64');
      if (bytes.includes(0)) {
        throw new GitHubFileError('file is binary', path);
      }
      return bytes.toString('utf8');
    },

    async getRepositoryTree({ owner, repo }, commitSha): Promise<RepositoryTree> {
      const { data } = await octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: commitSha,
        recursive: 'true',
      });
      return {
        truncated: data.truncated,
        entries: data.tree.flatMap((entry) =>
          entry.path &&
          entry.sha &&
          (entry.type === 'blob' || entry.type === 'tree' || entry.type === 'commit')
            ? [{ path: entry.path, type: entry.type, sha: entry.sha, size: entry.size ?? null }]
            : [],
        ),
      };
    },

    async createReview({ owner, repo }, input: CreateReviewInput) {
      const { data } = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: input.pullNumber,
        commit_id: input.commitSha,
        body: input.body,
        event: 'COMMENT',
        comments: input.comments.map((comment) => ({
          path: comment.path,
          line: comment.line,
          side: 'RIGHT' as const,
          body: comment.body,
          ...(comment.startLine !== undefined &&
            comment.startLine < comment.line && {
              start_line: comment.startLine,
              start_side: 'RIGHT' as const,
            }),
        })),
      });
      return data.id;
    },

    async createIssueComment({ owner, repo }, issueNumber, body) {
      const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });
      return data.id;
    },
  };
}
