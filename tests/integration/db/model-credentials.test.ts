import {
  buildProviderRegistry,
  CredentialAlreadyExistsError,
  createModelCredential,
  createLogger,
  deleteModelCredential,
  listModelCredentials,
  modelCredentials,
  parseMasterKeyMap,
  replaceModelCredential,
  resolveDecryptedCredential,
  resolveProviderEntry,
  rotateModelCredential,
  users,
  type MasterKeyMap,
  type ResolvedCredential,
} from '@coderexic/core';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeRepository } from './fixtures.js';
import { useTestDatabase, PG, pgErrorCode } from '../helpers/db.js';

const { db } = useTestDatabase();

let masterKeys: MasterKeyMap;
const KEY_VERSION = 1;

beforeEach(() => {
  masterKeys = parseMasterKeyMap(
    JSON.stringify({
      '1': randomBytes(32).toString('base64'),
      '2': randomBytes(32).toString('base64'),
    }),
  );
});

let userCounter = 0;
async function makeUser() {
  const n = ++userCounter;
  const [row] = await db
    .insert(users)
    .values({ githubUserId: 900_000 + n, login: `user-${n}` })
    .returning();
  if (!row) throw new Error('makeUser returned no row');
  return row;
}

const crypto = () => ({ masterKeys, keyVersion: KEY_VERSION });

describe('model_credentials store: audit checklist', () => {
  it('never stores plaintext in the encrypted_secret column', async () => {
    const user = await makeUser();
    await createModelCredential(
      db,
      { userId: user.id, repositoryId: null, provider: 'openai' },
      'sk-super-secret-plaintext',
      crypto(),
    );
    const [row] = await db
      .select()
      .from(modelCredentials)
      .where(eq(modelCredentials.userId, user.id));
    expect(row?.encryptedSecret).toBeDefined();
    expect(row?.encryptedSecret).not.toContain('sk-super-secret-plaintext');
  });

  it('never returns plaintext from any CRUD function', async () => {
    const user = await makeUser();
    const created = await createModelCredential(
      db,
      { userId: user.id, repositoryId: null, provider: 'openai' },
      'sk-super-secret-plaintext',
      crypto(),
    );
    expect(created).not.toHaveProperty('encryptedSecret');
    expect(JSON.stringify(created)).not.toContain('sk-super-secret-plaintext');

    const listed = await listModelCredentials(db, { userId: user.id });
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('sk-super-secret-plaintext');
    for (const row of listed) expect(row).not.toHaveProperty('encryptedSecret');
  });

  it('never logs plaintext (redacted by the shared logger config)', async () => {
    const user = await makeUser();
    await createModelCredential(
      db,
      { userId: user.id, repositoryId: null, provider: 'openai' },
      'sk-super-secret-plaintext',
      crypto(),
    );
    const resolved = (await resolveDecryptedCredential(
      db,
      { userId: user.id, provider: 'openai' },
      masterKeys,
    )) as ResolvedCredential;
    expect(resolved.apiKey).toBe('sk-super-secret-plaintext'); // positive control: the plaintext really is in this object

    const logs: string[] = [];
    const destination = { write: (chunk: string) => void logs.push(chunk) };
    const logger = createLogger({ name: 'credential-audit-test', level: 'info', destination });
    logger.info({ resolved }, 'resolved credential for a provider call');

    const written = logs.join('');
    expect(written).toContain('resolved credential for a provider call'); // proves the sink actually captured a line
    expect(written).not.toContain('sk-super-secret-plaintext');
  });
});

describe('model_credentials store: CRUD and precedence', () => {
  it('round-trips a credential through resolveDecryptedCredential', async () => {
    const user = await makeUser();
    await createModelCredential(
      db,
      { userId: user.id, repositoryId: null, provider: 'groq' },
      'gsk-live-key',
      crypto(),
    );
    const resolved = await resolveDecryptedCredential(
      db,
      { userId: user.id, provider: 'groq' },
      masterKeys,
    );
    expect(resolved?.apiKey).toBe('gsk-live-key');
    expect(resolved?.source).toBe('user');
  });

  it('prefers a repo-scoped credential over a user-scoped one', async () => {
    const user = await makeUser();
    const repository = await makeRepository(db);
    await createModelCredential(
      db,
      { userId: user.id, repositoryId: null, provider: 'groq' },
      'gsk-user-level',
      crypto(),
    );
    await createModelCredential(
      db,
      { userId: user.id, repositoryId: repository.id, provider: 'groq' },
      'gsk-repo-level',
      crypto(),
    );
    const resolved = await resolveDecryptedCredential(
      db,
      { userId: user.id, repositoryId: repository.id, provider: 'groq' },
      masterKeys,
    );
    expect(resolved?.apiKey).toBe('gsk-repo-level');
    expect(resolved?.source).toBe('repo');
  });

  it('falls back to the user tier when no repo credential exists for this repo', async () => {
    const user = await makeUser();
    const repository = await makeRepository(db);
    await createModelCredential(
      db,
      { userId: user.id, repositoryId: null, provider: 'groq' },
      'gsk-user-level',
      crypto(),
    );
    const resolved = await resolveDecryptedCredential(
      db,
      { userId: user.id, repositoryId: repository.id, provider: 'groq' },
      masterKeys,
    );
    expect(resolved?.apiKey).toBe('gsk-user-level');
    expect(resolved?.source).toBe('user');
  });

  it('returns undefined (system tier) when nothing is configured', async () => {
    const user = await makeUser();
    const resolved = await resolveDecryptedCredential(
      db,
      { userId: user.id, provider: 'anthropic' },
      masterKeys,
    );
    expect(resolved).toBeUndefined();
  });

  it('rejects a second live credential for the same tuple', async () => {
    const user = await makeUser();
    await createModelCredential(
      db,
      { userId: user.id, repositoryId: null, provider: 'openai' },
      'sk-1',
      crypto(),
    );
    await expect(
      createModelCredential(
        db,
        { userId: user.id, repositoryId: null, provider: 'openai' },
        'sk-2',
        crypto(),
      ),
    ).rejects.toBeInstanceOf(CredentialAlreadyExistsError);
  });

  it('the DB unique index is the authoritative guard (NULLS NOT DISTINCT across two null-repository rows)', async () => {
    const user = await makeUser();
    await db.insert(modelCredentials).values({
      userId: user.id,
      repositoryId: null,
      provider: 'openai',
      encryptedSecret: 'x',
      keyVersion: 1,
    });
    const code = await pgErrorCode(
      db.insert(modelCredentials).values({
        userId: user.id,
        repositoryId: null,
        provider: 'openai',
        encryptedSecret: 'y',
        keyVersion: 1,
      }),
    );
    expect(code).toBe(PG.uniqueViolation);
  });

  it('replace soft-deletes the old row and lets a fresh credential take its place', async () => {
    const user = await makeUser();
    const first = await createModelCredential(
      db,
      { userId: user.id, repositoryId: null, provider: 'openai' },
      'sk-old',
      crypto(),
    );
    const replaced = await replaceModelCredential(
      db,
      { userId: user.id, repositoryId: null, provider: 'openai' },
      'sk-new',
      crypto(),
    );
    expect(replaced.id).not.toBe(first.id);
    const resolved = await resolveDecryptedCredential(
      db,
      { userId: user.id, provider: 'openai' },
      masterKeys,
    );
    expect(resolved?.apiKey).toBe('sk-new');
    const listed = await listModelCredentials(db, { userId: user.id });
    expect(listed.map((r) => r.id)).toEqual([replaced.id]);
  });

  it('delete soft-deletes and stops resolution from finding the credential', async () => {
    const user = await makeUser();
    const created = await createModelCredential(
      db,
      { userId: user.id, repositoryId: null, provider: 'openai' },
      'sk-1',
      crypto(),
    );
    const deleted = await deleteModelCredential(db, created.id);
    expect(deleted).toBe(true);
    const resolved = await resolveDecryptedCredential(
      db,
      { userId: user.id, provider: 'openai' },
      masterKeys,
    );
    expect(resolved).toBeUndefined();
    expect(await deleteModelCredential(db, created.id)).toBe(false);
  });

  it('a soft-deleted row does not block creating a fresh credential for the same tuple', async () => {
    const user = await makeUser();
    const created = await createModelCredential(
      db,
      { userId: user.id, repositoryId: null, provider: 'openai' },
      'sk-1',
      crypto(),
    );
    await deleteModelCredential(db, created.id);
    await expect(
      createModelCredential(
        db,
        { userId: user.id, repositoryId: null, provider: 'openai' },
        'sk-2',
        crypto(),
      ),
    ).resolves.toBeDefined();
  });

  it('rejects a second user creating a live repo-scoped credential for the same repo+provider', async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const repository = await makeRepository(db);
    await createModelCredential(
      db,
      { userId: userA.id, repositoryId: repository.id, provider: 'groq' },
      'gsk-a',
      crypto(),
    );
    await expect(
      createModelCredential(
        db,
        { userId: userB.id, repositoryId: repository.id, provider: 'groq' },
        'gsk-b',
        crypto(),
      ),
    ).rejects.toBeInstanceOf(CredentialAlreadyExistsError);
  });

  it("replacing a repo-scoped credential soft-deletes the prior holder's row, not by userId", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const repository = await makeRepository(db);
    const first = await createModelCredential(
      db,
      { userId: userA.id, repositoryId: repository.id, provider: 'groq' },
      'gsk-a',
      crypto(),
    );
    const replaced = await replaceModelCredential(
      db,
      { userId: userB.id, repositoryId: repository.id, provider: 'groq' },
      'gsk-b',
      crypto(),
    );
    expect(replaced.id).not.toBe(first.id);
    const resolved = await resolveDecryptedCredential(
      db,
      { repositoryId: repository.id, provider: 'groq' },
      masterKeys,
    );
    expect(resolved?.apiKey).toBe('gsk-b');
  });

  it('rotates a credential to a new master-key version, preserving the plaintext', async () => {
    const user = await makeUser();
    const created = await createModelCredential(
      db,
      { userId: user.id, repositoryId: null, provider: 'openai' },
      'sk-rotate-me',
      crypto(),
    );
    const rotated = await rotateModelCredential(db, created.id, masterKeys, 2);
    expect(rotated.keyVersion).toBe(2);
    const resolved = await resolveDecryptedCredential(
      db,
      { userId: user.id, provider: 'openai' },
      masterKeys,
    );
    expect(resolved?.apiKey).toBe('sk-rotate-me');
    expect(resolved?.keyVersion).toBe(2);
  });
});

const testLogger = createLogger({ name: 'credential-resolution-test', level: 'silent' });

describe('resolveProviderEntry: repo > user > system precedence', () => {
  it('resolves from the repo tier when a repo credential exists', async () => {
    const user = await makeUser();
    const repository = await makeRepository(db);
    await createModelCredential(
      db,
      { userId: user.id, repositoryId: repository.id, provider: 'groq' },
      'gsk-repo',
      crypto(),
    );
    const entry = await resolveProviderEntry(
      db,
      { userId: user.id, repositoryId: repository.id, provider: 'groq' },
      masterKeys,
      {},
      testLogger,
    );
    expect(entry?.source).toBe('repo');
    expect(entry?.provider).toBe('groq');
    expect(typeof entry?.reviewModel.generateReview).toBe('function');
  });

  it('resolves from the user tier when no repo credential exists', async () => {
    const user = await makeUser();
    const repository = await makeRepository(db);
    await createModelCredential(
      db,
      { userId: user.id, repositoryId: null, provider: 'groq' },
      'gsk-user',
      crypto(),
    );
    const entry = await resolveProviderEntry(
      db,
      { userId: user.id, repositoryId: repository.id, provider: 'groq' },
      masterKeys,
      {},
      testLogger,
    );
    expect(entry?.source).toBe('user');
  });

  it('falls back to the system tier when the DB has no credential for this user/repo', async () => {
    const user = await makeUser();
    const systemRegistry = buildProviderRegistry(
      { groq: { apiKey: 'gsk-system', model: 'llama' } },
      testLogger,
    );
    const entry = await resolveProviderEntry(
      db,
      { userId: user.id, provider: 'groq' },
      masterKeys,
      systemRegistry,
      testLogger,
    );
    expect(entry?.source).toBe('system');
    expect(entry?.modelName).toBe(systemRegistry.groq?.modelName);
  });

  it('returns undefined when neither the DB nor the system registry has this provider', async () => {
    const user = await makeUser();
    const entry = await resolveProviderEntry(
      db,
      { userId: user.id, provider: 'anthropic' },
      masterKeys,
      {},
      testLogger,
    );
    expect(entry).toBeUndefined();
  });
});
