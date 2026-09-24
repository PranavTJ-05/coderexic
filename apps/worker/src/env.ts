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
  });

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(source?: Record<string, string | undefined>): WorkerEnv {
  return parseEnv(workerEnvSchema, source);
}
