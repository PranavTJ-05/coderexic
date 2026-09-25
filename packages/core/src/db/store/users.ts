import { eq } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { users } from '../schema.js';

export type User = typeof users.$inferSelect;

export interface UserInput {
  githubUserId: number;
  login: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  email?: string | null;
}

/**
 * Creates or refreshes a user on sign-in (Phase 13a's OAuth callback).
 * Matches on `githubUserId`, which never changes for a GitHub account, not
 * `login` (a user can rename it). Always bumps `lastLoginAt`.
 */
export async function upsertUser(db: Executor, input: UserInput): Promise<User> {
  const { githubUserId, displayName, avatarUrl, email, ...rest } = input;
  const values = {
    githubUserId,
    ...rest,
    ...(displayName !== undefined && { displayName }),
    ...(avatarUrl !== undefined && { avatarUrl }),
    ...(email !== undefined && { email }),
    lastLoginAt: new Date(),
  };
  const [row] = await db
    .insert(users)
    .values(values)
    .onConflictDoUpdate({ target: users.githubUserId, set: values })
    .returning();
  if (!row) throw new Error('upsertUser returned no row');
  return row;
}

export async function findUserByGithubId(
  db: Executor,
  githubUserId: number,
): Promise<User | undefined> {
  const [row] = await db.select().from(users).where(eq(users.githubUserId, githubUserId));
  return row;
}
