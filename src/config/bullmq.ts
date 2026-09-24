// src/config/bullmq.ts
// BullMQ bundles its own ioredis. Passing a plain ConnectionOptions object from canonical redis.ts
import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import 'dotenv/config';
import { redisConnectionOptions, assertRedisConfig } from './redis';

export { redisConnectionOptions, assertRedisConfig };

export const DISPATCH_QUEUE_NAME = 'dispatch';
export const TIMEOUT_QUEUE_NAME = 'timeout';
export const NOTIFICATION_QUEUE_NAME = 'notification';

export const DISPATCH_JOB_NAMES = {
  DISPATCH_WAVE: 'dispatch-wave',
  WAVE_TIMEOUT: 'wave-timeout',
  DISPATCH_NOTIFY: 'dispatch-notify',
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
 * Delegates directly to the canonical assertRedisConfig gatekeeper.
 */
export function assertBullMQConfig(): void {
  assertRedisConfig();
}

export const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 1000,
  },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

function sanitizeJobOptions<T>(opts?: T): T {
  if (!opts) return opts as T;
  const anyOpts = opts as any;
  if (anyOpts.jobId && typeof anyOpts.jobId === 'string' && anyOpts.jobId.includes(':')) {
    return { ...anyOpts, jobId: anyOpts.jobId.replace(/:/g, '__') };
  }
  return opts;
}

function wrapQueue<T extends Queue>(queue: T): T {
  const originalAdd = queue.add.bind(queue);
  queue.add = ((name: any, data: any, opts: any) => {
    return originalAdd(name, data, sanitizeJobOptions(opts));
  }) as any;
  return queue;
}

export const dispatchQueue = wrapQueue(
  new Queue(DISPATCH_QUEUE_NAME, {
    connection: redisConnectionOptions as ConnectionOptions,
    defaultJobOptions,
  }),
);

export const timeoutQueue = wrapQueue(
  new Queue(TIMEOUT_QUEUE_NAME, {
    connection: redisConnectionOptions as ConnectionOptions,
    defaultJobOptions,
  }),
);

/**
 * Dedicated queue for durable notification delivery (FCM + Socket.IO).
 * Notifications are enqueued here AFTER the dispatch DB transaction commits,
 * ensuring the invariant: PostgreSQL COMMIT → notification enqueue → delivery.
 * Failures in delivery are retried by BullMQ and never roll back persisted state.
 */
export const notificationQueue = wrapQueue(
  new Queue(NOTIFICATION_QUEUE_NAME, {
    connection: redisConnectionOptions as ConnectionOptions,
    defaultJobOptions: {
      ...defaultJobOptions,
      attempts: 5, // More retries for notification delivery
      backoff: {
        type: 'exponential' as const,
        delay: 2000,
      },
    },
  }),
);

/**
 * Creates an isolated BullMQ queue instance with standard configuration.
 */
export function createBullMQQueue(name: string, options?: any): Queue {
  return wrapQueue(
    new Queue(name, {
      connection: redisConnectionOptions as ConnectionOptions,
      defaultJobOptions,
      ...options,
    }),
  );
}

