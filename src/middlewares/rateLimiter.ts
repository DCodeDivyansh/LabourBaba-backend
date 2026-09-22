import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { getRedisClient } from "../config/redis";
import { logger } from "../utils/logger";

export type RateLimitFailPolicy = "fail_closed" | "fail_open";

export interface RateLimitOptions {
  windowSeconds: number;
  maxLimit: number;
  keyPrefix: string;
  errorMessage?: string;
  keyGenerator?: (req: Request) => string | string[] | null | undefined;
  dimension?: "ip" | "user" | "worker" | "phone" | "device" | "custom";
  failPolicy?: RateLimitFailPolicy;
  isSecuritySensitive?: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAfterSeconds: number;
  status: "ok" | "exceeded" | "unavailable";
}

/**
 * Hashes sensitive identifiers using SHA-256 to ensure rate limiter keys
 * do not leak plaintext PII (phone numbers, IP addresses, device IDs) into Redis logs or stores.
 */
export function hashIdentifier(val: string): string {
  return crypto.createHash("sha256").update(val).digest("hex").slice(0, 16);
}

/**
 * Canonical Redis Lua script for atomic increment and TTL enforcement.
 * Guarantees that:
 * 1. INCR is atomic across all distributed instances.
 * 2. EXPIRE is set on the first key creation, preventing race conditions or immortal keys.
 * 3. TTL is returned alongside the incremented count in a single roundtrip.
 */
export const RATE_LIMIT_LUA_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
local ttl = redis.call('TTL', KEYS[1])
if ttl == -1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
  ttl = tonumber(ARGV[1])
end
return { current, ttl }
`;

// Test-only in-memory store isolated for mocked unit test environments
interface MemoryRateLimitRecord {
  count: number;
  resetAt: number;
}
const testMemoryStore = new Map<string, MemoryRateLimitRecord>();
let testMemoryFallbackEnabled = process.env.NODE_ENV === "test";

export function enableTestMemoryFallback(enable = true): void {
  testMemoryFallbackEnabled = enable;
}

export function clearRateLimitStore(): void {
  testMemoryStore.clear();
  if (process.env.NODE_ENV === "test") {
    testMemoryFallbackEnabled = true;
  }
}

export function resetAllMemoryRateLimiters(): void {
  testMemoryStore.clear();
  if (process.env.NODE_ENV === "test") {
    testMemoryFallbackEnabled = true;
  }
}

/**
 * Executes an atomic distributed rate-limit check against Redis.
 *
 * Invariants:
 * 1. Distributed Enforcement: When Redis is healthy, all instances share a global rate limit key.
 * 2. Atomic Windows: INCR + EXPIRE are executed atomically via Lua script to prevent immortal keys.
 * 3. Strict Security Policy (Fail-Closed): Security-sensitive operations (Auth, OTP, Payments)
 *    strictly FAIL CLOSED during Redis degradation, preventing distributed brute-force bypasses.
 * 4. High-Throughput Telemetry (Fail-Open): Generic traffic limiters (GPS, Chat) fail open with
 *    logged warnings to preserve basic core functionality.
 */
export async function incrementRateLimit(
  key: string,
  maxLimit: number,
  windowSeconds: number,
  failPolicy: RateLimitFailPolicy = "fail_closed"
): Promise<RateLimitResult> {
  const isProduction = process.env.NODE_ENV === "production";

  // Production environment MUST strictly use Redis — zero in-memory fallback permitted
  try {
    const client = getRedisClient();
    const rawResult = await client.eval(
      RATE_LIMIT_LUA_SCRIPT,
      1,
      key,
      windowSeconds
    );

    const [rawCount, rawTtl] = Array.isArray(rawResult) ? rawResult : [1, windowSeconds];
    const count = Number(rawCount);
    const ttl = Number(rawTtl) > 0 ? Number(rawTtl) : windowSeconds;

    if (count > maxLimit) {
      return {
        allowed: false,
        remaining: 0,
        resetAfterSeconds: ttl,
        status: "exceeded",
      };
    }

    return {
      allowed: true,
      remaining: Math.max(0, maxLimit - count),
      resetAfterSeconds: ttl,
      status: "ok",
    };
  } catch (err: any) {
    // In unit test mode ONLY, if test-memory fallback is explicitly enabled:
    if (!isProduction && testMemoryFallbackEnabled) {
      const now = Date.now();
      const existing = testMemoryStore.get(key);
      if (!existing || existing.resetAt <= now) {
        testMemoryStore.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
        return { allowed: true, remaining: maxLimit - 1, resetAfterSeconds: windowSeconds, status: "ok" };
      }
      if (existing.count >= maxLimit) {
        const resetAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
        return { allowed: false, remaining: 0, resetAfterSeconds: resetAfter, status: "exceeded" };
      }
      existing.count += 1;
      const resetAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      return { allowed: true, remaining: maxLimit - existing.count, resetAfterSeconds: resetAfter, status: "ok" };
    }

    // Security-sensitive rate limiters: Fail closed to prevent distributed brute-force attacks
    if (failPolicy === "fail_closed") {
      logger.error(`[SECURITY_LIMITER_ERROR] Security-sensitive rate limiter failed closed due to Redis error on key ${key}:`, {
        error: err.message,
        key,
      });
      return {
        allowed: false,
        remaining: 0,
        resetAfterSeconds: windowSeconds,
        status: "unavailable",
      };
    }

    // Generic non-security traffic rate limiters: Fail open with structured warning
    logger.warn(`[RATE_LIMIT_DEGRADED] Generic rate limiter failed open due to Redis error on key ${key}:`, {
      error: err.message,
      key,
    });
    return {
      allowed: true,
      remaining: 1,
      resetAfterSeconds: windowSeconds,
      status: "ok",
    };
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
    failPolicy = options.isSecuritySensitive ? "fail_closed" : "fail_open",
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
      const result = await incrementRateLimit(key, maxLimit, windowSeconds, failPolicy);

      if (!result.allowed) {
        if (result.status === "unavailable") {
          res.setHeader("Retry-After", String(result.resetAfterSeconds));
          res.status(503).json({
            success: false,
            code: "SECURITY_LIMITER_UNAVAILABLE",
            message: "Authentication service is temporarily unavailable. Please try again in a few moments.",
            error: {
              code: "SECURITY_LIMITER_UNAVAILABLE",
              message: "Authentication service is temporarily unavailable. Please try again in a few moments.",
              request_id: (req as any).id,
            },
          });
          return;
        }

        res.setHeader("Retry-After", String(result.resetAfterSeconds));
        res.status(429).json({
          success: false,
          code: "RATE_LIMITED",
          message: errorMessage,
          error: {
            code: "RATE_LIMITED",
            message: errorMessage,
            request_id: (req as any).id,
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

// Auth / Login / Register endpoints: 20 requests per 15 minutes per IP (Security-sensitive: FAIL CLOSED)
export const authEndpointRateLimiter = createRateLimiter({
  windowSeconds: 15 * 60,
  maxLimit: 20,
  keyPrefix: "auth",
  errorMessage: "Too many authentication requests from this IP. Please try again later.",
  dimension: "ip",
  failPolicy: "fail_closed",
  isSecuritySensitive: true,
});

// Dispatch actions (accept, decline): 30 actions per minute per worker (Generic: FAIL OPEN)
export const dispatchActionRateLimiter = createRateLimiter({
  windowSeconds: 60,
  maxLimit: 30,
  keyPrefix: "dispatch_action",
  errorMessage: "Too many dispatch operations. Please slow down.",
  dimension: "worker",
  failPolicy: "fail_open",
});

// Chat message sending: 60 messages per minute per user (Generic: FAIL OPEN)
export const chatMessageRateLimiter = createRateLimiter({
  windowSeconds: 60,
  maxLimit: 60,
  keyPrefix: "chat_msg",
  errorMessage: "Message rate limit exceeded. Please wait a moment before sending more messages.",
  dimension: "user",
  failPolicy: "fail_open",
});

// Worker location update: 120 updates per minute per worker (Generic: FAIL OPEN)
export const workerLocationRateLimiter = createRateLimiter({
  windowSeconds: 60,
  maxLimit: 120,
  keyPrefix: "worker_location",
  errorMessage: "Location update frequency too high. Updates throttled.",
  dimension: "worker",
  failPolicy: "fail_open",
});

// Payment Order Creation: 10 requests per 15 minutes per customer user/IP (Financial Security: FAIL CLOSED)
export const paymentOrderRateLimiter = createRateLimiter({
  windowSeconds: 15 * 60,
  maxLimit: 10,
  keyPrefix: "payment_order",
  errorMessage: "Too many payment order attempts. Please wait before creating another order.",
  dimension: "user",
  failPolicy: "fail_closed",
  isSecuritySensitive: true,
});

// Payment Refund Requests: 5 refund requests per 15 minutes per customer user/IP (Financial Security: FAIL CLOSED)
export const paymentRefundRateLimiter = createRateLimiter({
  windowSeconds: 15 * 60,
  maxLimit: 5,
  keyPrefix: "payment_refund",
  errorMessage: "Too many refund requests. Please wait before initiating another refund.",
  dimension: "user",
  failPolicy: "fail_closed",
  isSecuritySensitive: true,
});

