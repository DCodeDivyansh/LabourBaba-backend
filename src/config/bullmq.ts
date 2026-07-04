// src/config/bullmq.ts
// BullMQ bundles its own ioredis. Passing a top-level IORedis instance causes
// structural type incompatibility between the two ioredis versions.
// Solution: pass a plain ConnectionOptions object — BullMQ builds its own client.
import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import 'dotenv/config';

// const redis = new Redis({
//   host: "127.0.0.1",
//   port: 6379,
// });
// Using local Redis instead of Aiven
// export const redisConnectionOptions: ConnectionOptions = {
//   host: '127.0.0.1',
//   port: 6379,
//   // Note: Local redis usually doesn't need tls, password, or username.
//   maxRetriesPerRequest: null, // required by BullMQ — must NOT be a positive number
//   keepAlive: 30_000,
//   lazyConnect: false,
// };
console.log('[bullmq] Redis config:', {
  host: process.env.AIVEN_REDIS_HOST ?? 'MISSING',
  port: process.env.AIVEN_REDIS_PORT ?? 'MISSING',
  password: process.env.AIVEN_REDIS_PASSWORD ? 'SET' : 'MISSING',
  username: process.env.AIVEN_REDIS_USERNAME ?? 'MISSING',
});

export const redisConnectionOptions: ConnectionOptions = {
  host: process.env.AIVEN_REDIS_HOST,
  port: Number(process.env.AIVEN_REDIS_PORT) || 6379,
  password: process.env.AIVEN_REDIS_PASSWORD,
  username: process.env.AIVEN_REDIS_USERNAME ?? 'default',
  tls: { rejectUnauthorized: false },
  maxRetriesPerRequest: null,
  enableOfflineQueue: false,  // ← add this
  connectTimeout: 10000,  // ← add this
};


const defaultJobOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 1000,
  },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

export const dispatchQueue = new Queue('dispatch', {
  connection: redisConnectionOptions,
  defaultJobOptions,
});

export const timeoutQueue = new Queue('timeout', {
  connection: redisConnectionOptions,
  defaultJobOptions,
});
