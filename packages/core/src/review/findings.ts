import type { NewReviewFinding, ReviewFinding } from '../db/store/review-jobs.js';
import type { CreateReviewInput, ReviewComment } from '../github/types.js';
import type { ModelFinding } from '../llm/types.js';
import { matchesGlob } from './diff-filter.js';
import { firstAddedLine, hunkAt, isAddedLine, parseHunks, type Hunk } from './hunks.js';

/**
 * Drops findings on a path the repo's config asks to skip (PRODUCT_SPEC.md
 * step 8: severity and ignore filtering happen before placement, so an
 * ignored file's findings never reach the summary fallback either).
 */
export function filterIgnoredPaths(
  findings: readonly ModelFinding[],
  ignoreGlobs: readonly string[],
): ModelFinding[] {
  if (ignoreGlobs.length === 0) return [...findings];
  return findings.filter(
    (finding) => !ignoreGlobs.some((glob) => matchesGlob(finding.filename, glob)),
  );
}

/** Lower index = more severe (matches DATA_MODEL.md §15). */
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;
const severityRank = (severity: ModelFinding['severity']): number =>
  SEVERITY_ORDER.indexOf(severity);

/**
 * Drops findings below the repository's configured minimum severity
 * (AI_AGENT_SPEC.md §13: critical > high > medium > low, minimum inclusive).
 */
export function filterBySeverity(
  findings: readonly ModelFinding[],
  minimumSeverity: ModelFinding['severity'],
): ModelFinding[] {
  const threshold = severityRank(minimumSeverity);
  return findings.filter((finding) => severityRank(finding.severity) <= threshold);
}

/**
 * Drops findings that duplicate a more severe finding on an overlapping
 * range in the same file (AI_AGENT_SPEC.md §12). Ties keep the first
 * (the model's own ordering).
 */
export function dedupeFindings(findings: readonly ModelFinding[]): ModelFinding[] {
  const byFile = new Map<string, ModelFinding[]>();
  for (const finding of findings) {
    const list = byFile.get(finding.filename) ?? [];
    list.push(finding);
    byFile.set(finding.filename, list);
  }
  const kept: ModelFinding[] = [];
  for (const list of byFile.values()) {
    const dropped = new Set<number>();
    for (let i = 0; i < list.length; i++) {
      if (dropped.has(i)) continue;
      for (let j = i + 1; j < list.length; j++) {
        if (dropped.has(j)) continue;
        const a = list[i];
        const b = list[j];
        if (!a || !b) continue;
        const overlaps = a.start_line <= b.end_line && b.start_line <= a.end_line;
        if (!overlaps) continue;
        dropped.add(severityRank(a.severity) <= severityRank(b.severity) ? j : i);
      }
    }
    list.forEach((finding, index) => {
      if (!dropped.has(index)) kept.push(finding);
    });
  }
  return kept;
}

export type FindingPlacement =
  { kind: 'inline'; comment: ReviewComment } | { kind: 'summary-only'; reason: string };

export interface ProcessedFinding {
  finding: ModelFinding;
  placement: FindingPlacement;
}

const SEVERITY_LABEL: Record<ModelFinding['severity'], string> = {
  critical: '🔴 Critical',
  high: '🟠 High',
  medium: '🟡 Medium',
  low: '⚪ Low',
};

function commentBody(finding: ModelFinding, downgradedFromApplyable: boolean): string {
  const parts = [`**${SEVERITY_LABEL[finding.severity]}:** ${finding.issue}`];
  if (finding.fix_type === 'applyable' && !downgradedFromApplyable && finding.suggested_code) {
    parts.push('```suggestion\n' + finding.suggested_code + '\n```');
  } else if (finding.suggested_code) {
    parts.push('Suggested approach:\n```\n' + finding.suggested_code + '\n```');
  }
  return parts.join('\n\n');
}

/**
 * Places each finding on a GitHub review comment where possible, and
 * explains why not otherwise (PRODUCT_SPEC.md §10's inline-or-fallback
 * rule). Only files present in `filesByPath` were sent to the model, so a
 * finding for any other filename is treated as unverifiable.
 */
export function placeFindings(
  findings: readonly ModelFinding[],
  filesByPath: ReadonlyMap<string, string>,
): ProcessedFinding[] {
  const hunksByPath = new Map<string, Hunk[]>();
  for (const [path, patch] of filesByPath) hunksByPath.set(path, parseHunks(patch));

  return findings.map((finding): ProcessedFinding => {
    const hunks = hunksByPath.get(finding.filename);
    if (!hunks) {
      return {
        finding,
        placement: { kind: 'summary-only', reason: 'file was not part of the reviewed diff' },
      };
    }
    const startHunk = hunkAt(hunks, finding.start_line);
    const endHunk = hunkAt(hunks, finding.end_line);
    if (!startHunk || !endHunk) {
      return { finding, placement: { kind: 'summary-only', reason: 'line is outside the diff' } };
    }
    if (startHunk !== endHunk) {
      return {
        finding,
        placement: {
          kind: 'summary-only',
          reason: 'start and end lines are in different diff hunks',
        },
      };
    }
    const downgraded = finding.fix_type === 'applyable' && !isAddedLine(hunks, finding.end_line);
    const comment: ReviewComment = {
      path: finding.filename,
      line: finding.end_line,
      body: commentBody(finding, downgraded),
      ...(finding.start_line < finding.end_line && { startLine: finding.start_line }),
    };
    return { finding, placement: { kind: 'inline', comment } };
  });
}

/** True if a file (already selected for review) has at least one line a comment can anchor to. */
export function hasCommentableLine(patch: string): boolean {
  return firstAddedLine(parseHunks(patch)) !== undefined || parseHunks(patch).length > 0;
}

export interface BuiltReview {
  comments: ReviewComment[];
  /** Findings the model reported that could not be posted inline, for the review summary. */
  summaryOnly: { finding: ModelFinding; reason: string }[];
  /** DB rows for every finding, `published` set to whether it went inline. */
  dbFindings: NewReviewFinding[];
}

export function buildReview(processed: readonly ProcessedFinding[]): BuiltReview {
  const comments: ReviewComment[] = [];
  const summaryOnly: BuiltReview['summaryOnly'] = [];
  const dbFindings: NewReviewFinding[] = [];

  for (const { finding, placement } of processed) {
    dbFindings.push({
      filename: finding.filename,
      severity: finding.severity,
      startLine: finding.start_line,
      endLine: finding.end_line,
      issue: finding.issue,
      fixType: finding.fix_type,
      suggestedCode: finding.suggested_code ?? null,
      published: placement.kind === 'inline',
    });
    if (placement.kind === 'inline') {
      comments.push(placement.comment);
    } else {
      summaryOnly.push({ finding, reason: placement.reason });
    }
  }
  return { comments, summaryOnly, dbFindings };
}

const COMPLETION_MARKER_PREFIX = '<!-- coderexic:review-job:';

/** Embeds a machine-readable marker so a retried job never posts a second review. */
export function reviewMarker(reviewJobId: string): string {
  return `${COMPLETION_MARKER_PREFIX}${reviewJobId} -->`;
}

export function hasReviewMarker(body: string | null | undefined, reviewJobId: string): boolean {
  return typeof body === 'string' && body.includes(reviewMarker(reviewJobId));
}

export function buildSummaryBody(
  reviewJobId: string,
  summary: string,
  summaryOnly: readonly { finding: ModelFinding; reason: string }[],
): string {
  const parts = [summary || '_No summary provided._'];
  if (summaryOnly.length > 0) {
    parts.push(
      '<details><summary>Additional findings not shown inline</summary>\n\n' +
        summaryOnly
          .map(
            ({ finding, reason }) =>
              `- **${SEVERITY_LABEL[finding.severity]}** \`${finding.filename}\` (${reason}): ${finding.issue}`,
          )
          .join('\n') +
        '\n\n</details>',
    );
  }
  parts.push(reviewMarker(reviewJobId));
  return parts.join('\n\n');
}

export function buildCreateReviewInput(
  reviewJobId: string,
  pullNumber: number,
  commitSha: string,
  summary: string,
  built: BuiltReview,
): CreateReviewInput {
  return {
    pullNumber,
    commitSha,
    body: buildSummaryBody(reviewJobId, summary, built.summaryOnly),
    comments: built.comments,
  };
}

export type { NewReviewFinding, ReviewFinding };
