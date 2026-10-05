import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Postgres SQLSTATE classes worth a retry rather than an immediate
 * failure: connection_exception (08xxx), serialization_failure (40001),
 * deadlock_detected (40P01), too_many_connections (53300), and the
 * admin/crash-shutdown/cannot-connect-now family (57P0x). Everything else
 * (a constraint violation, a syntax error, bad input) is a bug or bad
 * data, not a blip, and retrying it would fail identically.
 */
const TRANSIENT_PG_SQLSTATES = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '40001',
  '40P01',
  '53300',
  '57P01',
  '57P02',
  '57P03',
]);

/** Whether `err` is a Postgres error worth retrying (see TRANSIENT_PG_SQLSTATES above). */
export function isTransientDbError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && TRANSIENT_PG_SQLSTATES.has(code);
}

export interface DbRetryOptions {
  /** Extra attempts after the first (so `retries + 1` total). Default 2. */
  retries?: number;
  /** Base delay for exponential backoff between attempts. Default 100ms. */
  baseDelayMs?: number;
}

/**
 * Retries `fn` on a transient Postgres failure (see `isTransientDbError`)
 * with short exponential backoff, rethrowing immediately for anything else
 * or once retries are exhausted. Meant for a single DB operation (a query,
 * or one `db.transaction(...)` call) that's safe to run again from
 * scratch - never wrap something with a side effect outside the database
 * itself (a GitHub API call, a queue enqueue) in this, since a "retry" of
 * that would repeat the side effect too.
 *
 * Kept deliberately fast (a few hundred ms worst case): this exists for
 * places like the webhook route that must answer within GitHub's delivery
 * timeout, not for the worker's review pipeline, which already has its own
 * much coarser BullMQ-level retry (review-queue.ts, apps/worker/src/review/
 * pipeline.ts) for failures discovered mid-job.
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  options: DbRetryOptions = {},
): Promise<T> {
  const { retries = 2, baseDelayMs = 100 } = options;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientDbError(err) || attempt >= retries) throw err;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
}
