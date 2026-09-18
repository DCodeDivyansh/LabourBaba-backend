import dotenv from "dotenv";

dotenv.config();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PaymentConfig {
  razorpay: {
    keyId: string;
    keySecret: string;
    webhookSecret: string;
  };
  currency: string;
  isTestMode: boolean;
}

// ── Insecure fallback detection ────────────────────────────────────────────────

const KNOWN_INSECURE_PAYMENT_VALUES = [
  "test",
  "secret",
  "password",
  "razorpay",
  "key_id",
  "key_secret",
  "webhook_secret",
  "changeme",
  "your_key_id",
  "your_key_secret",
  "your_webhook_secret",
];

/**
 * Validates a required payment configuration variable.
 * Throws a clear startup error if the value is missing, empty, or an insecure fallback.
 * Never logs the actual secret value.
 */
export function validatePaymentSecret(
  value: string | undefined,
  varName: string,
  minLength = 10,
): string {
  if (value === undefined || value === null || typeof value !== "string") {
    throw new Error(
      `[SECURITY ERROR] Required payment environment variable '${varName}' is missing.`,
    );
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error(
      `[SECURITY ERROR] Payment environment variable '${varName}' cannot be empty.`,
    );
  }

  if (KNOWN_INSECURE_PAYMENT_VALUES.includes(trimmed.toLowerCase())) {
    throw new Error(
      `[SECURITY ERROR] Payment environment variable '${varName}' contains a known insecure placeholder value.`,
    );
  }

  if (trimmed.length < minLength) {
    throw new Error(
      `[SECURITY ERROR] Payment environment variable '${varName}' is too short (minimum ${minLength} characters).`,
    );
  }

  return trimmed;
}

// ── Configuration builder ──────────────────────────────────────────────────────

const nodeEnv = process.env.NODE_ENV || "development";

/**
 * Reads and returns the validated Razorpay payment configuration.
 * In test/development mode, values may be supplied as test credentials.
 * In production, all values are required and validated.
 */
export function getPaymentConfig(): PaymentConfig {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (nodeEnv === "production") {
    validatePaymentSecret(keyId, "RAZORPAY_KEY_ID");
    validatePaymentSecret(keySecret, "RAZORPAY_KEY_SECRET");
    validatePaymentSecret(webhookSecret, "RAZORPAY_WEBHOOK_SECRET");
  }

  return {
    razorpay: {
      keyId: keyId?.trim() ?? "",
      keySecret: keySecret?.trim() ?? "",
      webhookSecret: webhookSecret?.trim() ?? "",
    },
    currency: "INR",
    isTestMode: nodeEnv !== "production",
  };
}

/**
 * Fail-fast startup validation for payment configuration.
 * Called from server.ts alongside assertJwtConfig().
 * In production, immediately exits the process if required credentials are absent.
 */
export function assertProductionPaymentConfig(): void {
  if (nodeEnv !== "production") {
    // Warn in development/test if credentials are absent — do not block
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      console.warn(
        "[PAYMENT CONFIG] RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set. " +
          "Real payment orders cannot be created. Set these before going to production.",
      );
    }
    return;
  }

  // In production: enforce hard fail
  validatePaymentSecret(
    process.env.RAZORPAY_KEY_ID,
    "RAZORPAY_KEY_ID",
  );
  validatePaymentSecret(
    process.env.RAZORPAY_KEY_SECRET,
    "RAZORPAY_KEY_SECRET",
  );
  validatePaymentSecret(
    process.env.RAZORPAY_WEBHOOK_SECRET,
    "RAZORPAY_WEBHOOK_SECRET",
  );
}

export const paymentConfig = getPaymentConfig();
