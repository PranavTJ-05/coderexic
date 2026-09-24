import type { Logger } from '@coderexic/core';

export interface Worker {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly running: boolean;
}

/**
 * Worker lifecycle shell. Queue consumers (review and indexing jobs) are
 * attached here in later phases; for now it only manages start and stop.
 */
export function createWorker({ logger }: { logger: Logger }): Worker {
  let running = false;
  let keepAlive: NodeJS.Timeout | undefined;

  return {
    get running() {
      return running;
    },
    start() {
      if (running) return Promise.resolve();
      running = true;
      // Holds the event loop open until consumers exist to do it.
      keepAlive = setInterval(() => undefined, 60_000);
      logger.info('worker started');
      return Promise.resolve();
    },
    stop() {
      if (!running) return Promise.resolve();
      running = false;
      clearInterval(keepAlive);
      keepAlive = undefined;
      logger.info('worker stopped');
      return Promise.resolve();
    },
  };
}
