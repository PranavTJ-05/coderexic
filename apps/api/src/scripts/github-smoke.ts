/**
 * Exercises the GitHub App against a real repository:
 *   pnpm github:smoke --repo owner/name --pr 1           read-only checks
 *   pnpm github:smoke --repo owner/name --pr 1 --post    also posts a test review
 * Use a throwaway repository: --post writes a visible review comment.
 */
import { parseArgs } from 'node:util';
import { createGitHubApp, createLogger, loadGitHubAppCredentials } from '@coderexic/core';

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    pr: { type: 'string' },
    post: { type: 'boolean', default: false },
  },
});
const [owner, repo] = (values.repo ?? '').split('/');
const pullNumber = Number(values.pr);
if (!owner || !repo || !Number.isInteger(pullNumber) || pullNumber < 1) {
  process.stderr.write('usage: pnpm github:smoke --repo owner/name --pr <number> [--post]\n');
  process.exit(2);
}

const logger = createLogger({ name: 'github-smoke', level: 'info' });
const credentials = loadGitHubAppCredentials(process.env, (message) => {
  logger.warn(message);
});
const app = createGitHubApp({ credentials, logger });
const ref = { owner, repo };

/** First added line of a unified diff, as a new-file line number. */
function firstAddedLine(patch: string): number | undefined {
  let line = 0;
  for (const row of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row);
    if (hunk) {
      line = Number(hunk[1]);
    } else if (row.startsWith('+')) {
      return line;
    } else if (!row.startsWith('-')) {
      line += 1;
    }
  }
  return undefined;
}

try {
  const installationId = await app.getRepositoryInstallationId(ref);
  const client = await app.getInstallationClient(installationId);
  logger.info({ installationId }, 'installation token obtained');

  const pr = await client.getPullRequest(ref, pullNumber);
  logger.info(
    { title: pr.title, state: pr.state, headSha: pr.headSha, author: pr.author },
    'pull request',
  );

  const files = await client.getPullRequestFiles(ref, pullNumber);
  logger.info(
    { count: files.length, files: files.map((f) => `${f.status} ${f.filename}`) },
    'changed files',
  );

  const target = files.find((f) => f.status !== 'removed' && f.patch);
  if (target) {
    const content = await client.getFileContent(ref, target.filename, pr.headSha);
    logger.info({ path: target.filename, bytes: content?.length ?? null }, 'file content at head');
  }

  const tree = await client.getRepositoryTree(ref, pr.headSha);
  logger.info({ entries: tree.entries.length, truncated: tree.truncated }, 'repository tree');

  if (values.post) {
    const line = target?.patch ? firstAddedLine(target.patch) : undefined;
    const reviewId = await client.createReview(ref, {
      pullNumber,
      commitSha: pr.headSha,
      body: 'Coderexic smoke test: review publishing works. Safe to ignore.',
      comments:
        target && line
          ? [
              {
                path: target.filename,
                line,
                body: 'Coderexic smoke test: inline comment on an added line.',
              },
            ]
          : [],
    });
    logger.info({ reviewId, inline: Boolean(target && line) }, 'test review posted');
  }
} catch (err) {
  logger.error({ err }, 'smoke test failed');
  process.exit(1);
}
