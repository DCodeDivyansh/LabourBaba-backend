import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { redis } from "../config/redis";
import { normalizePhoneToE164 } from "../utils/authUtils";
import { authConfig } from "../config/authConfig";

interface MemoryRateLimitRecord {
  count: number;
  resetAt: number;
}

const memoryStore = new Map<string, MemoryRateLimitRecord>();

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
async function incrementRateLimit(
  key: string,
  maxLimit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number }> {
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

function extractDeviceId(req: Request): string | null {
  const bodyDeviceId = req.body?.device_id;
  if (bodyDeviceId && typeof bodyDeviceId === "string" && bodyDeviceId.trim().length > 0) {
    return bodyDeviceId.trim();
  }
  const headerDeviceId = req.headers["x-device-id"];
  if (headerDeviceId && typeof headerDeviceId === "string" && headerDeviceId.trim().length > 0) {
    return headerDeviceId.trim();
  }
  return null;
}

/**
 * Multi-dimension Rate limiter for OTP Send requests:
 * - IP limit: 10 requests per 15 minutes
 * - Phone limit: 5 requests per 15 minutes
 * - Device limit: 5 requests per 15 minutes (if device_id provided)
 */
export async function otpRequestRateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = req.ip || req.socket.remoteAddress || "unknown_ip";
  const rawPhone = req.body?.phone;
  const phone = safeNormalizePhone(rawPhone);
  const deviceId = extractDeviceId(req);
  const windowSeconds = authConfig.otpRateLimitWindowSeconds;

  // 1. IP rate limit check
  const ipKey = `ratelimit:otp:req:ip:${hashIdentifier(ip)}`;
  const ipResult = await incrementRateLimit(ipKey, authConfig.otpMaxRequestsPerIp, windowSeconds);
  if (!ipResult.allowed) {
    res.setHeader("Retry-After", String(windowSeconds));
    res.status(429).json({
      success: false,
      code: "OTP_RATE_LIMITED",
      message: "Too many OTP requests from this IP. Please try again later.",
      error: {
        code: "OTP_RATE_LIMITED",
        message: "Too many OTP requests from this IP. Please try again later.",
        request_id: req.id,
      },
    });
    return;
  }

  // 2. Phone rate limit check (if phone provided and valid)
  if (phone) {
    const phoneKey = `ratelimit:otp:req:phone:${hashIdentifier(phone)}`;
    const phoneResult = await incrementRateLimit(phoneKey, authConfig.otpMaxRequestsPerPhone, windowSeconds);
    if (!phoneResult.allowed) {
      res.setHeader("Retry-After", String(windowSeconds));
      res.status(429).json({
        success: false,
        code: "OTP_RATE_LIMITED",
        message: "Too many OTP requests for this phone number. Please wait before requesting another.",
        error: {
          code: "OTP_RATE_LIMITED",
          message: "Too many OTP requests for this phone number. Please wait before requesting another.",
          request_id: req.id,
        },
      });
      return;
    }
  }

  // 3. Device rate limit check (if device ID provided)
  if (deviceId) {
    const deviceKey = `ratelimit:otp:req:device:${hashIdentifier(deviceId)}`;
    const deviceResult = await incrementRateLimit(deviceKey, authConfig.otpMaxRequestsPerDevice, windowSeconds);
    if (!deviceResult.allowed) {
      res.setHeader("Retry-After", String(windowSeconds));
      res.status(429).json({
        success: false,
        code: "OTP_RATE_LIMITED",
        message: "Too many OTP requests from this device. Please wait before requesting another.",
        error: {
          code: "OTP_RATE_LIMITED",
          message: "Too many OTP requests from this device. Please wait before requesting another.",
          request_id: req.id,
        },
      });
      return;
    }
  }

  next();
}

/**
 * Multi-dimension Rate limiter for OTP Verify requests:
 * - IP limit: 15 attempts per 15 minutes
 * - Phone limit: 10 attempts per 15 minutes
 * - Device limit: 10 attempts per 15 minutes (if device_id provided)
 */
export async function otpVerifyRateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = req.ip || req.socket.remoteAddress || "unknown_ip";
  const rawPhone = req.body?.phone;
  const phone = safeNormalizePhone(rawPhone);
  const deviceId = extractDeviceId(req);
  const windowSeconds = authConfig.otpRateLimitWindowSeconds;

  // 1. IP rate limit check
  const ipKey = `ratelimit:otp:verify:ip:${hashIdentifier(ip)}`;
  const ipResult = await incrementRateLimit(ipKey, authConfig.otpMaxVerifyAttemptsPerIp, windowSeconds);
  if (!ipResult.allowed) {
    res.setHeader("Retry-After", String(windowSeconds));
    res.status(429).json({
      success: false,
      code: "OTP_RATE_LIMITED",
      message: "Too many verification attempts from this IP. Please try again later.",
      error: {
        code: "OTP_RATE_LIMITED",
        message: "Too many verification attempts from this IP. Please try again later.",
        request_id: req.id,
      },
    });
    return;
  }

  // 2. Phone rate limit check
  if (phone) {
    const phoneKey = `ratelimit:otp:verify:phone:${hashIdentifier(phone)}`;
    const phoneResult = await incrementRateLimit(phoneKey, authConfig.otpMaxVerifyAttemptsPerPhone, windowSeconds);
    if (!phoneResult.allowed) {
      res.setHeader("Retry-After", String(windowSeconds));
      res.status(429).json({
        success: false,
        code: "OTP_RATE_LIMITED",
        message: "Too many verification attempts for this phone number. Please try again later.",
        error: {
          code: "OTP_RATE_LIMITED",
          message: "Too many verification attempts for this phone number. Please try again later.",
          request_id: req.id,
        },
      });
      return;
    }
  }

  // 3. Device rate limit check
  if (deviceId) {
    const deviceKey = `ratelimit:otp:verify:device:${hashIdentifier(deviceId)}`;
    const deviceResult = await incrementRateLimit(deviceKey, authConfig.otpMaxVerifyAttemptsPerDevice, windowSeconds);
    if (!deviceResult.allowed) {
      res.setHeader("Retry-After", String(windowSeconds));
      res.status(429).json({
        success: false,
        code: "OTP_RATE_LIMITED",
        message: "Too many verification attempts from this device. Please try again later.",
        error: {
          code: "OTP_RATE_LIMITED",
          message: "Too many verification attempts from this device. Please try again later.",
          request_id: req.id,
        },
      });
      return;
    }
  }

  next();
}

export function resetMemoryRateLimiter(): void {
  memoryStore.clear();
}

