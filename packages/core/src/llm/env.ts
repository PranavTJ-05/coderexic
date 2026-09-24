import { z } from 'zod';
import { parseEnv } from '../env.js';

/** Needed wherever the Gemini adapter runs (the worker). */
export const geminiEnvSchema = z.object({
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().min(1).default('gemini-3.6-flash'),
});
export type GeminiEnv = z.infer<typeof geminiEnvSchema>;

export function loadGeminiEnv(source?: Record<string, string | undefined>): GeminiEnv {
  return parseEnv(geminiEnvSchema, source);
}
