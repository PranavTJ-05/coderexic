import { Redis } from 'ioredis';

/**
 * BullMQ requires disabling ioredis's own retry limit on request timeouts
 * (it does its own retry/backoff), or Workers throw at construction time.
 */
export function createRedisConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
}
