import { z } from 'zod';
import { FIX_TYPES, SEVERITIES } from '../db/schema.js';

/**
 * Matches the finding contract in AI_AGENT_SPEC.md §3 and PRODUCT_SPEC.md
 * §9. Field names stay snake_case: this is what we ask the model to
 * produce, not our internal representation (see review/findings.ts for the
 * mapped, DB-ready shape).
 */
export const modelFindingSchema = z
  .object({
    filename: z.string().min(1).max(1024),
    severity: z.enum(SEVERITIES),
    start_line: z.int().positive(),
    end_line: z.int().positive(),
    issue: z.string().min(1).max(4000),
    fix_type: z.enum(FIX_TYPES),
    suggested_code: z.string().max(8000).nullable().optional(),
  })
  .refine((finding) => finding.end_line >= finding.start_line, {
    message: 'end_line must be >= start_line',
    path: ['end_line'],
  });
export type ModelFinding = z.infer<typeof modelFindingSchema>;

export const modelReviewOutputSchema = z.object({
  summary: z.string().max(4000),
  reviews: z.array(modelFindingSchema).max(50),
});
export type ModelReviewOutput = z.infer<typeof modelReviewOutputSchema>;

export interface ReviewFileInput {
  filename: string;
  status: string;
  /** Unified diff patch, already filtered and size-budgeted by the caller. */
  patch: string;
}

export interface ReviewModelInput {
  repositoryFullName: string;
  pullRequestTitle: string;
  pullRequestBody: string | null;
  files: readonly ReviewFileInput[];
  /** Untrusted repository policy hints (Phase 5); never overrides system instructions. */
  repositoryRules?: string | null;
}

export interface GenerateReviewOptions {
  signal?: AbortSignal;
}

/** Provider-neutral interface (ARCHITECTURE.md §12); adapters live behind it. */
export interface ReviewModel {
  generateReview(
    input: ReviewModelInput,
    options?: GenerateReviewOptions,
  ): Promise<ModelReviewOutput>;
}
