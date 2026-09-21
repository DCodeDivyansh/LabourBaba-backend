import crypto from "crypto";
import bcrypt from "bcrypt";
import prisma from "../src/config/prisma";
import { authService } from "../src/features/auth/auth.services";
import { OTP_STATUS } from "../src/features/auth/auth.types";
import { authConfig } from "../src/config/authConfig";

describe("P3 Issue 2 — Canonical OTP Lifecycle & Real PostgreSQL Concurrency", () => {
  jest.setTimeout(60000);

  const testPhone = `+9197${Math.floor(10000000 + Math.random() * 90000000)}`;
  let customerId: string;

  beforeAll(async () => {
    const customer = await prisma.customer.create({
      data: {
        phone: testPhone,
        password: "hashed_customer_password",
        name: "OTP Test Customer",
      },
    });
    customerId = customer.id;
  });

  afterAll(async () => {
    try {
      await prisma.refresh_session.deleteMany({ where: { user_id: customerId } });
      await prisma.otp_challenge.deleteMany({ where: { phone: testPhone } });
      await prisma.customer.deleteMany({ where: { id: customerId } });
    } catch {}
    await prisma.$disconnect();
  });

  describe("1. Database Schema & CHECK Constraint Invariants", () => {
    it("MUST accept all legal lifecycle statuses: ACTIVE, CONSUMED, EXPIRED, LOCKED", async () => {
      const statuses = [OTP_STATUS.ACTIVE, OTP_STATUS.CONSUMED, OTP_STATUS.EXPIRED, OTP_STATUS.LOCKED];

      for (const st of statuses) {
        const secret = "123456";
        const otp_hash = await bcrypt.hash(secret, 10);

        const challenge = await prisma.otp_challenge.create({
          data: {
            phone: testPhone,
            purpose: "login",
            otp_hash,
            status: st,
            expires_at: new Date(Date.now() + 600000),
            attempt_count: 0,
          },
        });

        expect(challenge.status).toBe(st);
        await prisma.otp_challenge.delete({ where: { id: challenge.id } });
      }
    });

    it("MUST reject illegal OTP statuses at the database layer (e.g. INVALID_STATUS, INVALIDATED)", async () => {
      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO "otp_challenge" ("id", "phone", "purpose", "otp_hash", "status", "expires_at", "created_at")
          VALUES (gen_random_uuid(), '${testPhone}', 'login', 'hash123', 'INVALID_STATUS', NOW() + INTERVAL '10 min', NOW());
        `)
      ).rejects.toThrow(/chk_otp_challenge_status|check constraint/i);
    });
  });

  describe("2. OTP Issuance & Resend Expiration Lifecycle", () => {
    it("MUST create ACTIVE challenge on sendOtp and expire prior active challenges on resend", async () => {
      // 1. Manually create an initial active challenge
      const plain1 = "111111";
      const hash1 = await bcrypt.hash(plain1, 10);
      const c1 = await prisma.otp_challenge.create({
        data: {
          phone: testPhone,
          purpose: "login",
          otp_hash: hash1,
          status: OTP_STATUS.ACTIVE,
          expires_at: new Date(Date.now() + 600000),
          // Set created_at past the cooldown window so resend is allowed
          created_at: new Date(Date.now() - (authConfig.otpResendCooldownSeconds + 5) * 1000),
        },
      });

      // 2. Call sendOtp to simulate resend
      await authService.sendOtp(testPhone, "login");

      // Invariant: c1 MUST now be EXPIRED
      const updatedC1 = await prisma.otp_challenge.findUnique({ where: { id: c1.id } });
      expect(updatedC1!.status).toBe(OTP_STATUS.EXPIRED);
      expect(updatedC1!.consumed_at).not.toBeNull();

      // Invariant: The new challenge is ACTIVE
      const activeChallenges = await prisma.otp_challenge.findMany({
        where: { phone: testPhone, purpose: "login", status: OTP_STATUS.ACTIVE },
      });
      expect(activeChallenges.length).toBe(1);

      // Attempting to verify old code plain1 MUST fail
      await expect(authService.verifyOtp(testPhone, plain1, "login")).rejects.toMatchObject({
        code: "OTP_INVALID",
      });
    });
  });

  describe("3. Atomic Single-Use Verification & Replay Rejection", () => {
    it("MUST verify and CONSUME active challenge, rejecting replay attempts", async () => {
      // Clean up previous active challenges
      await prisma.otp_challenge.updateMany({
        where: { phone: testPhone, status: OTP_STATUS.ACTIVE },
        data: { status: OTP_STATUS.EXPIRED },
      });

      const validCode = "654321";
      const validHash = await bcrypt.hash(validCode, 10);
      const challenge = await prisma.otp_challenge.create({
        data: {
          phone: testPhone,
          purpose: "login",
          otp_hash: validHash,
          status: OTP_STATUS.ACTIVE,
          expires_at: new Date(Date.now() + 600000),
        },
      });

      // 1. First verification -> Success
      const authResult = await authService.verifyOtp(testPhone, validCode, "login");
      expect(authResult.token).toBeDefined();
      expect(authResult.refreshToken).toBeDefined();

      // Database state verification
      const dbChallenge = await prisma.otp_challenge.findUnique({ where: { id: challenge.id } });
      expect(dbChallenge!.status).toBe(OTP_STATUS.CONSUMED);
      expect(dbChallenge!.consumed_at).not.toBeNull();

      // 2. Second verification with same code -> Rejected (Replay prevention)
      await expect(authService.verifyOtp(testPhone, validCode, "login")).rejects.toMatchObject({
        code: "OTP_INVALID",
      });
    });
  });

  describe("4. Expiration & Attempt Limit Enforcement", () => {
    it("MUST reject expired OTP challenges during verification", async () => {
      const code = "999888";
      const hash = await bcrypt.hash(code, 10);
      await prisma.otp_challenge.create({
        data: {
          phone: testPhone,
          purpose: "login",
          otp_hash: hash,
          status: OTP_STATUS.ACTIVE,
          expires_at: new Date(Date.now() - 5000), // expired 5s ago
        },
      });

      await expect(authService.verifyOtp(testPhone, code, "login")).rejects.toMatchObject({
        code: "OTP_INVALID",
      });
    });

    it("MUST lock challenge when maximum incorrect attempts are reached", async () => {
      // Clean up active
      await prisma.otp_challenge.updateMany({
        where: { phone: testPhone, status: OTP_STATUS.ACTIVE },
        data: { status: OTP_STATUS.EXPIRED },
      });

      const correctCode = "123456";
      const hash = await bcrypt.hash(correctCode, 10);
      const challenge = await prisma.otp_challenge.create({
        data: {
          phone: testPhone,
          purpose: "login",
          otp_hash: hash,
          status: OTP_STATUS.ACTIVE,
          expires_at: new Date(Date.now() + 600000),
          attempt_count: 0,
        },
      });

      // Submit incorrect codes up to max attempts
      for (let i = 0; i < authConfig.otpMaxAttempts - 1; i++) {
        await expect(authService.verifyOtp(testPhone, "000000", "login")).rejects.toMatchObject({
          code: "OTP_INVALID",
        });
      }

      // Final attempt reaching limit -> OTP_MAX_ATTEMPTS
      await expect(authService.verifyOtp(testPhone, "000000", "login")).rejects.toMatchObject({
        code: "OTP_MAX_ATTEMPTS",
      });

      // Verify DB record is LOCKED
      const lockedChallenge = await prisma.otp_challenge.findUnique({ where: { id: challenge.id } });
      expect(lockedChallenge!.status).toBe(OTP_STATUS.LOCKED);

      // Even correct code is now rejected because challenge is LOCKED
      await expect(authService.verifyOtp(testPhone, correctCode, "login")).rejects.toMatchObject({
        code: "OTP_INVALID",
      });
    });
  });

  describe("5. Real PostgreSQL Concurrency: 20 Simultaneous Verifications", () => {
    it("MUST guarantee exactly one successful verification when 20 requests verify concurrently", async () => {
      // Clean up active
      await prisma.otp_challenge.updateMany({
        where: { phone: testPhone, status: OTP_STATUS.ACTIVE },
        data: { status: OTP_STATUS.EXPIRED },
      });

      const validCode = "777888";
      const validHash = await bcrypt.hash(validCode, 10);
      const challenge = await prisma.otp_challenge.create({
        data: {
          phone: testPhone,
          purpose: "login",
          otp_hash: validHash,
          status: OTP_STATUS.ACTIVE,
          expires_at: new Date(Date.now() + 600000),
          attempt_count: 0,
        },
      });

      const CONCURRENCY = 20;
      const promises: Promise<any>[] = [];

      for (let i = 0; i < CONCURRENCY; i++) {
        promises.push(authService.verifyOtp(testPhone, validCode, "login"));
      }

      const results = await Promise.allSettled(promises);

      const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

      // Invariant 1: Exactly ONE request consumes the challenge
      expect(fulfilled.length).toBe(1);

      // Invariant 2: The remaining 19 requests fail safely
      expect(rejected.length).toBe(CONCURRENCY - 1);

      for (const rej of rejected) {
        expect(["OTP_INVALID", "OTP_ALREADY_USED"]).toContain(rej.reason?.code);
      }

      // Invariant 3: Final database state is CONSUMED with consumed_at timestamp
      const finalRecord = await prisma.otp_challenge.findUnique({ where: { id: challenge.id } });
      expect(finalRecord!.status).toBe(OTP_STATUS.CONSUMED);
      expect(finalRecord!.consumed_at).not.toBeNull();
    });
  });
});
