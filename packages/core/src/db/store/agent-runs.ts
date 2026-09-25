import { eq } from 'drizzle-orm';
import type { Executor } from '../client.js';
import {
  agentRuns,
  agentToolCalls,
  reviews,
  type AgentRunStatus,
  type AgentTerminationReason,
  type ToolCallStatus,
} from '../schema.js';

export type AgentRun = typeof agentRuns.$inferSelect;
export type AgentToolCall = typeof agentToolCalls.$inferSelect;

export interface StartReviewInput {
  reviewJobId: string;
  provider: string;
  model: string;
}

/**
 * Creates (or resets, on a retried job) the `reviews` row an agent run
 * points at, so `createAgentRun` has something to reference before the loop
 * finishes. `completeReview`'s own upsert - keyed on the same
 * `review_job_id` unique constraint - later overwrites this row's summary
 * and status with the final result.
 */
export async function startReview(db: Executor, input: StartReviewInput): Promise<{ id: string }> {
  const [row] = await db
    .insert(reviews)
    .values({
      reviewJobId: input.reviewJobId,
      provider: input.provider,
      model: input.model,
      status: 'RUNNING',
    })
    .onConflictDoUpdate({
      target: reviews.reviewJobId,
      set: { provider: input.provider, model: input.model, status: 'RUNNING' },
    })
    .returning({ id: reviews.id });
  if (!row) throw new Error('startReview: review not stored');
  return row;
}

export async function createAgentRun(db: Executor, reviewId: string): Promise<AgentRun> {
  const [row] = await db.insert(agentRuns).values({ reviewId }).returning();
  if (!row) throw new Error('createAgentRun: row not stored');
  return row;
}

export interface RecordToolCallInput {
  agentRunId: string;
  turnNumber: number;
  toolName: string;
  /** Metadata only (DATA_MODEL.md): never the tool result text or fetched file content. */
  argumentsJson: unknown;
  resultSizeBytes?: number | null;
  durationMs?: number | null;
  status: ToolCallStatus;
  errorMessage?: string | null;
}

export async function recordAgentToolCall(db: Executor, input: RecordToolCallInput): Promise<void> {
  await db.insert(agentToolCalls).values({
    agentRunId: input.agentRunId,
    turnNumber: input.turnNumber,
    toolName: input.toolName,
    argumentsJson: input.argumentsJson,
    status: input.status,
    ...(input.resultSizeBytes !== undefined && { resultSizeBytes: input.resultSizeBytes }),
    ...(input.durationMs !== undefined && { durationMs: input.durationMs }),
    ...(input.errorMessage !== undefined && { errorMessage: input.errorMessage }),
  });
}

export interface CompleteAgentRunInput {
  status: AgentRunStatus;
  terminationReason: AgentTerminationReason;
  turnCount: number;
  fileFetchCount: number;
  completedAt?: Date;
}

export async function completeAgentRun(
  db: Executor,
  agentRunId: string,
  input: CompleteAgentRunInput,
): Promise<void> {
  await db
    .update(agentRuns)
    .set({
      status: input.status,
      terminationReason: input.terminationReason,
      turnCount: input.turnCount,
      fileFetchCount: input.fileFetchCount,
      completedAt: input.completedAt ?? new Date(),
    })
    .where(eq(agentRuns.id, agentRunId));
}
