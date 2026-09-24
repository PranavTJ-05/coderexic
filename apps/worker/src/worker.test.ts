import { createLogger } from '@coderexic/core';
import { describe, expect, it } from 'vitest';
import { createWorker } from './worker.js';

const logger = createLogger({ name: 'worker-test', level: 'silent' });

describe('createWorker', () => {
  it('starts and stops', async () => {
    const worker = createWorker({ logger });
    expect(worker.running).toBe(false);
    await worker.start();
    expect(worker.running).toBe(true);
    await worker.stop();
    expect(worker.running).toBe(false);
  });

  it('treats repeated start and stop as no-ops', async () => {
    const worker = createWorker({ logger });
    await worker.start();
    await worker.start();
    await worker.stop();
    await worker.stop();
    expect(worker.running).toBe(false);
  });
});
