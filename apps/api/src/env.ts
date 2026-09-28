import { baseEnvSchema, githubWebhookEnvSchema, parseEnv } from '@coderexic/core';
import { z } from 'zod';

export const apiEnvSchema = baseEnvSchema.extend(githubWebhookEnvSchema.shape).extend({
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /**
   * Bearer token required to read `/metrics` (ROADMAP.md Phase 14). Optional:
   * unset means `/metrics` is not registered at all, so a deployment that
   * hasn't set up scraping never exposes it unauthenticated by default.
   */
  METRICS_TOKEN: z.string().min(16).optional(),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function loadApiEnv(source?: Record<string, string | undefined>): ApiEnv {
  return parseEnv(apiEnvSchema, source);
}
