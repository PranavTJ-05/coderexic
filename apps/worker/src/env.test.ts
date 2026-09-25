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
