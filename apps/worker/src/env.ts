import { baseEnvSchema, geminiEnvSchema, githubAppEnvSchema, parseEnv } from '@coderexic/core';
import { z } from 'zod';

export const workerEnvSchema = baseEnvSchema
  .extend(githubAppEnvSchema.shape)
  .extend(geminiEnvSchema.shape)
  .extend({
    /** Parallel review jobs one worker process handles at once. */
    REVIEW_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
    /** Parallel index runs one worker process handles at once; kept low since one run does many file fetches. */
    INDEX_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(1),
    /**
     * Off by default (ROADMAP.md Phase 9): the agent loop makes many more
     * model calls per review than the existing one-shot path. Flip this on
     * to switch every review over to it; there's no per-repo toggle yet.
     * A plain `z.coerce.boolean()` would treat the string "false" as truthy
     * (any non-empty string coerces to `true`), so this is an explicit enum.
     */
    AGENT_LOOP_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  });

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(source?: Record<string, string | undefined>): WorkerEnv {
  return parseEnv(workerEnvSchema, source);
}
