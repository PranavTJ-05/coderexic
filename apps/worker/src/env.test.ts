import { describe, expect, it } from 'vitest';
import { loadWorkerEnv } from './env.js';

const valid = {
  DATABASE_URL: 'postgres://coderexic:pw@localhost:5432/coderexic',
  REDIS_URL: 'redis://localhost:6379',
  GITHUB_APP_ID: '123',
  GITHUB_PRIVATE_KEY: 'not-checked-here',
  GEMINI_API_KEY: 'key',
};

describe('loadWorkerEnv', () => {
  it('defaults AGENT_LOOP_ENABLED to false', () => {
    expect(loadWorkerEnv(valid).AGENT_LOOP_ENABLED).toBe(false);
  });

  it('parses the string "true" as true', () => {
    expect(loadWorkerEnv({ ...valid, AGENT_LOOP_ENABLED: 'true' }).AGENT_LOOP_ENABLED).toBe(true);
  });

  it('parses the string "false" as false, not as a truthy non-empty string', () => {
    expect(loadWorkerEnv({ ...valid, AGENT_LOOP_ENABLED: 'false' }).AGENT_LOOP_ENABLED).toBe(false);
  });

  it('rejects an unrecognized value rather than silently defaulting', () => {
    expect(() => loadWorkerEnv({ ...valid, AGENT_LOOP_ENABLED: 'yes' })).toThrow();
  });
});

describe('loadWorkerEnv MODEL_PROVIDER', () => {
  it('defaults to gemini and requires only GEMINI_API_KEY', () => {
    expect(loadWorkerEnv(valid).MODEL_PROVIDER).toBe('gemini');
  });

  it('boots on groq alone, without any GEMINI_API_KEY set', () => {
    const { GEMINI_API_KEY: _omitted, ...withoutGemini } = valid;
    const env = loadWorkerEnv({
      ...withoutGemini,
      MODEL_PROVIDER: 'groq',
      GROQ_API_KEY: 'groq-key',
    });
    expect(env.MODEL_PROVIDER).toBe('groq');
    expect(env.GROQ_API_KEY).toBe('groq-key');
  });

  it('rejects a selected provider with no configured key', () => {
    expect(() => loadWorkerEnv({ ...valid, MODEL_PROVIDER: 'anthropic' })).toThrow();
  });

  it('rejects an unrecognized provider name', () => {
    expect(() => loadWorkerEnv({ ...valid, MODEL_PROVIDER: 'llama' })).toThrow();
  });
});
