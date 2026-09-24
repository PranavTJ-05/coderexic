import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { baseEnvSchema, EnvValidationError, parseEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgres://coderexic:pw@localhost:5432/coderexic',
  REDIS_URL: 'redis://localhost:6379',
};

describe('parseEnv', () => {
  it('applies defaults for optional settings', () => {
    const env = parseEnv(baseEnvSchema, valid);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.DATABASE_URL).toBe(valid.DATABASE_URL);
  });

  it('treats an empty value as unset', () => {
    let error: unknown;
    try {
      parseEnv(baseEnvSchema, { ...valid, DATABASE_URL: '' });
    } catch (err) {
      error = err;
    }
    expect((error as EnvValidationError).issues).toEqual(['DATABASE_URL: required']);
    expect(parseEnv(baseEnvSchema, { ...valid, LOG_LEVEL: '' }).LOG_LEVEL).toBe('info');
  });

  it('reports a missing required variable by name', () => {
    const { DATABASE_URL: _omitted, ...rest } = valid;
    expect(() => parseEnv(baseEnvSchema, rest)).toThrow(EnvValidationError);
    try {
      parseEnv(baseEnvSchema, rest);
    } catch (err) {
      expect((err as EnvValidationError).issues).toEqual(['DATABASE_URL: required']);
    }
  });

  it('rejects an invalid value without echoing it', () => {
    const badUrl = 'mysql://user:hunter2@db/app';
    let error: unknown;
    try {
      parseEnv(baseEnvSchema, { ...valid, DATABASE_URL: badUrl });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    expect((error as Error).message).toContain('DATABASE_URL');
    expect((error as Error).message).not.toContain('hunter2');
  });

  it('rejects values outside an enum', () => {
    expect(() => parseEnv(baseEnvSchema, { ...valid, NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('supports app-specific extensions of the base schema', () => {
    const schema = baseEnvSchema.extend({ PORT: z.coerce.number().int().default(3000) });
    expect(parseEnv(schema, { ...valid, PORT: '8080' }).PORT).toBe(8080);
  });
});
