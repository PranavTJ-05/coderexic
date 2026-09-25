import { and, eq, isNull } from 'drizzle-orm';
import type { SupportedModelProvider } from '../../config/schema.js';
import {
  credentialAad,
  decryptCredential,
  encryptCredential,
} from '../../crypto/credential-crypto.js';
import type { MasterKeyMap } from '../../crypto/master-key.js';
import type { Executor } from '../client.js';
import { modelCredentials } from '../schema.js';

/**
 * Row metadata only - never `encryptedSecret`. This is the only shape a
 * store CRUD function returns; plaintext (and the encrypted column) must
 * never leave this module except through `resolveDecryptedCredential`.
 */
export interface ModelCredentialMetadata {
  id: string;
  userId: string;
  repositoryId: string | null;
  provider: string;
  keyVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

function toMetadata(row: typeof modelCredentials.$inferSelect): ModelCredentialMetadata {
  return {
    id: row.id,
    userId: row.userId,
    repositoryId: row.repositoryId,
    provider: row.provider,
    keyVersion: row.keyVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class CredentialAlreadyExistsError extends Error {
  constructor() {
    super('a live credential already exists for this tuple; use replaceModelCredential');
    this.name = 'CredentialAlreadyExistsError';
  }
}

export class CredentialNotFoundError extends Error {
  constructor(id: string) {
    super(`no live model credential with id ${id}`);
    this.name = 'CredentialNotFoundError';
  }
}

export interface ModelCredentialTuple {
  userId: string;
  /** null for a user-level (non-repo-scoped) credential. */
  repositoryId: string | null;
  provider: SupportedModelProvider;
}

/** The Postgres SQLSTATE for a unique-index violation. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
  const code = cause?.code ?? (err as { code?: string } | undefined)?.code;
  return code === UNIQUE_VIOLATION;
}

/**
 * The row(s) that own a tuple's exclusivity. A repo-scoped credential
 * (`repositoryId` set) is shared by the whole repo regardless of which user
 * added it - uniqueness is keyed on `(repositoryId, provider)`, not the
 * user. A user-scoped credential is keyed on `(userId, provider)` with no
 * repository. This matches the schema's two partial unique indexes
 * (`model_credentials_live_unique_idx`, `model_credentials_live_repo_unique_idx`).
 */
function liveTupleWhere(t: ModelCredentialTuple) {
  const scope =
    t.repositoryId === null
      ? and(eq(modelCredentials.userId, t.userId), isNull(modelCredentials.repositoryId))
      : eq(modelCredentials.repositoryId, t.repositoryId);
  return and(scope, eq(modelCredentials.provider, t.provider), isNull(modelCredentials.deletedAt));
}

/**
 * Inserts a new credential. Throws `CredentialAlreadyExistsError` if a live
 * row already exists for this tuple - callers that want to overwrite use
 * `replaceModelCredential`. The DB's partial unique indexes are the
 * authoritative guard (a duplicate insert raises a 23505, mapped here);
 * this isn't a check-then-insert race, since the insert itself is what's
 * caught.
 */
export async function createModelCredential(
  db: Executor,
  tuple: ModelCredentialTuple,
  plaintext: string,
  crypto: { masterKeys: MasterKeyMap; keyVersion: number },
): Promise<ModelCredentialMetadata> {
  const aad = credentialAad(tuple);
  const encryptedSecret = encryptCredential(crypto.masterKeys, crypto.keyVersion, plaintext, aad);
  let row: typeof modelCredentials.$inferSelect | undefined;
  try {
    [row] = await db
      .insert(modelCredentials)
      .values({
        userId: tuple.userId,
        repositoryId: tuple.repositoryId,
        provider: tuple.provider,
        encryptedSecret,
        keyVersion: crypto.keyVersion,
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) throw new CredentialAlreadyExistsError();
    throw err;
  }
  if (!row) throw new Error('createModelCredential returned no row');
  return toMetadata(row);
}

/**
 * Replaces the live credential for a tuple: soft-deletes the current row
 * (if any) and inserts a new one, in one transaction. Both "replace" and
 * "delete" are soft deletes; this is how a key gets rotated by hand.
 */
export async function replaceModelCredential(
  db: Executor,
  tuple: ModelCredentialTuple,
  plaintext: string,
  crypto: { masterKeys: MasterKeyMap; keyVersion: number },
): Promise<ModelCredentialMetadata> {
  const aad = credentialAad(tuple);
  const encryptedSecret = encryptCredential(crypto.masterKeys, crypto.keyVersion, plaintext, aad);
  const [row] = await db.transaction(async (tx) => {
    await tx.update(modelCredentials).set({ deletedAt: new Date() }).where(liveTupleWhere(tuple));
    return tx
      .insert(modelCredentials)
      .values({
        userId: tuple.userId,
        repositoryId: tuple.repositoryId,
        provider: tuple.provider,
        encryptedSecret,
        keyVersion: crypto.keyVersion,
      })
      .returning();
  });
  if (!row) throw new Error('replaceModelCredential returned no row');
  return toMetadata(row);
}

/** Soft-deletes a credential by id. No-op (returns false) if already deleted or absent. */
export async function deleteModelCredential(db: Executor, id: string): Promise<boolean> {
  const rows = await db
    .update(modelCredentials)
    .set({ deletedAt: new Date() })
    .where(and(eq(modelCredentials.id, id), isNull(modelCredentials.deletedAt)))
    .returning({ id: modelCredentials.id });
  return rows.length > 0;
}

export async function listModelCredentials(
  db: Executor,
  filter: { userId?: string; repositoryId?: string },
): Promise<ModelCredentialMetadata[]> {
  const conditions = [isNull(modelCredentials.deletedAt)];
  if (filter.userId !== undefined) conditions.push(eq(modelCredentials.userId, filter.userId));
  if (filter.repositoryId !== undefined) {
    conditions.push(eq(modelCredentials.repositoryId, filter.repositoryId));
  }
  const rows = await db
    .select()
    .from(modelCredentials)
    .where(and(...conditions));
  return rows.map(toMetadata);
}

/**
 * Re-encrypts a live credential under a new master-key version. Decrypts
 * with the row's current `keyVersion`, re-encrypts with `toVersion`,
 * updates in place.
 */
export async function rotateModelCredential(
  db: Executor,
  id: string,
  masterKeys: MasterKeyMap,
  toVersion: number,
): Promise<ModelCredentialMetadata> {
  const [row] = await db
    .select()
    .from(modelCredentials)
    .where(and(eq(modelCredentials.id, id), isNull(modelCredentials.deletedAt)));
  if (!row) throw new CredentialNotFoundError(id);
  const aad = credentialAad({
    userId: row.userId,
    repositoryId: row.repositoryId,
    provider: row.provider,
  });
  const plaintext = decryptCredential(masterKeys, row.keyVersion, row.encryptedSecret, aad);
  const encryptedSecret = encryptCredential(masterKeys, toVersion, plaintext, aad);
  const [updated] = await db
    .update(modelCredentials)
    .set({ encryptedSecret, keyVersion: toVersion })
    .where(eq(modelCredentials.id, id))
    .returning();
  if (!updated) throw new CredentialNotFoundError(id);
  return toMetadata(updated);
}

export type CredentialSource = 'repo' | 'user';

export interface ResolvedCredential {
  apiKey: string;
  source: CredentialSource;
  credentialId: string;
  keyVersion: number;
}

/**
 * The only function that returns plaintext. Resolves the DB tiers of the
 * repo > user > system precedence:
 *
 * 1. a repo-scoped credential for `(repositoryId, provider)` - shared by
 *    the repo regardless of which user added it;
 * 2. else a user-scoped credential for `(userId, provider)` with no
 *    repository;
 * 3. else `undefined` - the caller falls back to the system tier (a
 *    deployment-configured provider key, which lives outside this table -
 *    see `llm/credential-resolution.ts`).
 */
export async function resolveDecryptedCredential(
  db: Executor,
  lookup: { userId?: string; repositoryId?: string; provider: SupportedModelProvider },
  masterKeys: MasterKeyMap,
): Promise<ResolvedCredential | undefined> {
  if (lookup.repositoryId !== undefined) {
    const [row] = await db
      .select()
      .from(modelCredentials)
      .where(
        and(
          eq(modelCredentials.repositoryId, lookup.repositoryId),
          eq(modelCredentials.provider, lookup.provider),
          isNull(modelCredentials.deletedAt),
        ),
      );
    if (row) {
      const aad = credentialAad({
        userId: row.userId,
        repositoryId: row.repositoryId,
        provider: row.provider,
      });
      return {
        apiKey: decryptCredential(masterKeys, row.keyVersion, row.encryptedSecret, aad),
        source: 'repo',
        credentialId: row.id,
        keyVersion: row.keyVersion,
      };
    }
  }

  if (lookup.userId !== undefined) {
    const [row] = await db
      .select()
      .from(modelCredentials)
      .where(
        and(
          eq(modelCredentials.userId, lookup.userId),
          isNull(modelCredentials.repositoryId),
          eq(modelCredentials.provider, lookup.provider),
          isNull(modelCredentials.deletedAt),
        ),
      );
    if (row) {
      const aad = credentialAad({
        userId: row.userId,
        repositoryId: row.repositoryId,
        provider: row.provider,
      });
      return {
        apiKey: decryptCredential(masterKeys, row.keyVersion, row.encryptedSecret, aad),
        source: 'user',
        credentialId: row.id,
        keyVersion: row.keyVersion,
      };
    }
  }

  return undefined;
}
