import { baseEnvSchema, parseEnv } from '@coderexic/core';
import { z } from 'zod';

export const apiEnvSchema = baseEnvSchema.extend({
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;

export function loadApiEnv(source?: Record<string, string | undefined>): ApiEnv {
  return parseEnv(apiEnvSchema, source);
}
