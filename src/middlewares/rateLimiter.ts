import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { redis } from "../config/redis";
import { logger } from "../utils/logger";

interface MemoryRateLimitRecord {
  count: number;
  resetAt: number;
}

const memoryStore = new Map<string, MemoryRateLimitRecord>();

export interface RateLimitOptions {
  windowSeconds: number;
  maxLimit: number;
  keyPrefix: string;
  errorMessage?: string;
  keyGenerator?: (req: Request) => string | string[] | null | undefined;
  dimension?: "ip" | "user" | "worker" | "phone" | "device" | "custom";
}

/**
 * Hashes sensitive identifiers using SHA-256 to ensure rate limiter keys
 * do not leak plaintext PII (phone numbers, IP addresses, device IDs) into Redis logs or stores.
 */
export function hashIdentifier(val: string): string {
  return crypto.createHash("sha256").update(val).digest("hex").slice(0, 16);
}

/**
 * Atomic rate limiting increment with window expiration and memory fallback.
 */
export async function incrementRateLimit(
  key: string,
  maxLimit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number; resetAfterSeconds: number }> {
  const isTest = process.env.NODE_ENV === "test";
  const hasRedis = Boolean(process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || process.env.REDIS_TOKEN || process.env.REDIS_HOST);

  // If in test environment without Redis connection configured, use in-memory store
  if (isTest && !hasRedis) {
    const now = Date.now();
    const existing = memoryStore.get(key);

    if (!existing || existing.resetAt <= now) {
      memoryStore.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { allowed: true, remaining: maxLimit - 1, resetAfterSeconds: windowSeconds };
    }

    if (existing.count >= maxLimit) {
      const resetAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      return { allowed: false, remaining: 0, resetAfterSeconds: resetAfter };
    }

    existing.count += 1;
    const resetAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    return { allowed: true, remaining: maxLimit - existing.count, resetAfterSeconds: resetAfter };
  }

  // Production Redis-backed rate limiting using atomic incr + expire
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSeconds);
    }
    const ttl = await redis.get(`${key}:ttl`) || windowSeconds;
    const resetAfter = typeof ttl === "number" ? ttl : windowSeconds;

    if (count > maxLimit) {
      return { allowed: false, remaining: 0, resetAfterSeconds: resetAfter };
    }
    return { allowed: true, remaining: maxLimit - count, resetAfterSeconds: resetAfter };
  } catch (err: any) {
    logger.warn(`[RATE_LIMIT] Redis check failed for key ${key}, falling back to memory:`, { error: err.message });
    // Graceful fallback to memory on transient Redis error
    const now = Date.now();
    const existing = memoryStore.get(key);
    if (!existing || existing.resetAt <= now) {
      memoryStore.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { allowed: true, remaining: maxLimit - 1, resetAfterSeconds: windowSeconds };
    }
    if (existing.count >= maxLimit) {
      const resetAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      return { allowed: false, remaining: 0, resetAfterSeconds: resetAfter };
    }
    existing.count += 1;
    const resetAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    return { allowed: true, remaining: maxLimit - existing.count, resetAfterSeconds: resetAfter };
  }
}

/**
 * Creates a route-specific rate limiting middleware.
 */
export function createRateLimiter(options: RateLimitOptions) {
  const {
    windowSeconds,
    maxLimit,
    keyPrefix,
    errorMessage = "Too many requests. Please try again later.",
    keyGenerator,
    dimension = "ip",
  } = options;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let keys: string[] = [];

    if (keyGenerator) {
      const gen = keyGenerator(req);
      if (Array.isArray(gen)) {
        keys = gen.filter(Boolean);
      } else if (gen) {
        keys = [gen];
      }
    } else {
      switch (dimension) {
        case "user": {
          const userId = (req as any).user?.id || (req as any).worker?.id;
          if (userId) {
            keys.push(`ratelimit:${keyPrefix}:user:${hashIdentifier(userId)}`);
          } else {
            const ip = req.ip || req.socket.remoteAddress || "unknown_ip";
            keys.push(`ratelimit:${keyPrefix}:ip:${hashIdentifier(ip)}`);
          }
          break;
        }
        case "worker": {
          const workerId = (req as any).worker?.id || (req as any).user?.id;
          if (workerId) {
            keys.push(`ratelimit:${keyPrefix}:worker:${hashIdentifier(workerId)}`);
          } else {
            const ip = req.ip || req.socket.remoteAddress || "unknown_ip";
            keys.push(`ratelimit:${keyPrefix}:ip:${hashIdentifier(ip)}`);
          }
          break;
        }
        case "ip":
        default: {
          const ip = req.ip || req.socket.remoteAddress || "unknown_ip";
          keys.push(`ratelimit:${keyPrefix}:ip:${hashIdentifier(ip)}`);
          break;
        }
      }
    }

    if (keys.length === 0) {
      return next();
    }

    for (const key of keys) {
      const result = await incrementRateLimit(key, maxLimit, windowSeconds);

      if (!result.allowed) {
        res.setHeader("Retry-After", String(result.resetAfterSeconds));
        res.status(429).json({
          success: false,
          error: {
            code: "RATE_LIMITED",
            message: errorMessage,
            request_id: req.id,
          },
        });
        return;
      }
    }

    next();
  };
}

/**
 * Pre-configured rate limiters for standard application routes
 */

// Auth / Login endpoint: 20 requests per 15 minutes per IP
export const authEndpointRateLimiter = createRateLimiter({
  windowSeconds: 15 * 60,
  maxLimit: 20,
  keyPrefix: "auth",
  errorMessage: "Too many authentication requests from this IP. Please try again later.",
  dimension: "ip",
});

// Dispatch actions (accept, decline): 30 actions per minute per worker
export const dispatchActionRateLimiter = createRateLimiter({
  windowSeconds: 60,
  maxLimit: 30,
  keyPrefix: "dispatch_action",
  errorMessage: "Too many dispatch operations. Please slow down.",
  dimension: "worker",
});

// Chat message sending: 60 messages per minute per user
export const chatMessageRateLimiter = createRateLimiter({
  windowSeconds: 60,
  maxLimit: 60,
  keyPrefix: "chat_msg",
  errorMessage: "Message rate limit exceeded. Please wait a moment before sending more messages.",
  dimension: "user",
});

// Worker location update: 120 updates per minute per worker
export const workerLocationRateLimiter = createRateLimiter({
  windowSeconds: 60,
  maxLimit: 120,
  keyPrefix: "worker_location",
  errorMessage: "Location update frequency too high. Updates throttled.",
  dimension: "worker",
});

export function resetAllMemoryRateLimiters(): void {
  memoryStore.clear();
}
