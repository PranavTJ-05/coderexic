import {
  buildRepositoryIndex,
  claimIndexRun,
  completeIndexRun,
  deleteIndexedFiles,
  findInstallationById,
  findRepositoryById,
  listIndexedFiles,
  markRepositoryIndexed,
  replaceDependencyEdges,
  updateRepositoryIndexStatus,
  upsertIndexedFiles,
  type Database,
  type GitHubApp,
  type Logger,
  type NewDependencyEdge,
} from '@coderexic/core';

export interface IndexPipelineDeps {
  db: Database;
  githubApp: GitHubApp;
  logger: Logger;
  /** Caps how many changed files one run re-fetches and parses. */
  maxFiles?: number;
}

/**
 * Runs one index run end to end: claim, fetch the repo tree, re-parse only
 * changed supported files, replace their edges, persist. Safe to call more
 * than once for the same run (BullMQ retries, or the stale-run sweep
 * re-enqueuing): claimIndexRun only lets one call past PENDING.
 */
export async function processIndexRun(deps: IndexPipelineDeps, indexRunId: string): Promise<void> {
  const { db, githubApp, logger } = deps;
  const log = logger.child({ indexRunId });
  const startedAt = Date.now();

  const claimed = await claimIndexRun(db, indexRunId);
  if (!claimed) {
    log.info('index run is not pending (already claimed, completed, or missing); skipping');
    return;
  }

  const fail = async (errorMessage: string): Promise<void> => {
    await completeIndexRun(db, indexRunId, {
      status: 'FAILED',
      filesSeen: 0,
      filesIndexed: 0,
      edgesCreated: 0,
      durationMs: Date.now() - startedAt,
      errorMessage,
    });
    await updateRepositoryIndexStatus(db, claimed.repositoryId, 'FAILED');
  };

  try {
    const repository = await findRepositoryById(db, claimed.repositoryId);
    if (!repository) {
      await fail('repository not found');
      return;
    }
    const installation = await findInstallationById(db, repository.installationId);
    if (!installation) {
      await fail('installation not found');
      return;
    }
    if (repository.removedAt || installation.removedAt) {
      await fail('repository or installation was removed');
      return;
    }

    await updateRepositoryIndexStatus(db, repository.id, 'INDEXING');
    const client = await githubApp.getInstallationClient(installation.githubInstallationId);
    const ref = { owner: repository.ownerLogin, repo: repository.name };

    const previouslyIndexed = await listIndexedFiles(db, repository.id);
    const result = await buildRepositoryIndex({
      client,
      ref,
      commitSha: claimed.commitSha,
      previouslyIndexed,
      ...(deps.maxFiles !== undefined && { maxFiles: deps.maxFiles }),
    });

    await upsertIndexedFiles(db, repository.id, result.indexedFiles);
    await deleteIndexedFiles(db, repository.id, result.removedPaths);

    const sourcePaths = [...new Set([...result.edgesBySourcePath.keys(), ...result.removedPaths])];
    const edges: NewDependencyEdge[] = [...result.edgesBySourcePath.entries()].flatMap(
      ([sourcePath, targets]) =>
        targets.map((t) => ({ sourcePath, targetPath: t.targetPath, resolved: t.resolved })),
    );
    await replaceDependencyEdges(db, repository.id, claimed.commitSha, sourcePaths, edges);

    await completeIndexRun(db, indexRunId, {
      status: 'SUCCEEDED',
      filesSeen: result.filesSeen,
      filesIndexed: result.filesIndexed,
      edgesCreated: result.edgesCreated,
      durationMs: Date.now() - startedAt,
    });
    await markRepositoryIndexed(db, repository.id, claimed.commitSha);
    if (result.truncated) {
      log.warn('GitHub truncated the repository tree; this index may be incomplete');
    }
  } catch (err) {
    log.error({ err }, 'index run failed unexpectedly');
    await fail(err instanceof Error ? err.message : 'unknown error').catch((markErr: unknown) => {
      log.error({ err: markErr }, 'failed to mark index run failed');
    });
    // Rethrow so BullMQ records the attempt as failed and applies its retry policy.
    throw err;
  }
}
