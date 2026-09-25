import { and, eq, inArray } from 'drizzle-orm';
import type { Executor } from '../client.js';
import {
  ignorePatterns,
  repositories,
  repositorySettings,
  type MODEL_PROVIDERS_FOR_SETTINGS,
  type Severity,
} from '../schema.js';

export type Repository = typeof repositories.$inferSelect;
export type RepositorySettings = typeof repositorySettings.$inferSelect;

export interface RepositoryInput {
  installationId: string;
  githubRepositoryId: number;
  fullName: string;
  ownerLogin: string;
  name: string;
  defaultBranch?: string | null;
}

/**
 * Creates or refreshes a repository and makes sure it has a settings row,
 * in one transaction. Re-adding a removed repository clears `removed_at`.
 */
export async function upsertRepository(db: Executor, input: RepositoryInput): Promise<Repository> {
  return db.transaction(async (tx) => {
    const { defaultBranch, ...rest } = input;
    const values = { ...rest, ...(defaultBranch !== undefined && { defaultBranch }) };
    const [row] = await tx
      .insert(repositories)
      .values(values)
      .onConflictDoUpdate({
        target: [repositories.installationId, repositories.githubRepositoryId],
        set: {
          fullName: input.fullName,
          ownerLogin: input.ownerLogin,
          name: input.name,
          ...(defaultBranch !== undefined && { defaultBranch }),
          removedAt: null,
        },
      })
      .returning();
    if (!row) throw new Error('upsertRepository returned no row');
    await tx.insert(repositorySettings).values({ repositoryId: row.id }).onConflictDoNothing();
    return row;
  });
}

export async function findRepositoryById(
  db: Executor,
  id: string,
): Promise<Repository | undefined> {
  const [row] = await db.select().from(repositories).where(eq(repositories.id, id));
  return row;
}

/** For one-off scripts and manual lookups; webhook code paths always know the installation ID instead. */
export async function findRepositoryByFullName(
  db: Executor,
  fullName: string,
): Promise<Repository | undefined> {
  const [row] = await db.select().from(repositories).where(eq(repositories.fullName, fullName));
  return row;
}

export async function findRepository(
  db: Executor,
  installationId: string,
  githubRepositoryId: number,
): Promise<Repository | undefined> {
  const [row] = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.installationId, installationId),
        eq(repositories.githubRepositoryId, githubRepositoryId),
      ),
    );
  return row;
}

export async function getRepositorySettings(
  db: Executor,
  repositoryId: string,
): Promise<RepositorySettings | undefined> {
  const [row] = await db
    .select()
    .from(repositorySettings)
    .where(eq(repositorySettings.repositoryId, repositoryId));
  return row;
}

/**
 * Partial update of a repository's settings row (Phase 13c's settings
 * page). Every field is optional so a caller only touches what the user
 * actually changed - `undefined` means "leave as is", not "clear". Setting
 * `modelProvider` to `null` clears a repo-level override back to the
 * deployment default; the DB's own `repository_settings_model_provider_ck`
 * is the final word on a valid provider name, but the caller (the API
 * route) should validate against `SUPPORTED_MODEL_PROVIDERS` first for a
 * clean 400 instead of a raw constraint-violation error.
 */
export async function updateRepositorySettings(
  db: Executor,
  repositoryId: string,
  update: {
    modelProvider?: (typeof MODEL_PROVIDERS_FOR_SETTINGS)[number] | null;
    modelName?: string | null;
    minimumSeverity?: Severity;
  },
): Promise<RepositorySettings | undefined> {
  if (Object.keys(update).length === 0) return getRepositorySettings(db, repositoryId);
  const [row] = await db
    .update(repositorySettings)
    .set(update)
    .where(eq(repositorySettings.repositoryId, repositoryId))
    .returning();
  return row;
}

/** The repo's persistent ignore-glob list (`ignore_patterns`), the DB layer of PRODUCT_SPEC.md §11's config. */
export async function listIgnorePatterns(db: Executor, repositoryId: string): Promise<string[]> {
  const rows = await db
    .select({ pattern: ignorePatterns.pattern })
    .from(ignorePatterns)
    .where(eq(ignorePatterns.repositoryId, repositoryId));
  return rows.map((row) => row.pattern);
}

/** Adds an ignore-glob for a repository; a no-op (not an error) if it's already there. */
export async function addIgnorePattern(
  db: Executor,
  repositoryId: string,
  pattern: string,
): Promise<void> {
  await db.insert(ignorePatterns).values({ repositoryId, pattern }).onConflictDoNothing();
}

/** Removes an ignore-glob for a repository; a no-op if it wasn't there. */
export async function removeIgnorePattern(
  db: Executor,
  repositoryId: string,
  pattern: string,
): Promise<void> {
  await db
    .delete(ignorePatterns)
    .where(and(eq(ignorePatterns.repositoryId, repositoryId), eq(ignorePatterns.pattern, pattern)));
}

/** Soft-removes repositories deselected from an installation. */
export async function markRepositoriesRemoved(
  db: Executor,
  installationId: string,
  githubRepositoryIds: readonly number[],
  removedAt: Date = new Date(),
): Promise<number> {
  if (githubRepositoryIds.length === 0) return 0;
  const rows = await db
    .update(repositories)
    .set({ removedAt })
    .where(
      and(
        eq(repositories.installationId, installationId),
        inArray(repositories.githubRepositoryId, [...githubRepositoryIds]),
      ),
    )
    .returning({ id: repositories.id });
  return rows.length;
}

/** Records the latest pushed commit on the default branch. */
export async function updateRepositoryHead(
  db: Executor,
  repositoryId: string,
  headSha: string,
): Promise<void> {
  await db.update(repositories).set({ headSha }).where(eq(repositories.id, repositoryId));
}
