import {
  createIndexRun,
  createReviewJob,
  automaticReviewKey,
  upsertInstallation,
  upsertRepository,
  type Executor,
} from '@coderexic/core';

let counter = 0;
const next = () => ++counter;

export async function makeInstallation(db: Executor) {
  return upsertInstallation(db, {
    githubInstallationId: 1_000 + next(),
    ownerType: 'User',
    ownerLogin: 'octocat',
  });
}

export async function makeRepository(db: Executor, installationId?: string) {
  const installation = installationId ?? (await makeInstallation(db)).id;
  const n = next();
  return upsertRepository(db, {
    installationId: installation,
    githubRepositoryId: 5_000 + n,
    fullName: `octocat/repo-${n}`,
    ownerLogin: 'octocat',
    name: `repo-${n}`,
    defaultBranch: 'main',
  });
}

export async function makeReviewJob(db: Executor, headSha = 'a'.repeat(40)) {
  const repository = await makeRepository(db);
  const { job } = await createReviewJob(db, {
    repositoryId: repository.id,
    installationId: repository.installationId,
    pullRequestNumber: 7,
    headSha,
    triggerType: 'automatic',
    idempotencyKey: automaticReviewKey(repository.id, 7, headSha),
  });
  return { repository, job };
}

export async function makeIndexRun(db: Executor, commitSha = 'a'.repeat(40)) {
  const repository = await makeRepository(db);
  const run = await createIndexRun(db, repository.id, commitSha);
  return { repository, run };
}
