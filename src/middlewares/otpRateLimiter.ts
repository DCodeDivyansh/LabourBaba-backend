import { Request, Response, NextFunction } from "express";
import { normalizePhoneToE164 } from "../utils/authUtils";
import { authConfig } from "../config/authConfig";
import {
  incrementRateLimit,
  hashIdentifier,
  resetAllMemoryRateLimiters,
  enableTestMemoryFallback,
} from "./rateLimiter";

export { hashIdentifier };

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
 *
 * Security Invariant: FAIL CLOSED.
 * When Redis is down/unavailable, requests are rejected with 503 to prevent brute-force attacks across instances.
 */
export async function otpRequestRateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = req.ip || req.socket.remoteAddress || "unknown_ip";
  const rawPhone = req.body?.phone;
  const phone = safeNormalizePhone(rawPhone);
  const deviceId = extractDeviceId(req);
  const windowSeconds = authConfig.otpRateLimitWindowSeconds;

  // 1. IP rate limit check
  const ipKey = `ratelimit:otp:req:ip:${hashIdentifier(ip)}`;
  const ipResult = await incrementRateLimit(ipKey, authConfig.otpMaxRequestsPerIp, windowSeconds, "fail_closed");
  if (!ipResult.allowed) {
    if (ipResult.status === "unavailable") {
      res.setHeader("Retry-After", String(ipResult.resetAfterSeconds));
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

    res.setHeader("Retry-After", String(ipResult.resetAfterSeconds));
    res.status(429).json({
      success: false,
      code: "OTP_RATE_LIMITED",
      message: "Too many OTP requests from this IP. Please try again later.",
      error: {
        code: "OTP_RATE_LIMITED",
        message: "Too many OTP requests from this IP. Please try again later.",
        request_id: (req as any).id,
      },
    });
    return;
  }

  // 2. Phone rate limit check (if phone provided and valid)
  if (phone) {
    const phoneKey = `ratelimit:otp:req:phone:${hashIdentifier(phone)}`;
    const phoneResult = await incrementRateLimit(phoneKey, authConfig.otpMaxRequestsPerPhone, windowSeconds, "fail_closed");
    if (!phoneResult.allowed) {
      if (phoneResult.status === "unavailable") {
        res.setHeader("Retry-After", String(phoneResult.resetAfterSeconds));
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

      res.setHeader("Retry-After", String(phoneResult.resetAfterSeconds));
      res.status(429).json({
        success: false,
        code: "OTP_RATE_LIMITED",
        message: "Too many OTP requests for this phone number. Please wait before requesting another.",
        error: {
          code: "OTP_RATE_LIMITED",
          message: "Too many OTP requests for this phone number. Please wait before requesting another.",
          request_id: (req as any).id,
        },
      });
      return;
    }
  }

  // 3. Device rate limit check (if device ID provided)
  if (deviceId) {
    const deviceKey = `ratelimit:otp:req:device:${hashIdentifier(deviceId)}`;
    const deviceResult = await incrementRateLimit(deviceKey, authConfig.otpMaxRequestsPerDevice, windowSeconds, "fail_closed");
    if (!deviceResult.allowed) {
      if (deviceResult.status === "unavailable") {
        res.setHeader("Retry-After", String(deviceResult.resetAfterSeconds));
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

      res.setHeader("Retry-After", String(windowSeconds));
      res.status(429).json({
        success: false,
        code: "OTP_RATE_LIMITED",
        message: "Too many OTP requests from this device. Please wait before requesting another.",
        error: {
          code: "OTP_RATE_LIMITED",
          message: "Too many OTP requests from this device. Please wait before requesting another.",
          request_id: (req as any).id,
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
 *
 * Security Invariant: FAIL CLOSED.
 * When Redis is down/unavailable, requests are rejected with 503 to prevent brute-force attacks across instances.
 */
export async function otpVerifyRateLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
  const ip = req.ip || req.socket.remoteAddress || "unknown_ip";
  const rawPhone = req.body?.phone;
  const phone = safeNormalizePhone(rawPhone);
  const deviceId = extractDeviceId(req);
  const windowSeconds = authConfig.otpRateLimitWindowSeconds;

  // 1. IP rate limit check
  const ipKey = `ratelimit:otp:verify:ip:${hashIdentifier(ip)}`;
  const ipResult = await incrementRateLimit(ipKey, authConfig.otpMaxVerifyAttemptsPerIp, windowSeconds, "fail_closed");
  if (!ipResult.allowed) {
    if (ipResult.status === "unavailable") {
      res.setHeader("Retry-After", String(ipResult.resetAfterSeconds));
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

    res.setHeader("Retry-After", String(ipResult.resetAfterSeconds));
    res.status(429).json({
      success: false,
      code: "OTP_RATE_LIMITED",
      message: "Too many verification attempts from this IP. Please try again later.",
      error: {
        code: "OTP_RATE_LIMITED",
        message: "Too many verification attempts from this IP. Please try again later.",
        request_id: (req as any).id,
      },
    });
    return;
  }

  // 2. Phone rate limit check
  if (phone) {
    const phoneKey = `ratelimit:otp:verify:phone:${hashIdentifier(phone)}`;
    const phoneResult = await incrementRateLimit(phoneKey, authConfig.otpMaxVerifyAttemptsPerPhone, windowSeconds, "fail_closed");
    if (!phoneResult.allowed) {
      if (phoneResult.status === "unavailable") {
        res.setHeader("Retry-After", String(phoneResult.resetAfterSeconds));
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

      res.setHeader("Retry-After", String(phoneResult.resetAfterSeconds));
      res.status(429).json({
        success: false,
        code: "OTP_RATE_LIMITED",
        message: "Too many verification attempts for this phone number. Please try again later.",
        error: {
          code: "OTP_RATE_LIMITED",
          message: "Too many verification attempts for this phone number. Please try again later.",
          request_id: (req as any).id,
        },
      });
      return;
    }
  }

  // 3. Device rate limit check
  if (deviceId) {
    const deviceKey = `ratelimit:otp:verify:device:${hashIdentifier(deviceId)}`;
    const deviceResult = await incrementRateLimit(deviceKey, authConfig.otpMaxVerifyAttemptsPerDevice, windowSeconds, "fail_closed");
    if (!deviceResult.allowed) {
      if (deviceResult.status === "unavailable") {
        res.setHeader("Retry-After", String(deviceResult.resetAfterSeconds));
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

      res.setHeader("Retry-After", String(deviceResult.resetAfterSeconds));
      res.status(429).json({
        success: false,
        code: "OTP_RATE_LIMITED",
        message: "Too many verification attempts from this device. Please try again later.",
        error: {
          code: "OTP_RATE_LIMITED",
          message: "Too many verification attempts from this device. Please try again later.",
          request_id: (req as any).id,
        },
      });
      return;
    }
  }

  next();
}

export function resetMemoryRateLimiter(): void {
  resetAllMemoryRateLimiters();
  enableTestMemoryFallback(true);
}


