import request from "supertest";
import jwt from "jsonwebtoken";
import {
  getJwtConfig,
  assertJwtConfig,
  validateJwtSecret,
  KNOWN_INSECURE_SECRETS,
  MIN_JWT_SECRET_LENGTH,
} from "../src/config/authConfig";
import {
  signAccessToken,
  verifyAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  generateToken,
  verifyToken,
} from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";
import { app } from "../src/server";
import prisma from "../src/config/prisma";

// Mock external dependencies that should not execute real network calls during tests
jest.mock("../src/config/bullmq", () => ({
  dispatchQueue: { add: jest.fn().mockResolvedValue({}) },
  timeoutQueue: { add: jest.fn().mockResolvedValue({}) },
}));

jest.mock("../src/config/prisma", () => {
  const originalPrisma = {
    customer: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    worker: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    otp_challenge: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    refresh_session: {
      create: jest.fn().mockImplementation(async (args: any) => {
        console.log("MOCK CREATE CALLED WITH:", args);
        return {
          id: "a1b2c3d4-e5f6-4890-a234-56789abcdef0",
          expires_at: args?.data?.expires_at || new Date(Date.now() + 30 * 86400000),
          user_id: args?.data?.user_id,
          user_role: args?.data?.user_role,
        };
      }),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $transaction: jest.fn().mockImplementation((callback) => callback(originalPrisma)),
  };
  return {
    __esModule: true,
    default: originalPrisma,
  };
});

describe("P0 Security Regression Tests — Issue #4: JWT Secrets Have Insecure Fallbacks", () => {
  const VALID_ACCESS_SECRET = "valid_access_secret_0123456789abcdef0123456789abcdef";
  const VALID_REFRESH_SECRET = "valid_refresh_secret_fedcba9876543210fedcba9876543210";

  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.JWT_ACCESS_SECRET = VALID_ACCESS_SECRET;
    process.env.JWT_REFRESH_SECRET = VALID_REFRESH_SECRET;
    delete process.env.JWT_SECRET;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ==========================================================================
  // Test 1: Missing Access Secret Fails Configuration
  // ==========================================================================
  describe("Test 1 — Missing access secret fails configuration", () => {
    it("MUST throw a security error if JWT_ACCESS_SECRET and JWT_SECRET are absent", () => {
      delete process.env.JWT_ACCESS_SECRET;
      delete process.env.JWT_SECRET;

      expect(() => assertJwtConfig()).toThrow(
        "[SECURITY ERROR] Required environment variable 'JWT_ACCESS_SECRET' is missing."
      );
    });

    it("MUST accept legacy JWT_SECRET during transition only if it meets security criteria", () => {
      delete process.env.JWT_ACCESS_SECRET;
      process.env.JWT_SECRET = VALID_ACCESS_SECRET;

      const config = assertJwtConfig();
      expect(config.accessSecret).toBe(VALID_ACCESS_SECRET);
    });
  });

  // ==========================================================================
  // Test 2: Missing Refresh Secret Fails Configuration
  // ==========================================================================
  describe("Test 2 — Missing refresh secret fails configuration", () => {
    it("MUST throw a security error if JWT_REFRESH_SECRET is absent", () => {
      delete process.env.JWT_REFRESH_SECRET;

      expect(() => assertJwtConfig()).toThrow(
        "[SECURITY ERROR] Required environment variable 'JWT_REFRESH_SECRET' is missing."
      );
    });
  });

  // ==========================================================================
  // Test 3: Empty Access Secret Fails
  // ==========================================================================
  describe("Test 3 — Empty access secret fails", () => {
    it("MUST reject empty string for JWT_ACCESS_SECRET", () => {
      process.env.JWT_ACCESS_SECRET = "";

      expect(() => assertJwtConfig()).toThrow(
        "[SECURITY ERROR] Environment variable 'JWT_ACCESS_SECRET' cannot be empty or whitespace-only."
      );
    });

    it("MUST reject whitespace-only string for JWT_ACCESS_SECRET", () => {
      process.env.JWT_ACCESS_SECRET = "   \t\n   ";

      expect(() => assertJwtConfig()).toThrow(
        "[SECURITY ERROR] Environment variable 'JWT_ACCESS_SECRET' cannot be empty or whitespace-only."
      );
    });
  });

  // ==========================================================================
  // Test 4: Empty Refresh Secret Fails
  // ==========================================================================
  describe("Test 4 — Empty refresh secret fails", () => {
    it("MUST reject empty string for JWT_REFRESH_SECRET", () => {
      process.env.JWT_REFRESH_SECRET = "";

      expect(() => assertJwtConfig()).toThrow(
        "[SECURITY ERROR] Environment variable 'JWT_REFRESH_SECRET' cannot be empty or whitespace-only."
      );
    });

    it("MUST reject whitespace-only string for JWT_REFRESH_SECRET", () => {
      process.env.JWT_REFRESH_SECRET = "      ";

      expect(() => assertJwtConfig()).toThrow(
        "[SECURITY ERROR] Environment variable 'JWT_REFRESH_SECRET' cannot be empty or whitespace-only."
      );
    });
  });

  // ==========================================================================
  // Test 5: Known Insecure Fallback Values Rejected
  // ==========================================================================
  describe("Test 5 — Known insecure fallback values rejected", () => {
    const historicalFallbacks = [
      "default_secret_key",
      "fallback_secret_key",
      "fallback_refresh_key",
      "secret",
      "password",
      "jwt_secret",
      "development-secret",
      "test-secret",
      "123456",
    ];

    historicalFallbacks.forEach((fallback) => {
      it(`MUST reject known insecure fallback secret: "${fallback}" for access token`, () => {
        process.env.JWT_ACCESS_SECRET = fallback;

        expect(() => assertJwtConfig()).toThrow(
          "[SECURITY ERROR] Environment variable 'JWT_ACCESS_SECRET' contains a known insecure fallback value."
        );
      });

      it(`MUST reject known insecure fallback secret: "${fallback}" for refresh token`, () => {
        process.env.JWT_REFRESH_SECRET = fallback;

        expect(() => assertJwtConfig()).toThrow(
          "[SECURITY ERROR] Environment variable 'JWT_REFRESH_SECRET' contains a known insecure fallback value."
        );
      });
    });
  });

  // ==========================================================================
  // Test 6: Minimum Secret Length Check
  // ==========================================================================
  describe("Test 6 — Minimum secret length requirement", () => {
    it("MUST reject secrets shorter than MIN_JWT_SECRET_LENGTH (32 chars)", () => {
      process.env.JWT_ACCESS_SECRET = "short_secret_below_32_chars";

      expect(() => assertJwtConfig()).toThrow(
        `[SECURITY ERROR] Environment variable 'JWT_ACCESS_SECRET' fails minimum secret-length requirement (${MIN_JWT_SECRET_LENGTH} characters required).`
      );
    });

    it("MUST reject refresh secrets shorter than MIN_JWT_SECRET_LENGTH (32 chars)", () => {
      process.env.JWT_REFRESH_SECRET = "short_refresh_key_under_32";

      expect(() => assertJwtConfig()).toThrow(
        `[SECURITY ERROR] Environment variable 'JWT_REFRESH_SECRET' fails minimum secret-length requirement (${MIN_JWT_SECRET_LENGTH} characters required).`
      );
    });
  });

  // ==========================================================================
  // Test 7: Access Token Signing and Verification
  // ==========================================================================
  describe("Test 7 — Access token signing and verification", () => {
    it("MUST sign and verify access token with JWT_ACCESS_SECRET", () => {
      const payload = { id: "user-123", role: UserRole.CUSTOMER };
      const token = signAccessToken(payload);

      expect(typeof token).toBe("string");

      const verified = verifyAccessToken(token);
      expect(verified).not.toBeNull();
      expect(verified.id).toBe("user-123");
      expect(verified.role).toBe(UserRole.CUSTOMER);
      expect(verified.token_type).toBe("access");
    });

    it("MUST maintain backward compatibility via generateToken and verifyToken wrappers", () => {
      const payload = { id: "user-compat-456", role: UserRole.WORKER };
      const token = generateToken(payload);
      const verified = verifyToken(token);

      expect(verified).not.toBeNull();
      expect(verified.id).toBe("user-compat-456");
      expect(verified.role).toBe(UserRole.WORKER);
    });
  });

  // ==========================================================================
  // Test 8: Refresh Token Signing and Verification
  // ==========================================================================
  describe("Test 8 — Refresh token signing and verification", () => {
    it("MUST sign and verify refresh token with JWT_REFRESH_SECRET", () => {
      const payload = { id: "user-789", role: UserRole.ADMIN };
      const refreshToken = signRefreshToken(payload);

      expect(typeof refreshToken).toBe("string");

      const verified = verifyRefreshToken(refreshToken);
      expect(verified).not.toBeNull();
      expect(verified.id).toBe("user-789");
      expect(verified.role).toBe(UserRole.ADMIN);
      expect(verified.token_type).toBe("refresh");
    });
  });

  // ==========================================================================
  // Test 9: Cross-Secret Rejection (Cryptographic Independence)
  // ==========================================================================
  describe("Test 9 — Cross-secret rejection", () => {
    it("MUST fail when verifying an access token with the refresh secret", () => {
      const payload = { id: "user-cross-1", role: UserRole.CUSTOMER };
      const accessToken = signAccessToken(payload);

      // Attempt manual verification using the refresh secret
      expect(() => {
        jwt.verify(accessToken, VALID_REFRESH_SECRET, { algorithms: ["HS256"] });
      }).toThrow();
    });

    it("MUST fail when verifying a refresh token with the access secret", () => {
      const payload = { id: "user-cross-2", role: UserRole.WORKER };
      const refreshToken = signRefreshToken(payload);

      // Attempt manual verification using the access secret
      expect(() => {
        jwt.verify(refreshToken, VALID_ACCESS_SECRET, { algorithms: ["HS256"] });
      }).toThrow();
    });
  });

  // ==========================================================================
  // Test 10: Token Purpose Separation (token_type claim)
  // ==========================================================================
  describe("Test 10 — Token-purpose rejection", () => {
    it("MUST reject an access token presented to verifyRefreshToken", () => {
      const accessToken = signAccessToken({ id: "user-type-1", role: UserRole.CUSTOMER });
      const result = verifyRefreshToken(accessToken);
      expect(result).toBeNull();
    });

    it("MUST reject a refresh token presented to verifyAccessToken", () => {
      const refreshToken = signRefreshToken({ id: "user-type-2", role: UserRole.WORKER });
      const result = verifyAccessToken(refreshToken);
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // Test 11: Identical Secret Rejection
  // ==========================================================================
  describe("Test 11 — Identical secret rejection", () => {
    it("MUST throw a security error if JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are identical", () => {
      const sharedSecret = "this_secret_is_shared_and_must_be_strictly_rejected_32";
      process.env.JWT_ACCESS_SECRET = sharedSecret;
      process.env.JWT_REFRESH_SECRET = sharedSecret;

      expect(() => assertJwtConfig()).toThrow(
        "[SECURITY ERROR] JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must not be identical. Access and refresh tokens require distinct cryptographic secrets."
      );
    });
  });

  // ==========================================================================
  // Test 12: Zero Secret Leakage in Errors
  // ==========================================================================
  describe("Test 12 — No secret leakage", () => {
    it("MUST NOT leak the supplied secret string in any error message", () => {
      const sensitiveWeakSecret = "super_confidential_short_val";
      process.env.JWT_ACCESS_SECRET = sensitiveWeakSecret;

      try {
        assertJwtConfig();
        fail("Should have thrown error");
      } catch (err: any) {
        expect(err.message).not.toContain(sensitiveWeakSecret);
      }
    });

    it("MUST NOT leak known insecure secret values in errors", () => {
      const customValue = "default_secret_key";
      process.env.JWT_ACCESS_SECRET = customValue;

      try {
        assertJwtConfig();
        fail("Should have thrown error");
      } catch (err: any) {
        expect(err.message).not.toContain("default_secret_key_");
      }
    });
  });

  // ==========================================================================
  // Test 13: Startup Assertion Refuses Insecure Configuration
  // ==========================================================================
  describe("Test 13 — Startup assertion refuses insecure configuration", () => {
    it("MUST halt startup cleanly by throwing [SECURITY ERROR] on any configuration violation", () => {
      delete process.env.JWT_ACCESS_SECRET;

      expect(() => assertJwtConfig()).toThrow(/\[SECURITY ERROR\]/);
    });
  });

  // ==========================================================================
  // Test 14: HTTP Integration — Protected Routes & Refresh Endpoint
  // ==========================================================================
  describe("Test 14 — HTTP integration", () => {
    it("MUST accept valid access token on access-protected route", async () => {
      const validAccessToken = signAccessToken({
        id: "cust-valid-001",
        phone: "+919876543210",
        role: UserRole.CUSTOMER,
      });

      const res = await request(app)
        .get("/api/clients/me")
        .set("Authorization", `Bearer ${validAccessToken}`);

      // Even if mock customer DB lookup returns 404/200, JWT middleware accepted the token (not 401)
      expect(res.status).not.toBe(401);
    });

    it("MUST reject a refresh token on an access-protected route", async () => {
      const refreshToken = signRefreshToken({
        id: "cust-invalid-002",
        phone: "+919876543210",
        role: UserRole.CUSTOMER,
      });

      const res = await request(app)
        .get("/api/clients/me")
        .set("Authorization", `Bearer ${refreshToken}`);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("MUST reject an access token on POST /api/auth/refresh", async () => {
      const accessToken = signAccessToken({
        id: "user-refresh-test",
        role: UserRole.CUSTOMER,
      });

      const res = await request(app)
        .post("/api/auth/refresh")
        .send({ token: accessToken });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Invalid refresh token");
    });

    it("MUST accept a valid refresh token on POST /api/auth/refresh and return a new access token", async () => {
      ((prisma as any).refresh_session.create as jest.Mock).mockResolvedValue({
        id: "a1b2c3d4-e5f6-4890-a234-56789abcdef0",
        expires_at: new Date(Date.now() + 30 * 86400000),
      });

      const refreshToken = signRefreshToken({
        id: "user-refresh-success",
        role: UserRole.CUSTOMER,
      });

      const res = await request(app)
        .post("/api/auth/refresh")
        .send({ token: refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toBeDefined();

      // Verify the newly issued token is a valid access token
      const verifiedNewToken = verifyAccessToken(res.body.data.token);
      expect(verifiedNewToken).not.toBeNull();
      expect(verifiedNewToken.id).toBe("user-refresh-success");
      expect(verifiedNewToken.role).toBe(UserRole.CUSTOMER);
      expect(verifiedNewToken.token_type).toBe("access");
    });
  });
});
