import { Request, Response, NextFunction } from "express";
import { redis } from "../config/redis";
import { normalizePhoneToE164 } from "../utils/authUtils";

interface MemoryRateLimitRecord {
  count: number;
  resetAt: number;
}

const memoryStore = new Map<string, MemoryRateLimitRecord>();

async function incrementRateLimit(key: string, maxLimit: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number }> {
  // If in test environment or Redis token is absent, use in-memory store
  const isTest = process.env.NODE_ENV === "test";
  const hasRedisToken = Boolean(process.env.REDIS_TOKEN);

  if (isTest || !hasRedisToken) {
    const now = Date.now();
    const existing = memoryStore.get(key);

    if (!existing || existing.resetAt <= now) {
      memoryStore.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { allowed: true, remaining: maxLimit - 1 };
    }

    if (existing.count >= maxLimit) {
      return { allowed: false, remaining: 0 };
    }

    existing.count += 1;
    return { allowed: true, remaining: maxLimit - existing.count };
  }

  // Production Redis-backed rate limiting using atomic incr + expire
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSeconds);
    }
    if (count > maxLimit) {
      return { allowed: false, remaining: 0 };
    }
    return { allowed: true, remaining: maxLimit - count };
  } catch (err) {
    console.warn(`[RATE_LIMIT] Redis check failed for key ${key}, falling back to memory:`, err);
    // Graceful fallback to memory on transient Redis error
    const now = Date.now();
    const existing = memoryStore.get(key);
    if (!existing || existing.resetAt <= now) {
      memoryStore.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { allowed: true, remaining: maxLimit - 1 };
    }
    if (existing.count >= maxLimit) {
      return { allowed: false, remaining: 0 };
    }
    existing.count += 1;
    return { allowed: true, remaining: maxLimit - existing.count };
  }
}

function safeNormalizePhone(rawPhone?: string): string | null {
  if (!rawPhone || typeof rawPhone !== "string") return null;
  try {
    return normalizePhoneToE164(rawPhone);
  } catch {
    return null;
  }
}

/**
 * Rate limiter for OTP Send requests:
 * - 5 requests per phone per 15 minutes
 * - 10 requests per IP per 15 minutes
 */
export async function otpRequestRateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = req.ip || req.socket.remoteAddress || "unknown_ip";
  const rawPhone = req.body?.phone;
  const phone = safeNormalizePhone(rawPhone);
  const windowSeconds = 15 * 60; // 15 minutes

  // 1. IP rate limit check
  const ipKey = `ratelimit:otp:req:ip:${ip}`;
  const ipResult = await incrementRateLimit(ipKey, 10, windowSeconds);
  if (!ipResult.allowed) {
    res.status(429).json({
      success: false,
      code: "OTP_RATE_LIMITED",
      message: "Too many OTP requests from this IP. Please try again later.",
    });
    return;
  }

  // 2. Phone rate limit check (if phone provided and valid)
  if (phone) {
    const phoneKey = `ratelimit:otp:req:phone:${phone}`;
    const phoneResult = await incrementRateLimit(phoneKey, 5, windowSeconds);
    if (!phoneResult.allowed) {
      res.status(429).json({
        success: false,
        code: "OTP_RATE_LIMITED",
        message: "Too many OTP requests for this phone number. Please wait before requesting another.",
      });
      return;
    }
  }

  next();
}

/**
 * Rate limiter for OTP Verify requests:
 * - 15 attempts per IP per 15 minutes
 * - 10 attempts per phone per 15 minutes
 */
export async function otpVerifyRateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = req.ip || req.socket.remoteAddress || "unknown_ip";
  const rawPhone = req.body?.phone;
  const phone = safeNormalizePhone(rawPhone);
  const windowSeconds = 15 * 60;

  // 1. IP rate limit check
  const ipKey = `ratelimit:otp:verify:ip:${ip}`;
  const ipResult = await incrementRateLimit(ipKey, 15, windowSeconds);
  if (!ipResult.allowed) {
    res.status(429).json({
      success: false,
      code: "OTP_RATE_LIMITED",
      message: "Too many verification attempts from this IP. Please try again later.",
    });
    return;
  }

  // 2. Phone rate limit check
  if (phone) {
    const phoneKey = `ratelimit:otp:verify:phone:${phone}`;
    const phoneResult = await incrementRateLimit(phoneKey, 10, windowSeconds);
    if (!phoneResult.allowed) {
      res.status(429).json({
        success: false,
        code: "OTP_RATE_LIMITED",
        message: "Too many verification attempts for this phone number. Please try again later.",
      });
      return;
    }
  }

  next();
}

export function resetMemoryRateLimiter(): void {
  memoryStore.clear();
}
