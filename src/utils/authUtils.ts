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
 * Generate a random 6-digit OTP string.
 */
export function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Hash an OTP string using bcrypt.
 * @param otp The plain text OTP
 */
export async function hashOTP(otp: string): Promise<string> {
  return bcrypt.hash(otp, SALT_ROUNDS);
}
