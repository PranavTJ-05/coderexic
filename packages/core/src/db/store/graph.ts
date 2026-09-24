import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Executor } from '../client.js';
import {
  dependencyEdges,
  indexedFiles,
  indexRuns,
  repositories,
  type IndexRunStatus,
} from '../schema.js';

export type IndexRun = typeof indexRuns.$inferSelect;
export type IndexedFile = typeof indexedFiles.$inferSelect;
export type DependencyEdge = typeof dependencyEdges.$inferSelect;

/**
 * Starts an index run for a commit, or returns the existing PENDING/RUNNING
 * run for that same (repository, commit) instead of creating a duplicate -
 * there is no unique constraint on `index_runs` to enforce this at the DB
 * layer, so a redelivered push webhook is deduplicated here instead.
 */
export async function createIndexRun(
  db: Executor,
  repositoryId: string,
  commitSha: string,
): Promise<IndexRun> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(indexRuns)
      .where(
        and(
          eq(indexRuns.repositoryId, repositoryId),
          eq(indexRuns.commitSha, commitSha),
          inArray(indexRuns.status, ['PENDING', 'RUNNING']),
        ),
      )
      .limit(1);
    if (existing) return existing;
    const [row] = await tx.insert(indexRuns).values({ repositoryId, commitSha }).returning();
    if (!row) throw new Error('createIndexRun returned no row');
    return row;
  });
}

/**
 * Atomically marks a PENDING run RUNNING. Returns undefined if another
 * worker already claimed it (or it was not PENDING), mirroring
 * `claimReviewJob`'s single-claimant guarantee.
 */
export async function claimIndexRun(
  db: Executor,
  indexRunId: string,
): Promise<IndexRun | undefined> {
  const [row] = await db
    .update(indexRuns)
    .set({ status: 'RUNNING' })
    .where(and(eq(indexRuns.id, indexRunId), eq(indexRuns.status, 'PENDING')))
    .returning();
  return row;
}

export async function findIndexRunById(db: Executor, id: string): Promise<IndexRun | undefined> {
  const [row] = await db.select().from(indexRuns).where(eq(indexRuns.id, id));
  return row;
}

/** PENDING index runs older than `olderThan`, for the worker's stale-run sweep. */
export async function findStalePendingIndexRuns(
  db: Executor,
  olderThan: Date,
  limit = 50,
): Promise<IndexRun[]> {
  return db
    .select()
    .from(indexRuns)
    .where(and(eq(indexRuns.status, 'PENDING'), lt(indexRuns.startedAt, olderThan)))
    .limit(limit);
}

export interface CompleteIndexRunInput {
  status: Extract<IndexRunStatus, 'SUCCEEDED' | 'FAILED'>;
  filesSeen: number;
  filesIndexed: number;
  edgesCreated: number;
  durationMs: number;
  errorMessage?: string;
}

export async function completeIndexRun(
  db: Executor,
  indexRunId: string,
  input: CompleteIndexRunInput,
): Promise<void> {
  await db
    .update(indexRuns)
    .set({
      status: input.status,
      filesSeen: input.filesSeen,
      filesIndexed: input.filesIndexed,
      edgesCreated: input.edgesCreated,
      durationMs: input.durationMs,
      ...(input.errorMessage !== undefined && { errorMessage: input.errorMessage }),
      completedAt: new Date(),
    })
    .where(eq(indexRuns.id, indexRunId));
}

export async function updateRepositoryIndexStatus(
  db: Executor,
  repositoryId: string,
  indexStatus: 'PENDING' | 'INDEXING' | 'READY' | 'FAILED',
): Promise<void> {
  await db.update(repositories).set({ indexStatus }).where(eq(repositories.id, repositoryId));
}

/** The current `(path, sha)` of everything indexed for a repo, to diff a new tree against. */
export async function listIndexedFiles(
  db: Executor,
  repositoryId: string,
): Promise<{ path: string; sha: string | null }[]> {
  return db
    .select({ path: indexedFiles.path, sha: indexedFiles.sha })
    .from(indexedFiles)
    .where(eq(indexedFiles.repositoryId, repositoryId));
}

export interface UpsertedIndexedFile {
  path: string;
  sha: string;
  language: string | null;
}

/** Inserts or refreshes indexed-file rows for the files an index run actually (re)parsed. */
export async function upsertIndexedFiles(
  db: Executor,
  repositoryId: string,
  files: readonly UpsertedIndexedFile[],
): Promise<void> {
  if (files.length === 0) return;
  const now = new Date();
  await db
    .insert(indexedFiles)
    .values(
      files.map((f) => ({
        repositoryId,
        path: f.path,
        sha: f.sha,
        language: f.language,
        isSupported: true,
        lastIndexedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [indexedFiles.repositoryId, indexedFiles.path],
      set: { sha: sql`excluded.sha`, language: sql`excluded.language`, lastIndexedAt: now },
    });
}

export async function deleteIndexedFiles(
  db: Executor,
  repositoryId: string,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return;
  await db
    .delete(indexedFiles)
    .where(
      and(eq(indexedFiles.repositoryId, repositoryId), inArray(indexedFiles.path, [...paths])),
    );
}

export interface NewDependencyEdge {
  sourcePath: string;
  targetPath: string;
  resolved: boolean;
}

/**
 * Replaces every edge whose `source_path` is in `sourcePaths` (a re-parsed
 * or removed file) with `edges`. A source with no current edges - a file
 * with no more imports, or a deleted one - is simply left with none.
 */
export async function replaceDependencyEdges(
  db: Executor,
  repositoryId: string,
  commitSha: string,
  sourcePaths: readonly string[],
  edges: readonly NewDependencyEdge[],
): Promise<void> {
  await db.transaction(async (tx) => {
    if (sourcePaths.length > 0) {
      await tx
        .delete(dependencyEdges)
        .where(
          and(
            eq(dependencyEdges.repositoryId, repositoryId),
            inArray(dependencyEdges.sourcePath, [...sourcePaths]),
          ),
        );
    }
    if (edges.length > 0) {
      await tx.insert(dependencyEdges).values(
        edges.map((e) => ({
          repositoryId,
          sourcePath: e.sourcePath,
          targetPath: e.targetPath,
          commitSha,
          resolved: e.resolved,
        })),
      );
    }
  });
}

/** What a file imports (ARCHITECTURE.md §8's `get_imports`). */
export async function getForwardEdges(
  db: Executor,
  repositoryId: string,
  sourcePath: string,
): Promise<DependencyEdge[]> {
  return db
    .select()
    .from(dependencyEdges)
    .where(
      and(
        eq(dependencyEdges.repositoryId, repositoryId),
        eq(dependencyEdges.sourcePath, sourcePath),
      ),
    );
}

/** What depends on a file (ARCHITECTURE.md §8's `get_dependents`). */
export async function getReverseEdges(
  db: Executor,
  repositoryId: string,
  targetPath: string,
): Promise<DependencyEdge[]> {
  return db
    .select()
    .from(dependencyEdges)
    .where(
      and(
        eq(dependencyEdges.repositoryId, repositoryId),
        eq(dependencyEdges.targetPath, targetPath),
      ),
    );
}
