// src/config/bullmq.ts
// BullMQ bundles its own ioredis. Passing a top-level IORedis instance causes
// structural type incompatibility between the two ioredis versions.
// Solution: pass a plain ConnectionOptions object — BullMQ builds its own client.
import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import 'dotenv/config';

export const DISPATCH_QUEUE_NAME = 'dispatch';
export const TIMEOUT_QUEUE_NAME = 'timeout';

export const DISPATCH_JOB_NAMES = {
  DISPATCH_WAVE: 'dispatch-wave',
  WAVE_TIMEOUT: 'wave-timeout',
} as const;

export class DispatchQueueUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'DispatchQueueUnavailableError';
    if (cause) (this as any).cause = cause;
  }
}

/**
 * Validates BullMQ and Redis connection configuration on startup.
 * Throws fast if production environment lacks mandatory Redis coordinates.
 */
export function assertBullMQConfig(): void {
  if (process.env.NODE_ENV === 'test') {
    return;
  }
  const host = process.env.REDIS_HOST?.trim();
  const port = process.env.REDIS_PORT?.trim();
  if (!host) {
    throw new Error('[BULLMQ_CONFIG_ERROR] REDIS_HOST is required for BullMQ dispatch engine.');
  }
  if (!port || isNaN(Number(port))) {
    throw new Error('[BULLMQ_CONFIG_ERROR] Valid REDIS_PORT is required for BullMQ dispatch engine.');
  }
}

const parseEnvString = (val?: string): string | undefined => {
  if (!val) return undefined;
  const trimmed = val.trim().replace(/^['"]|['"]$/g, '');
  return trimmed.length > 0 ? trimmed : undefined;
};

export const redisConnectionOptions: ConnectionOptions = {
  username: parseEnvString(process.env.REDIS_USERNAME),
  password: parseEnvString(process.env.REDIS_PASSWORD),
  host: parseEnvString(process.env.REDIS_HOST) || '127.0.0.1',
  port: Number(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: null,
  enableOfflineQueue: false,
  connectTimeout: 10000,
};

export const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 1000,
  },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

export const dispatchQueue = new Queue(DISPATCH_QUEUE_NAME, {
  connection: redisConnectionOptions,
  defaultJobOptions,
});

export const timeoutQueue = new Queue(TIMEOUT_QUEUE_NAME, {
  connection: redisConnectionOptions,
  defaultJobOptions,
});
