import dotenv from "dotenv";

dotenv.config();

export interface JwtConfig {
  accessSecret: string;
  refreshSecret: string;
  accessTokenExpiresIn: string;
  refreshTokenExpiresIn: string;
  algorithm: "HS256";
}

export interface AuthConfig {
  otpTtlSeconds: number;
  otpMaxAttempts: number;
  otpResendCooldownSeconds: number;
  otpCleanupRetentionDays: number;
  smsProvider: "mock" | "twilio" | "http";
  nodeEnv: string;
  twilio: {
    accountSid?: string;
    authToken?: string;
    phoneNumber?: string;
  };
  genericHttp: {
    apiUrl?: string;
    apiKey?: string;
  };
  get jwt(): JwtConfig;
}

export const KNOWN_INSECURE_SECRETS = [
  "default_secret_key",
  "fallback_secret_key",
  "fallback_refresh_key",
  "secret",
  "password",
  "jwt_secret",
  "jwt_access_secret",
  "jwt_refresh_secret",
  "development-secret",
  "test-secret",
  "123456",
  "changeme",
];

export const MIN_JWT_SECRET_LENGTH = 32;

/**
 * Validates a single JWT secret:
 * - Must be provided, non-empty, and non-whitespace.
 * - Must not match known insecure fallback defaults.
 * - Must satisfy the minimum secret-length requirement of 32 characters.
 *   (Note: Minimum length is a necessary condition for HMAC keys; secrets should
 *   be generated with cryptographic randomness such as `openssl rand -hex 32`).
 *
 * Throws a descriptive security error on failure without exposing secret contents.
 */
export function validateJwtSecret(secret: string | undefined, varName: string): string {
  if (secret === undefined || secret === null || typeof secret !== "string") {
    throw new Error(`[SECURITY ERROR] Required environment variable '${varName}' is missing.`);
  }

  const trimmed = secret.trim();

  if (trimmed.length === 0) {
    throw new Error(`[SECURITY ERROR] Environment variable '${varName}' cannot be empty or whitespace-only.`);
  }

  if (KNOWN_INSECURE_SECRETS.includes(trimmed.toLowerCase())) {
    throw new Error(`[SECURITY ERROR] Environment variable '${varName}' contains a known insecure fallback value.`);
  }

  if (trimmed.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(
      `[SECURITY ERROR] Environment variable '${varName}' fails minimum secret-length requirement (${MIN_JWT_SECRET_LENGTH} characters required).`
    );
  }

  return trimmed;
}

/**
 * Validates and retrieves the JWT configuration.
 * Enforces:
 * 1. JWT_ACCESS_SECRET is provided, valid, and meets quality criteria
 *    (supports legacy JWT_SECRET during transition if present and valid).
 * 2. JWT_REFRESH_SECRET is provided, valid, and meets quality criteria.
 * 3. Access and refresh secrets are cryptographically distinct.
 * 4. Algorithm is locked to HS256.
 */
export function getJwtConfig(): JwtConfig {
  let rawAccess = process.env.JWT_ACCESS_SECRET;
  let accessVarName = "JWT_ACCESS_SECRET";

  if (!rawAccess && process.env.JWT_SECRET) {
    rawAccess = process.env.JWT_SECRET;
    accessVarName = "JWT_SECRET (transitional)";
  }

  const accessSecret = validateJwtSecret(rawAccess, accessVarName);
  const refreshSecret = validateJwtSecret(process.env.JWT_REFRESH_SECRET, "JWT_REFRESH_SECRET");

  if (accessSecret === refreshSecret) {
    throw new Error(
      "[SECURITY ERROR] JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must not be identical. Access and refresh tokens require distinct cryptographic secrets."
    );
  }

  return {
    accessSecret,
    refreshSecret,
    accessTokenExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "1h",
    refreshTokenExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
    algorithm: "HS256",
  };
}

/**
 * Fail-fast validation invoked during application startup.
 * Halts bootstrap immediately if JWT configuration is missing or insecure.
 */
export function assertJwtConfig(): JwtConfig {
  return getJwtConfig();
}

const nodeEnv = process.env.NODE_ENV || "development";

export const authConfig: AuthConfig = {
  otpTtlSeconds: parseInt(process.env.OTP_TTL_SECONDS || "300", 10),
  otpMaxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS || "5", 10),
  otpResendCooldownSeconds: parseInt(process.env.OTP_RESEND_COOLDOWN_SECONDS || "60", 10),
  otpCleanupRetentionDays: parseInt(process.env.OTP_CLEANUP_RETENTION_DAYS || "7", 10),
  smsProvider: (process.env.SMS_PROVIDER as "mock" | "twilio" | "http") || (nodeEnv === "production" ? "twilio" : "mock"),
  nodeEnv,
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER,
  },
  genericHttp: {
    apiUrl: process.env.GENERIC_SMS_API_URL,
    apiKey: process.env.GENERIC_SMS_API_KEY,
  },
  get jwt(): JwtConfig {
    return getJwtConfig();
  },
};

/**
 * Validates that production SMS provider credentials are configured.
 * In production mode, mock SMS providers are strictly forbidden to prevent silent bypasses.
 */
export function assertProductionAuthConfig(): void {
  assertJwtConfig();

  if (authConfig.nodeEnv === "production") {
    if (authConfig.smsProvider === "mock") {
      throw new Error(
        "[SECURITY ERROR] In production, SMS_PROVIDER cannot be 'mock'. A real SMS provider must be configured."
      );
    }

    if (authConfig.smsProvider === "twilio") {
      if (!authConfig.twilio.accountSid || !authConfig.twilio.authToken || !authConfig.twilio.phoneNumber) {
        throw new Error(
          "[SECURITY ERROR] Missing required Twilio configuration (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER) in production."
        );
      }
    }

    if (authConfig.smsProvider === "http") {
      if (!authConfig.genericHttp.apiUrl || !authConfig.genericHttp.apiKey) {
        throw new Error(
          "[SECURITY ERROR] Missing required Generic HTTP SMS configuration (GENERIC_SMS_API_URL, GENERIC_SMS_API_KEY) in production."
        );
      }
    }
  }
}
