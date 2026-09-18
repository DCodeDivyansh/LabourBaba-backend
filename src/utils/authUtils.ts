import crypto from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { JwtPayload } from "../type/userRole";

import { getJwtConfig } from "../config/authConfig";

const SALT_ROUNDS = 10;

/**
 * Hash a plain text password using bcrypt.
 * @param password The plain text password
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * Compare a plain text password with a hash.
 * @param password The plain text password
 * @param hash The stored hash
 */
export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * Signs an access token using JWT_ACCESS_SECRET with algorithm HS256.
 * Embeds token_type = "access" claim for purpose isolation.
 *
 * @param payload Object containing user identifiers (e.g. { id, role, phone })
 * @param expiresIn Expiration duration (defaults to configuration or '1h')
 */
export function signAccessToken(
  payload: JwtPayload | Record<string, any>,
  expiresIn?: string
): string {
  const config = getJwtConfig();
  const tokenPayload = {
    ...payload,
    token_type: "access" as const,
  };
  return jwt.sign(tokenPayload, config.accessSecret, {
    algorithm: config.algorithm,
    expiresIn: (expiresIn || config.accessTokenExpiresIn) as any,
  });
}

/**
 * Verifies an access token using JWT_ACCESS_SECRET with algorithm HS256.
 * Enforces token_type claim isolation to reject tokens with token_type !== "access".
 *
 * @param token The JWT string
 */
export function verifyAccessToken(token: string): any {
  try {
    const config = getJwtConfig();
    const decoded = jwt.verify(token, config.accessSecret, {
      algorithms: [config.algorithm],
    }) as any;

    if (!decoded || typeof decoded !== "object") {
      return null;
    }

    // Purpose isolation: reject if token is explicitly a refresh token or not an access token
    if (decoded.token_type && decoded.token_type !== "access") {
      return null;
    }

    return decoded;
  } catch (error) {
    return null;
  }
}

/**
 * Signs a refresh token using JWT_REFRESH_SECRET with algorithm HS256.
 * Embeds token_type = "refresh" claim for purpose isolation.
 *
 * @param payload Object containing user identifiers (e.g. { id, role, phone })
 * @param expiresIn Expiration duration (defaults to configuration or '7d')
 */
export function signRefreshToken(
  payload: JwtPayload | Record<string, any>,
  expiresIn?: string
): string {
  const config = getJwtConfig();
  const tokenPayload = {
    ...payload,
    token_type: "refresh" as const,
  };
  return jwt.sign(tokenPayload, config.refreshSecret, {
    algorithm: config.algorithm,
    expiresIn: (expiresIn || config.refreshTokenExpiresIn) as any,
  });
}

/**
 * Verifies a refresh token using JWT_REFRESH_SECRET with algorithm HS256.
 * Enforces token_type claim isolation to reject tokens without token_type === "refresh".
 *
 * @param token The refresh token string
 */
export function verifyRefreshToken(token: string): any {
  try {
    const config = getJwtConfig();
    const decoded = jwt.verify(token, config.refreshSecret, {
      algorithms: [config.algorithm],
    }) as any;

    if (!decoded || typeof decoded !== "object") {
      return null;
    }

    // Purpose isolation: refresh tokens must have token_type === "refresh"
    if (decoded.token_type !== "refresh") {
      return null;
    }

    return decoded;
  } catch (error) {
    return null;
  }
}

/**
 * Backward-compatibility wrapper for access token generation.
 * Delegates to signAccessToken.
 *
 * @param payload Object containing user identifiers (e.g. { id, role })
 * @param expiresIn Expiration duration (defaults to '1h')
 */
export function generateToken(
  payload: JwtPayload | Record<string, any>,
  expiresIn?: any
): string {
  return signAccessToken(payload, expiresIn);
}

/**
 * Backward-compatibility wrapper for access token verification.
 * Delegates to verifyAccessToken.
 *
 * @param token The JWT string
 */
export function verifyToken(token: string): any {
  return verifyAccessToken(token);
}



/**
 * Generate a cryptographically secure random 6-digit OTP string.
 * Uses crypto.randomInt to guarantee uniform, non-predictable distribution.
 */
export function generateOTP(): string {
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Hash an OTP string using bcrypt.
 * @param otp The plain text OTP
 */
export async function hashOTP(otp: string): Promise<string> {
  return bcrypt.hash(otp, SALT_ROUNDS);
}

/**
 * Normalizes phone numbers to a canonical representation by stripping
 * whitespace, hyphens, parentheses, and dots.
 * Note: Broader international E.164 normalization is tracked in Issue #66.
 */
export function normalizePhone(phone: string): string {
  if (!phone) return "";
  return phone.trim().replace(/[\s\-\(\)\.]/g, "");
}

/**
 * Safely masks a phone number for logging and non-sensitive API responses.
 * Example: "+919876543210" -> "+91*****3210"
 */
export function maskPhone(phone: string): string {
  if (!phone || phone.length < 5) return "****";
  const startLen = phone.startsWith("+") ? 3 : 2;
  const endLen = 4;
  if (phone.length <= startLen + endLen) return phone.slice(0, 2) + "****";
  const start = phone.slice(0, startLen);
  const end = phone.slice(-endLen);
  const mask = "*".repeat(Math.max(4, phone.length - startLen - endLen));
  return `${start}${mask}${end}`;
}

