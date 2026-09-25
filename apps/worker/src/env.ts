import {
  anthropicEnvSchema,
  baseEnvSchema,
  geminiEnvSchema,
  githubAppEnvSchema,
  groqEnvSchema,
  openaiEnvSchema,
  parseEnv,
  SUPPORTED_MODEL_PROVIDERS,
  type SupportedModelProvider,
} from '@coderexic/core';
import { z } from 'zod';

/**
 * Every per-provider API key is optional here (each provider's own env
 * schema, e.g. `geminiEnvSchema`, still requires its own key when used
 * standalone by a script). Only `MODEL_PROVIDER`'s key is required, enforced
 * below by `superRefine` - a Groq-only deployment must be able to boot
 * without ever setting `GEMINI_API_KEY`.
 */
export const workerEnvSchema = baseEnvSchema
  .extend(githubAppEnvSchema.shape)
  .extend(geminiEnvSchema.partial().shape)
  .extend(openaiEnvSchema.partial().shape)
  .extend(anthropicEnvSchema.partial().shape)
  .extend(groqEnvSchema.partial().shape)
  .extend({
    MODEL_PROVIDER: z.enum(SUPPORTED_MODEL_PROVIDERS).default('gemini'),
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
  })
  .superRefine((data, ctx) => {
    const REQUIRED_KEY: Record<SupportedModelProvider, keyof typeof data> = {
      gemini: 'GEMINI_API_KEY',
      openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      groq: 'GROQ_API_KEY',
    };
    const key = REQUIRED_KEY[data.MODEL_PROVIDER];
    if (!data[key]) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'required' });
    }
  });

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(source?: Record<string, string | undefined>): WorkerEnv {
  return parseEnv(workerEnvSchema, source);
}
