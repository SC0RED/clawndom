import IORedis from 'ioredis';

import { getSettings } from '../config';

let dedupRedis: IORedis | null = null;

/**
 * Shared Redis connection for dedup checks.
 * Reuses the same REDIS_URL as BullMQ.
 */
export function getDedupRedis(): IORedis {
  if (dedupRedis === null) {
    dedupRedis = new IORedis(getSettings().redisUrl, { maxRetriesPerRequest: null });
  }
  return dedupRedis;
}
