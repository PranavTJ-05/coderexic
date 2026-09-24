import {
  claimIndexRun,
  completeIndexRun,
  createIndexRun,
  deleteIndexedFiles,
  findIndexRunById,
  getForwardEdges,
  getReverseEdges,
  listIndexedFiles,
  markRepositoryIndexed,
  replaceDependencyEdges,
  updateRepositoryIndexStatus,
  upsertIndexedFiles,
  repositories,
} from '@coderexic/core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { makeRepository } from './fixtures.js';
import { useTestDatabase } from '../helpers/db.js';

const SHA = 'a'.repeat(40);

describe('graph store', () => {
  const { db } = useTestDatabase();

  describe('index runs', () => {
    it('starts PENDING, claims once, and completes', async () => {
      const repository = await makeRepository(db);
      const run = await createIndexRun(db, repository.id, SHA);
      expect(run.status).toBe('PENDING');

      const claimed = await claimIndexRun(db, run.id);
      expect(claimed?.status).toBe('RUNNING');

      // A second claim (a retried delivery, or the same sweep twice) is a no-op.
      const secondClaim = await claimIndexRun(db, run.id);
      expect(secondClaim).toBeUndefined();

      await completeIndexRun(db, run.id, {
        status: 'SUCCEEDED',
        filesSeen: 10,
        filesIndexed: 3,
        edgesCreated: 5,
        durationMs: 120,
      });
      const finished = await findIndexRunById(db, run.id);
      expect(finished).toMatchObject({ status: 'SUCCEEDED', filesSeen: 10, edgesCreated: 5 });
    });
  });

  describe('repository index status', () => {
    it('updates independently of the run row', async () => {
      const repository = await makeRepository(db);
      await updateRepositoryIndexStatus(db, repository.id, 'READY');
      const [row] = await db.select().from(repositories).where(eq(repositories.id, repository.id));
      expect(row?.indexStatus).toBe('READY');
    });

    it('records the indexed sha and timestamp when marked indexed', async () => {
      const repository = await makeRepository(db);
      expect(repository.indexedSha).toBeNull();

      await markRepositoryIndexed(db, repository.id, SHA);

      const [row] = await db.select().from(repositories).where(eq(repositories.id, repository.id));
      expect(row).toMatchObject({ indexStatus: 'READY', indexedSha: SHA });
      expect(row?.indexedAt).toBeInstanceOf(Date);
    });
  });

  describe('indexed files', () => {
    it('upserts, lists, and deletes by path', async () => {
      const repository = await makeRepository(db);
      await upsertIndexedFiles(db, repository.id, [
        { path: 'src/a.ts', sha: 'sha1', language: 'typescript', sizeBytes: 100 },
        { path: 'src/b.ts', sha: 'sha2', language: 'typescript', sizeBytes: 200 },
      ]);
      let files = await listIndexedFiles(db, repository.id);
      expect(files).toEqual(
        expect.arrayContaining([
          { path: 'src/a.ts', sha: 'sha1', language: 'typescript', sizeBytes: 100 },
          { path: 'src/b.ts', sha: 'sha2', language: 'typescript', sizeBytes: 200 },
        ]),
      );

      // Re-upserting the same path updates its sha rather than duplicating the row.
      await upsertIndexedFiles(db, repository.id, [
        { path: 'src/a.ts', sha: 'sha1-updated', language: 'typescript', sizeBytes: 150 },
      ]);
      files = await listIndexedFiles(db, repository.id);
      expect(files.filter((f) => f.path === 'src/a.ts')).toEqual([
        { path: 'src/a.ts', sha: 'sha1-updated', language: 'typescript', sizeBytes: 150 },
      ]);

      await deleteIndexedFiles(db, repository.id, ['src/b.ts']);
      files = await listIndexedFiles(db, repository.id);
      expect(files.map((f) => f.path)).toEqual(['src/a.ts']);
    });
  });

  describe('dependency edges', () => {
    it('replaces only the edges of the given source paths, keeping others untouched', async () => {
      const repository = await makeRepository(db);
      await replaceDependencyEdges(
        db,
        repository.id,
        SHA,
        ['src/a.ts', 'src/b.ts'],
        [
          { sourcePath: 'src/a.ts', targetPath: 'src/c.ts', resolved: true },
          { sourcePath: 'src/b.ts', targetPath: 'src/c.ts', resolved: true },
        ],
      );

      // Re-parsing only a.ts (b.ts's edges must survive untouched).
      await replaceDependencyEdges(
        db,
        repository.id,
        SHA,
        ['src/a.ts'],
        [{ sourcePath: 'src/a.ts', targetPath: 'src/d.ts', resolved: true }],
      );

      const aEdges = await getForwardEdges(db, repository.id, 'src/a.ts');
      expect(aEdges.map((e) => e.targetPath)).toEqual(['src/d.ts']);
      const bEdges = await getForwardEdges(db, repository.id, 'src/b.ts');
      expect(bEdges.map((e) => e.targetPath)).toEqual(['src/c.ts']);

      const dependents = await getReverseEdges(db, repository.id, 'src/c.ts');
      expect(dependents.map((e) => e.sourcePath)).toEqual(['src/b.ts']);
    });

    it('clears a source path down to no edges when re-parsing finds none', async () => {
      const repository = await makeRepository(db);
      await replaceDependencyEdges(
        db,
        repository.id,
        SHA,
        ['src/a.ts'],
        [{ sourcePath: 'src/a.ts', targetPath: 'src/b.ts', resolved: true }],
      );
      await replaceDependencyEdges(db, repository.id, SHA, ['src/a.ts'], []);
      const edges = await getForwardEdges(db, repository.id, 'src/a.ts');
      expect(edges).toEqual([]);
    });
  });
});
