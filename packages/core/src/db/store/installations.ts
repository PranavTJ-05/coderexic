import { eq } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { installations, repositories } from '../schema.js';

export type Installation = typeof installations.$inferSelect;

export interface InstallationInput {
  githubInstallationId: number;
  ownerType: string;
  ownerLogin: string;
}

/** Creates or refreshes an installation; reinstalling clears `removed_at`. */
export async function upsertInstallation(
  db: Executor,
  input: InstallationInput,
): Promise<Installation> {
  const [row] = await db
    .insert(installations)
    .values(input)
    .onConflictDoUpdate({
      target: installations.githubInstallationId,
      set: { ownerType: input.ownerType, ownerLogin: input.ownerLogin, removedAt: null },
    })
    .returning();
  if (!row) throw new Error('upsertInstallation returned no row');
  return row;
}

export async function findInstallationById(
  db: Executor,
  id: string,
): Promise<Installation | undefined> {
  const [row] = await db.select().from(installations).where(eq(installations.id, id));
  return row;
}

export async function findInstallationByGithubId(
  db: Executor,
  githubInstallationId: number,
): Promise<Installation | undefined> {
  const [row] = await db
    .select()
    .from(installations)
    .where(eq(installations.githubInstallationId, githubInstallationId));
  return row;
}

/**
 * Soft-removes an installation and all of its repositories in one
 * transaction. History (reviews, findings) is kept.
 */
export async function markInstallationRemoved(
  db: Executor,
  githubInstallationId: number,
  removedAt: Date = new Date(),
): Promise<Installation | undefined> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(installations)
      .set({ removedAt })
      .where(eq(installations.githubInstallationId, githubInstallationId))
      .returning();
    if (row) {
      await tx
        .update(repositories)
        .set({ removedAt })
        .where(eq(repositories.installationId, row.id));
    }
    return row;
  });
}
