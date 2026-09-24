import { z } from 'zod';

/**
 * Settings every Coderexic process needs. Apps extend this schema with their
 * own settings; later phases add GitHub, model provider and encryption settings.
 */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Validates environment variables against a schema. Error messages name the
 * variable and the problem but never include the offending value, since
 * values may be secrets.
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    return issue.code === 'invalid_type' && source[key] === undefined
      ? `${key}: required`
      : `${key}: ${issue.message}`;
  });
  throw new EnvValidationError(issues);
}
