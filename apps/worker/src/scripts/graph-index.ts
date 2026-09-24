/**
 * Indexes a real repository's dependency graph and queries it back, to
 * prove Phase 6 end to end (ROADMAP.md's "prove it works"):
 *   pnpm graph:index --repo owner/name [--sha <sha>] [--query path/to/file.ts]
 *
 * Needs a running DATABASE_URL and the GitHub App env vars, and the
 * repository must already be known locally (it has received at least one
 * webhook, e.g. an installation or push event) - this script looks its row
 * up by full name rather than creating one, so it always indexes the same
 * repository row the review pipeline itself would use. Safe to re-run:
 * indexing is incremental, and a repeat run against the same commit
 * re-parses nothing.
 */
import { parseArgs } from 'node:util';
import {
  baseEnvSchema,
  buildRepositoryIndex,
  createDatabase,
  createGitHubApp,
  createLogger,
  deleteIndexedFiles,
  findInstallationById,
  findRepositoryByFullName,
  getForwardEdges,
  getReverseEdges,
  listIndexedFiles,
  loadGitHubAppCredentials,
  parseEnv,
  replaceDependencyEdges,
  updateRepositoryIndexStatus,
  upsertIndexedFiles,
} from '@coderexic/core';

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    sha: { type: 'string' },
    query: { type: 'string' },
  },
});
const [owner, repo] = (values.repo ?? '').split('/');
if (!owner || !repo) {
  process.stderr.write(
    'usage: pnpm graph:index --repo owner/name [--sha <sha>] [--query <path>]\n',
  );
  process.exit(2);
}

const logger = createLogger({ name: 'graph-index', level: 'info' });
const env = parseEnv(baseEnvSchema, process.env);
const database = createDatabase({ url: env.DATABASE_URL });
const credentials = loadGitHubAppCredentials(process.env, (message) => {
  logger.warn(message);
});
const app = createGitHubApp({ credentials, logger });
const ref = { owner, repo };
const fullName = `${owner}/${repo}`;

try {
  const repository = await findRepositoryByFullName(database.db, fullName);
  if (!repository) {
    process.stderr.write(
      `no local repository row for ${fullName}; it needs at least one webhook delivery first ` +
        '(install the app on it, or push/open a PR once)\n',
    );
    process.exit(2);
  }
  const installation = await findInstallationById(database.db, repository.installationId);
  if (!installation) {
    process.stderr.write(`installation for ${fullName} not found locally\n`);
    process.exit(2);
  }

  const client = await app.getInstallationClient(installation.githubInstallationId);
  const commitSha = values.sha ?? repository.headSha;
  if (!commitSha) {
    process.stderr.write('no known head commit for this repository; pass --sha explicitly\n');
    process.exit(2);
  }

  const previouslyIndexed = await listIndexedFiles(database.db, repository.id);
  logger.info(
    { fullName, commitSha, previouslyIndexed: previouslyIndexed.length },
    'starting index',
  );

  const result = await buildRepositoryIndex({ client, ref, commitSha, previouslyIndexed });
  await upsertIndexedFiles(database.db, repository.id, result.indexedFiles);
  await deleteIndexedFiles(database.db, repository.id, result.removedPaths);
  const sourcePaths = [...new Set([...result.edgesBySourcePath.keys(), ...result.removedPaths])];
  const edges = [...result.edgesBySourcePath.entries()].flatMap(([sourcePath, targets]) =>
    targets.map((t) => ({ sourcePath, targetPath: t.targetPath, resolved: t.resolved })),
  );
  await replaceDependencyEdges(database.db, repository.id, commitSha, sourcePaths, edges);
  await updateRepositoryIndexStatus(database.db, repository.id, 'READY');

  logger.info(
    {
      filesSeen: result.filesSeen,
      filesIndexed: result.filesIndexed,
      edgesCreated: result.edgesCreated,
      truncated: result.truncated,
    },
    'index complete',
  );

  if (values.query) {
    const forward = await getForwardEdges(database.db, repository.id, values.query);
    const reverse = await getReverseEdges(database.db, repository.id, values.query);
    logger.info(
      {
        path: values.query,
        imports: forward.map((e) => e.targetPath),
        importedBy: reverse.map((e) => e.sourcePath),
      },
      'graph query',
    );
  }
} finally {
  await database.close();
}
