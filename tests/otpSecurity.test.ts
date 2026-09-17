import request from "supertest";
import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { defaultMockSmsProvider } from "../src/providers/sms/mockSmsProvider";
import { setSmsProvider } from "../src/providers/sms/smsProviderFactory";
import { hashOTP, comparePassword, generateOTP } from "../src/utils/authUtils";
import { authConfig } from "../src/config/authConfig";

// In-memory backing store to simulate PostgreSQL otp_challenge table
interface StoredChallenge {
  id: string;
  phone: string;
  purpose: string;
  otp_hash: string;
  expires_at: Date;
  attempt_count: number;
  status: string;
  consumed_at: Date | null;
  created_at: Date;
}

let challengeStore: StoredChallenge[] = [];

// Concurrency mutex lock to simulate PostgreSQL row locking
let rowLocks = new Set<string>();

import { resetMemoryRateLimiter } from "../src/middlewares/otpRateLimiter";

jest.mock("../src/config/prisma", () => {
  return {
    __esModule: true,
    default: {
      customer: {
        findUnique: jest.fn(),
      },
      worker: {
        findUnique: jest.fn(),
      },
      otp_challenge: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
      },
      $transaction: jest.fn(),
    },
  };
});

describe("P0 Security Regression Tests — Issue #3: Hard-Coded OTP Verification", () => {
  const TEST_PHONE = "+919876543210";
  const TEST_CUSTOMER = {
    id: "c1b2c3d4-e5f6-4890-a234-56789abcdef0",
    name: "Legit Customer",
    phone: TEST_PHONE,
  };

  function setupPrismaMock() {
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
      if (typeof cb === "function") {
        return await cb(prisma);
      }
      return cb;
    });

    (prisma.otp_challenge.findFirst as jest.Mock).mockImplementation(async ({ where, orderBy }: any) => {
      let matches = challengeStore.filter((c) => {
        if (where.phone && c.phone !== where.phone) return false;
        if (where.purpose && c.purpose !== where.purpose) return false;
        if (where.status && c.status !== where.status) return false;
        if (where.consumed_at === null && c.consumed_at !== null) return false;
        if (where.expires_at?.gt && c.expires_at <= where.expires_at.gt) return false;
        return true;
      });

      if (orderBy?.created_at === "desc") {
        matches.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      }

      return matches[0] ? matches[0] : null;
    });

    (prisma.otp_challenge.create as jest.Mock).mockImplementation(async ({ data }: any) => {
      const record: StoredChallenge = {
        id: `challenge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        phone: data.phone,
        purpose: data.purpose,
        otp_hash: data.otp_hash,
        expires_at: data.expires_at,
        attempt_count: data.attempt_count || 0,
        status: data.status || "ACTIVE",
        consumed_at: data.consumed_at || null,
        created_at: new Date(),
      };
      challengeStore.push(record);
      return record;
    });

    (prisma.otp_challenge.update as jest.Mock).mockImplementation(async ({ where, data }: any) => {
      const item = challengeStore.find((c) => c.id === where.id);
      if (!item) throw new Error("Record to update not found");
      Object.assign(item, data);
      return item;
    });

    (prisma.otp_challenge.updateMany as jest.Mock).mockImplementation(async ({ where, data }: any) => {
      let count = 0;
      for (const item of challengeStore) {
        let match = true;
        if (where.id && item.id !== where.id) match = false;
        if (where.phone && item.phone !== where.phone) match = false;
        if (where.purpose && item.purpose !== where.purpose) match = false;
        if (where.status && item.status !== where.status) match = false;
        if (where.consumed_at === null && item.consumed_at !== null) match = false;

        if (match) {
          Object.assign(item, data);
          count++;
        }
      }
      return { count };
    });

    (prisma.otp_challenge.deleteMany as jest.Mock).mockImplementation(async ({ where }: any) => {
      const before = challengeStore.length;
      challengeStore = challengeStore.filter((c) => {
        if (where.expires_at?.lt && c.expires_at < where.expires_at.lt) return false;
        return true;
      });
      return { count: before - challengeStore.length };
    });

    (prisma.customer.findUnique as jest.Mock).mockResolvedValue(TEST_CUSTOMER);
    (prisma.worker.findUnique as jest.Mock).mockResolvedValue(null);
  }

  beforeEach(() => {
    challengeStore = [];
    rowLocks.clear();
    jest.clearAllMocks();
    resetMemoryRateLimiter();
    setupPrismaMock();
    defaultMockSmsProvider.clear();
    setSmsProvider(defaultMockSmsProvider);
  });


  // ─────────────────────────────────────────────────────────────────────────────
  // 1. HARD-CODED OTP REMOVAL & ATTACK BYPASS PREVENTION
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Invariant 1: Hard-Coded OTP Authentication Bypass is Eliminated", () => {
    it("MUST reject '123456' when no OTP request was issued (zero prior challenge)", async () => {
      const res = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: TEST_PHONE, otp: "123456" });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("OTP_INVALID");
      expect(res.body.message).toBe("Invalid OTP");
      expect(res.body.data).toBeUndefined();
    });

    it("MUST reject other static patterns ('000000', '111111', '999999')", async () => {
      for (const pattern of ["000000", "111111", "999999"]) {
        const res = await request(app)
          .post("/api/auth/verify-otp")
          .send({ phone: TEST_PHONE, otp: pattern });

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
      }
    });

    it("MUST reject '123456' even after a genuine OTP is requested, if the generated OTP is different", async () => {
      // 1. Request OTP legitimately
      const sendRes = await request(app)
        .post("/api/auth/send-otp")
        .send({ phone: TEST_PHONE, type: "login" });
      expect(sendRes.status).toBe(200);

      const legitimateOtp = defaultMockSmsProvider.getLastOtpFor(TEST_PHONE);
      expect(legitimateOtp).toBeDefined();

      // If by astronomical chance randomInt generated 123456, skip assert
      if (legitimateOtp !== "123456") {
        const res = await request(app)
          .post("/api/auth/verify-otp")
          .send({ phone: TEST_PHONE, otp: "123456" });

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body.data).toBeUndefined();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. CRYPTOGRAPHIC GENERATION & LEGITIMATE VERIFICATION
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Invariant 2: Cryptographically Secure OTP Generation & Verification", () => {
    it("MUST generate a 6-digit uniform numeric code and authenticate successfully", async () => {
      await request(app)
        .post("/api/auth/send-otp")
        .send({ phone: TEST_PHONE, type: "login" });

      const legitimateOtp = defaultMockSmsProvider.getLastOtpFor(TEST_PHONE);
      expect(legitimateOtp).toMatch(/^\d{6}$/);

      // Verify that plain OTP is NOT stored in the database
      expect(challengeStore[0].otp_hash).not.toBe(legitimateOtp);
      expect(challengeStore[0].otp_hash.startsWith("$2")).toBe(true); // bcrypt hash

      const res = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: TEST_PHONE, otp: legitimateOtp });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
      expect(res.body.data.role).toBe("customer");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. SINGLE-USE SEMANTICS & REPLAY DEFENSE
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Invariant 3: Single-Use Semantics (Replay Protection)", () => {
    it("MUST allow first verification and REJECT subsequent replay of the same OTP", async () => {
      await request(app)
        .post("/api/auth/send-otp")
        .send({ phone: TEST_PHONE, type: "login" });

      const otp = defaultMockSmsProvider.getLastOtpFor(TEST_PHONE)!;

      // First verification: Success
      const firstRes = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: TEST_PHONE, otp });
      expect(firstRes.status).toBe(200);
      expect(firstRes.body.success).toBe(true);

      // Replay attempt: Must be rejected
      const replayRes = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: TEST_PHONE, otp });
      expect(replayRes.status).toBe(401);
      expect(replayRes.body.success).toBe(false);
      expect(replayRes.body.code).toBe("OTP_INVALID");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. ATTEMPT LIMITS & BRUTE-FORCE LOCKING
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Invariant 4: Attempt Bounds and Brute-Force Locking", () => {
    it("MUST lock challenge after maximum failed attempts (5) and reject subsequent valid OTP", async () => {
      await request(app)
        .post("/api/auth/send-otp")
        .send({ phone: TEST_PHONE, type: "login" });

      const realOtp = defaultMockSmsProvider.getLastOtpFor(TEST_PHONE)!;

      // 4 wrong attempts
      for (let i = 1; i <= 4; i++) {
        const res = await request(app)
          .post("/api/auth/verify-otp")
          .send({ phone: TEST_PHONE, otp: "888888" });
        expect(res.status).toBe(401);
        expect(challengeStore[0].attempt_count).toBe(i);
        expect(challengeStore[0].status).toBe("ACTIVE");
      }



      // 5th wrong attempt: Exceeds limit -> Locked
      const fifthRes = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: TEST_PHONE, otp: "888888" });
      expect(fifthRes.status).toBe(401);
      expect(fifthRes.body.code).toBe("OTP_MAX_ATTEMPTS");
      expect(challengeStore[0].status).toBe("LOCKED");

      // 6th attempt with the REAL legitimate OTP: Must still be rejected!
      const postLockRes = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: TEST_PHONE, otp: realOtp });
      expect(postLockRes.status).toBe(401);
      expect(postLockRes.body.success).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. EXPIRATION / TTL ENFORCEMENT
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Invariant 5: Expiration / TTL Enforcement", () => {
    it("MUST reject verification if OTP challenge has expired", async () => {
      await request(app)
        .post("/api/auth/send-otp")
        .send({ phone: TEST_PHONE, type: "login" });

      const otp = defaultMockSmsProvider.getLastOtpFor(TEST_PHONE)!;

      // Simulate TTL expiration by backdating expires_at
      challengeStore[0].expires_at = new Date(Date.now() - 10000);

      const res = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: TEST_PHONE, otp });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Invalid OTP");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. RESEND COOLDOWN & INVALIDATING PRIOR CHALLENGES
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Invariant 6: Resend Cooldown and Challenge Invalidation", () => {
    it("MUST reject consecutive resend within 60s cooldown window", async () => {
      // First request
      const first = await request(app)
        .post("/api/auth/send-otp")
        .send({ phone: TEST_PHONE, type: "login" });
      expect(first.status).toBe(200);

      // Immediate resend attempt: Must be rejected with 429
      const second = await request(app)
        .post("/api/auth/send-otp")
        .send({ phone: TEST_PHONE, type: "login" });
      expect(second.status).toBe(429);
      expect(second.body.code).toBe("OTP_RESEND_COOLDOWN");
    });

    it("MUST invalidate earlier OTP when a new OTP is requested after cooldown", async () => {
      await request(app)
        .post("/api/auth/send-otp")
        .send({ phone: TEST_PHONE, type: "login" });

      const otpA = defaultMockSmsProvider.getLastOtpFor(TEST_PHONE)!;

      // Simulate elapsed cooldown time (advance created_at by 65 seconds)
      challengeStore[0].created_at = new Date(Date.now() - 65000);

      // Request second OTP
      const secondSend = await request(app)
        .post("/api/auth/send-otp")
        .send({ phone: TEST_PHONE, type: "login" });
      expect(secondSend.status).toBe(200);

      const otpB = defaultMockSmsProvider.getLastOtpFor(TEST_PHONE)!;
      expect(otpA).not.toBe(otpB);

      // Old OTP A MUST be rejected
      const verifyARes = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: TEST_PHONE, otp: otpA });
      expect(verifyARes.status).toBe(401);

      // New OTP B MUST be accepted
      const verifyBRes = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: TEST_PHONE, otp: otpB });
      expect(verifyBRes.status).toBe(200);
      expect(verifyBRes.body.success).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. PURPOSE ISOLATION
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Invariant 7: Purpose / Context Isolation", () => {
    it("MUST reject an OTP requested for 'register' when verified for 'login'", async () => {
      // Send OTP for registration
      await request(app)
        .post("/api/auth/send-otp")
        .send({ phone: TEST_PHONE, type: "register" });

      const registerOtp = defaultMockSmsProvider.getLastOtpFor(TEST_PHONE)!;

      // Attempt to verify for login
      const loginVerifyRes = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: TEST_PHONE, otp: registerOtp, type: "login" });

      expect(loginVerifyRes.status).toBe(401);
      expect(loginVerifyRes.body.success).toBe(false);

      // Verifying for matching purpose 'register' must succeed
      const registerVerifyRes = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: TEST_PHONE, otp: registerOtp, type: "register" });

      expect(registerVerifyRes.status).toBe(200);
      expect(registerVerifyRes.body.success).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. CONCURRENCY SAFETY & RACE CONDITION PROTECTION
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Invariant 8: Concurrency Safety (N simultaneous verification requests)", () => {
    it("MUST allow exactly ONE request to consume the OTP and reject all other concurrent callers", async () => {
      await request(app)
        .post("/api/auth/send-otp")
        .send({ phone: TEST_PHONE, type: "login" });

      const validOtp = defaultMockSmsProvider.getLastOtpFor(TEST_PHONE)!;

      // Launch 5 simultaneous verification requests concurrently
      const concurrentRequests = Array.from({ length: 5 }, () =>
        request(app)
          .post("/api/auth/verify-otp")
          .send({ phone: TEST_PHONE, otp: validOtp })
      );

      const responses = await Promise.all(concurrentRequests);

      const successes = responses.filter((r) => r.status === 200);
      const failures = responses.filter((r) => r.status === 401);

      expect(successes.length).toBe(1);
      expect(failures.length).toBe(4);
      expect(successes[0].body.data.token).toBeDefined();

      // Ensure challenge status is CONSUMED in DB
      expect(challengeStore[0].status).toBe("CONSUMED");
      expect(challengeStore[0].consumed_at).not.toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. SMS DELIVERY FAILURE SAFETY & FAIL-CLOSED BEHAVIOR
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Invariant 9: SMS Delivery Failure Handling", () => {
    it("MUST invalidate challenge and return error if SMS provider fails to deliver", async () => {
      defaultMockSmsProvider.shouldFailNext = true;

      const res = await request(app)
        .post("/api/auth/send-otp")
        .send({ phone: TEST_PHONE, type: "login" });

      expect(res.status).toBe(502);
      expect(res.body.code).toBe("SMS_DELIVERY_FAILED");

      // Verify challenge was marked as DELIVERY_FAILED
      expect(challengeStore[0].status).toBe("DELIVERY_FAILED");
      expect(challengeStore[0].consumed_at).not.toBeNull();

      // Verification of this failed delivery challenge must fail
      const verifyRes = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: TEST_PHONE, otp: "123456" });
      expect(verifyRes.status).toBe(401);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. INPUT VALIDATION & NON-LEAKAGE
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Invariant 10: Input Validation & Information Leakage Defense", () => {
    it("MUST reject non-numeric OTP before expensive database lookup", async () => {
      const res = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: TEST_PHONE, otp: "abcdef" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("MUST reject OTP with invalid length (5 or 7 digits)", async () => {
      const tooShort = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: TEST_PHONE, otp: "12345" });
      expect(tooShort.status).toBe(400);

      const tooLong = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: TEST_PHONE, otp: "1234567" });
      expect(tooLong.status).toBe(400);
    });

    it("MUST NOT return plaintext OTP in API response for send-otp", async () => {
      const res = await request(app)
        .post("/api/auth/send-otp")
        .send({ phone: TEST_PHONE, type: "login" });

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain("123456");
      expect(res.body.otp).toBeUndefined();
      expect(res.body.code).toBeUndefined();
      expect(res.body.message).toBe("OTP sent successfully.");
    });
  });
});
