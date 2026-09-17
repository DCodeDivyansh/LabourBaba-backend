import dotenv from "dotenv";

dotenv.config();

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
};

/**
 * Validates that production SMS provider credentials are configured.
 * In production mode, mock SMS providers are strictly forbidden to prevent silent bypasses.
 */
export function assertProductionAuthConfig(): void {
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
