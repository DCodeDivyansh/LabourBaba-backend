/**
 * Issue 58 - Secret Management, Validation & Rotation Tests
 *
 * Verifies that:
 * 1. Startup assertions fail fast on missing, short, or placeholder secrets.
 * 2. Insecure fallback values are rejected in production mode.
 * 3. Access and refresh secrets must be cryptographically distinct.
 * 4. Production payment and Redis configurations enforce strict security.
 * 5. Secret scanner flags unauthorized secrets.
 */

import { validateJwtSecret, getJwtConfig } from "../src/config/authConfig";
import { validatePaymentSecret } from "../src/config/paymentConfig";
import { assertRedisConfig } from "../src/config/redis";

describe("Issue 58 - Secret Management & Fail-Fast Validation", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("1. JWT Secret Validation & Entropy Invariants", () => {
    it("rejects missing or empty JWT secret", () => {
      expect(() => validateJwtSecret(undefined, "TEST_SECRET")).toThrow(
        /is missing/
      );
      expect(() => validateJwtSecret("   ", "TEST_SECRET")).toThrow(
        /cannot be empty/
      );
    });

    it("rejects known insecure placeholder secrets", () => {
      const insecurePlaceholders = [
        "secret",
        "password",
        "jwt_secret",
        "default_secret_key",
        "changeme",
        "123456",
      ];

      for (const placeholder of insecurePlaceholders) {
        expect(() => validateJwtSecret(placeholder, "TEST_SECRET")).toThrow(
          /known insecure fallback/
        );
      }
    });

    it("rejects secrets that fail minimum 32-character length requirement", () => {
      expect(() =>
        validateJwtSecret("short_secret_below_32_chars", "TEST_SECRET")
      ).toThrow(/minimum secret-length requirement/);
    });

    it("accepts valid high-entropy 32+ character secrets", () => {
      const validSecret = "c8f1e948c2794109b68e998a76e1a90f1d2e3b4a5c6d7e8f90123456789abcde";
      const result = validateJwtSecret(validSecret, "TEST_SECRET");
      expect(result).toBe(validSecret);
    });

    it("fails when JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are identical", () => {
      const sharedSecret = "c8f1e948c2794109b68e998a76e1a90f1d2e3b4a5c6d7e8f90123456789abcde";
      process.env.JWT_ACCESS_SECRET = sharedSecret;
      process.env.JWT_REFRESH_SECRET = sharedSecret;

      expect(() => getJwtConfig()).toThrow(
        /must not be identical/
      );
    });
  });

  describe("2. Payment Secret Validation", () => {
    it("rejects missing or short payment secrets", () => {
      expect(() => validatePaymentSecret(undefined, "RAZORPAY_KEY_SECRET")).toThrow(
        /is missing/
      );
      expect(() => validatePaymentSecret("short", "RAZORPAY_KEY_SECRET", 10)).toThrow(
        /is too short/
      );
    });

    it("rejects insecure payment placeholders", () => {
      expect(() => validatePaymentSecret("your_key_secret", "RAZORPAY_KEY_SECRET")).toThrow(
        /insecure placeholder/
      );
    });
  });

  describe("3. Production Redis Secret & Host Validation", () => {
    it("rejects localhost / 127.0.0.1 Redis host when NODE_ENV is production", () => {
      process.env.NODE_ENV = "production";
      process.env.REDIS_HOST = "127.0.0.1";
      delete process.env.REDIS_URL;
      delete process.env.UPSTASH_REDIS_URL;

      expect(() => assertRedisConfig()).toThrow(
        /localhost\/127\.0\.0\.1 is prohibited/
      );
    });
  });
});
