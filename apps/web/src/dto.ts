/**
 * Explicit response shapes for `apps/web`'s API routes. Route handlers map
 * DB rows into these by hand rather than returning rows (or `AuthorizedRepository`)
 * directly, so a column added to `packages/core`'s schema later can't leak
 * to the client just by existing.
 */
import type {
  Repository,
  RepositorySettings,
  Review,
  ReviewFinding,
  ReviewJob,
  ReviewJobSummary,
} from '@coderexic/core';

export interface RepositorySummaryDto {
  repositoryId: string;
  fullName: string;
  ownerLogin: string;
  name: string;
  indexStatus: string;
  latestJob: ReviewJobSummaryDto | null;
}

export interface ReviewJobSummaryDto {
  id: string;
  pullRequestNumber: number;
  headSha: string;
  triggerType: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
  reviewSummary: string | null;
  findingsCount: number;
}

export interface RepositoryDetailDto {
  repositoryId: string;
  fullName: string;
  ownerLogin: string;
  name: string;
  defaultBranch: string | null;
  indexStatus: string;
  indexedAt: string | null;
  settings: {
    modelProvider: string | null;
    modelName: string | null;
    minimumSeverity: string;
  };
}

export interface ReviewFindingDto {
  id: string;
  filename: string;
  severity: string;
  startLine: number;
  endLine: number;
  issue: string;
  fixType: string;
  suggestedCode: string | null;
}

export interface ReviewDetailDto {
  jobId: string;
  repositoryId: string;
  pullRequestNumber: number;
  headSha: string;
  status: string;
  /** null until the worker has actually completed a review (e.g. still PENDING/RUNNING, or it FAILED before any review row was written). */
  provider: string | null;
  model: string | null;
  summary: string | null;
  findings: ReviewFindingDto[];
}

export function toReviewDetailDto(
  job: ReviewJob,
  review: Review | null,
  findings: readonly ReviewFinding[],
): ReviewDetailDto {
  return {
    jobId: job.id,
    repositoryId: job.repositoryId,
    pullRequestNumber: job.pullRequestNumber,
    headSha: job.headSha,
    status: job.status,
    provider: review?.provider ?? null,
    model: review?.model ?? null,
    summary: review?.summary ?? null,
    findings: findings.map(toReviewFindingDto),
  };
}

export function toReviewJobSummaryDto(row: ReviewJobSummary): ReviewJobSummaryDto {
  return {
    id: row.job.id,
    pullRequestNumber: row.job.pullRequestNumber,
    headSha: row.job.headSha,
    triggerType: row.job.triggerType,
    status: row.job.status,
    createdAt: row.job.createdAt.toISOString(),
    completedAt: row.job.completedAt ? row.job.completedAt.toISOString() : null,
    reviewSummary: row.review?.summary ?? null,
    findingsCount: row.findingsCount,
  };
}

export function toRepositorySummaryDto(
  repository: Pick<Repository, 'id' | 'fullName' | 'ownerLogin' | 'name' | 'indexStatus'>,
  latestJob: ReviewJobSummary | undefined,
): RepositorySummaryDto {
  return {
    repositoryId: repository.id,
    fullName: repository.fullName,
    ownerLogin: repository.ownerLogin,
    name: repository.name,
    indexStatus: repository.indexStatus,
    latestJob: latestJob ? toReviewJobSummaryDto(latestJob) : null,
  };
}

export function toRepositoryDetailDto(
  repository: Repository,
  settings: RepositorySettings | undefined,
): RepositoryDetailDto {
  return {
    repositoryId: repository.id,
    fullName: repository.fullName,
    ownerLogin: repository.ownerLogin,
    name: repository.name,
    defaultBranch: repository.defaultBranch,
    indexStatus: repository.indexStatus,
    indexedAt: repository.indexedAt ? repository.indexedAt.toISOString() : null,
    settings: {
      modelProvider: settings?.modelProvider ?? null,
      modelName: settings?.modelName ?? null,
      minimumSeverity: settings?.minimumSeverity ?? 'low',
    },
  };
}

export function toReviewFindingDto(finding: ReviewFinding): ReviewFindingDto {
  return {
    id: finding.id,
    filename: finding.filename,
    severity: finding.severity,
    startLine: finding.startLine,
    endLine: finding.endLine,
    issue: finding.issue,
    fixType: finding.fixType,
    suggestedCode: finding.suggestedCode,
  };
}
