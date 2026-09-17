import crypto from "crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { JwtPayload } from "../type/userRole";

const JWT_SECRET = process.env.JWT_SECRET || "default_secret_key";
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
 * Generate a JWT for a user payload.
 * @param payload Object containing user identifiers (e.g. { id, role })
 * @param expiresIn Expiration duration (defaults to '24h')
 */
export function generateToken(payload: JwtPayload | Record<string, any>, expiresIn: any = "24h"): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

/**
 * Verify a JWT and decode its payload.
 * @param token The JWT string
 */
export function verifyToken(token: string): any {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (error) {
    return null;
  }
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

