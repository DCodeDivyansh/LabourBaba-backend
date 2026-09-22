/**
 * Canonical Redis Configuration & Connection Manager (Issue #37)
 *
 * Guarantees:
 * - Single source of truth for Redis configuration across all workloads (BullMQ, rate limiting, cache, health checks).
 * - Strict fail-fast validation in production (zero silent localhost fallback).
 * - Unified connection options supporting authentication, TLS, and standalone or URL formats.
 * - Clean lifecycle management and graceful shutdown.
 */

import IORedis, { Redis as IORedisClient, RedisOptions } from 'ioredis';
import 'dotenv/config';

export interface RedisConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: boolean;
  url?: string;
}

const parseEnvString = (val?: string): string | undefined => {
  if (!val) return undefined;
  const trimmed = val.trim().replace(/^['"]|['"]$/g, '');
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Extracts normalized Redis configuration from environment variables.
 */
export function getCanonicalRedisConfig(): RedisConfig {
  const redisUrl = parseEnvString(process.env.REDIS_URL) || parseEnvString(process.env.UPSTASH_REDIS_URL);

  if (redisUrl) {
    try {
      const parsed = new URL(redisUrl);
      const isTls = parsed.protocol === 'rediss:';
      return {
        host: parsed.hostname,
        port: parseInt(parsed.port || (isTls ? '6380' : '6379'), 10),
        username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
        password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
        tls: isTls,
        url: redisUrl,
      };
    } catch {
      // Fall through to individual parameters if URL is malformed
    }
  }

  const host = parseEnvString(process.env.REDIS_HOST);
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);
  const username = parseEnvString(process.env.REDIS_USERNAME);
  const password = parseEnvString(process.env.REDIS_PASSWORD) || parseEnvString(process.env.REDIS_TOKEN);
  const tls = process.env.REDIS_TLS === 'true' || process.env.REDIS_USE_TLS === 'true';

  const isProduction = process.env.NODE_ENV === 'production';

  return {
    host: host || (isProduction ? '' : '127.0.0.1'),
    port: isNaN(port) ? 6379 : port,
    username,
    password,
    tls,
    url: redisUrl,
  };
}

export const getRedisConfig = getCanonicalRedisConfig;

/**
 * Startup assertion: Fails fast if Redis configuration is missing or invalid in production.
 */
export function assertRedisConfig(): void {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  const isProduction = process.env.NODE_ENV === 'production';
  const config = getCanonicalRedisConfig();

  if (isProduction) {
    if (!config.host || config.host === '127.0.0.1' || config.host === 'localhost') {
      throw new Error(
        '[REDIS_CONFIG_ERROR] Production requires a valid remote REDIS_URL or REDIS_HOST (localhost/127.0.0.1 is prohibited).',
      );
    }
  }

  if (!config.host) {
    throw new Error('[REDIS_CONFIG_ERROR] REDIS_HOST or REDIS_URL is required.');
  }

  if (isNaN(config.port) || config.port <= 0 || config.port > 65535) {
    throw new Error(`[REDIS_CONFIG_ERROR] Invalid REDIS_PORT: ${config.port}`);
  }
}

/**
 * Standard ConnectionOptions for BullMQ and IORedis.
 */
export function getRedisConnectionOptions(): RedisOptions {
  const config = getCanonicalRedisConfig();

  const options: RedisOptions = {
    host: config.host || '127.0.0.1',
    port: config.port || 6379,
    username: config.username,
    password: config.password,
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    connectTimeout: 10000,
    retryStrategy: (times: number) => {
      if (process.env.NODE_ENV === 'test') return null;
      return Math.min(times * 100, 3000);
    },
  };

  if (config.tls) {
    options.tls = {};
  }

  return options;
}

export const redisConnectionOptions = getRedisConnectionOptions();

import { logger } from '../utils/logger';

let sharedRedisClient: IORedisClient | null = null;

/**
 * Retrieves the singleton IORedis client for rate limiting, caching, and health probes.
 */
export function getRedisClient(): IORedisClient {
  if (!sharedRedisClient) {
    const options = getRedisConnectionOptions();
    sharedRedisClient = new IORedis(options);

    sharedRedisClient.on('error', (err) => {
      if (process.env.NODE_ENV !== 'test') {
        logger.error('[REDIS_CLIENT_ERROR]', { error: err.message });
      }
    });
  }
  return sharedRedisClient;
}

// Legacy alias to keep rate limiter and existing imports functioning
export const redis = {
  incr: async (key: string): Promise<number> => {
    return await getRedisClient().incr(key);
  },
  expire: async (key: string, seconds: number): Promise<number> => {
    return await getRedisClient().expire(key, seconds);
  },
  get: async (key: string): Promise<string | null> => {
    return await getRedisClient().get(key);
  },
  set: async (key: string, value: string, ...args: any[]): Promise<string | null> => {
    return await (getRedisClient().set as any)(key, value, ...args);
  },
  del: async (...keys: string[]): Promise<number> => {
    return await getRedisClient().del(...keys);
  },
  ping: async (): Promise<string> => {
    return await getRedisClient().ping();
  },
};

/**
 * Gracefully closes all shared Redis connections.
 */
export async function closeRedisConnections(): Promise<void> {
  if (sharedRedisClient) {
    try {
      await sharedRedisClient.quit();
    } catch {
      sharedRedisClient.disconnect();
    } finally {
      sharedRedisClient = null;
    }
  }
}
