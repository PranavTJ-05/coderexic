import { and, eq, inArray } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { repositories, repositorySettings } from '../schema.js';

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
