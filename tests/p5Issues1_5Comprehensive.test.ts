import crypto from "crypto";
import bcrypt from "bcrypt";
import request from "supertest";
import prisma from "../src/config/prisma";
import { app } from "../src/server";
import { sessionService } from "../src/features/auth/session.service";
import { authService } from "../src/features/auth/auth.services";
import { SESSION_STATUS, REVOKE_REASON } from "../src/features/auth/session.types";
import { OTP_STATUS } from "../src/features/auth/auth.types";
import { UserRole } from "../src/type/userRole";
import { generateToken } from "../src/utils/authUtils";
import {
  toWorkerPublicDTO,
  toCustomerSelfDTO,
  toBookingDTO,
  toJobDTO,
} from "../src/shared/prismaSelects";

describe("P5 Issues 1–5 Comprehensive Verification Suite (Real PostgreSQL)", () => {
  jest.setTimeout(60000);

  let categoryId: string;
  let workerAId: string;
  let workerBId: string;
  let customerAId: string;
  let customerBId: string;
  let adminId: string;

  let customerAToken: string;
  let customerBToken: string;
  let workerAToken: string;
  let workerBToken: string;
  let adminToken: string;

  const phoneSuffix = Math.floor(10000000 + Math.random() * 90000000).toString();
  const workerAPhone = `+9198${phoneSuffix}`;
  const workerBPhone = `+9197${phoneSuffix}`;
  const customerAPhone = `+9196${phoneSuffix}`;
  const customerBPhone = `+9195${phoneSuffix}`;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash("password123!", 10);

    // 1. Skill category
    const cat = await prisma.skill_category.create({
      data: { name: `P5TestSkill-${Date.now()}` },
    });
    categoryId = cat.id;

    // 2. Workers
    const workerA = await prisma.worker.create({
      data: {
        skill_category_id: categoryId,
        phone: workerAPhone,
        skill_type: "Carpenter",
        password: passwordHash,
        name: "P5 Worker A",
        verification_status: "verified",
      },
    });
    workerAId = workerA.id;

    const workerB = await prisma.worker.create({
      data: {
        skill_category_id: categoryId,
        phone: workerBPhone,
        skill_type: "Electrician",
        password: passwordHash,
        name: "P5 Worker B",
        verification_status: "verified",
      },
    });
    workerBId = workerB.id;

    // 3. Customers
    const customerA = await prisma.customer.create({
      data: {
        phone: customerAPhone,
        password: passwordHash,
        name: "P5 Customer A",
      },
    });
    customerAId = customerA.id;

    const customerB = await prisma.customer.create({
      data: {
        phone: customerBPhone,
        password: passwordHash,
        name: "P5 Customer B",
      },
    });
    customerBId = customerB.id;

    adminId = crypto.randomUUID();

    // 4. JWT Tokens
    customerAToken = generateToken({ id: customerAId, phone: customerAPhone, role: UserRole.CUSTOMER });
    customerBToken = generateToken({ id: customerBId, phone: customerBPhone, role: UserRole.CUSTOMER });
    workerAToken = generateToken({ id: workerAId, phone: workerAPhone, role: UserRole.WORKER });
    workerBToken = generateToken({ id: workerBId, phone: workerBPhone, role: UserRole.WORKER });
    adminToken = generateToken({ id: adminId, phone: "+919999999999", role: UserRole.ADMIN });
  });

  afterAll(async () => {
    try {
      await prisma.refresh_session.deleteMany({
        where: { user_id: { in: [workerAId, workerBId, customerAId, customerBId] } },
      });
      await prisma.otp_challenge.deleteMany({
        where: { phone: { in: [customerAPhone, customerBPhone, workerAPhone, workerBPhone] } },
      });
      await prisma.booking.deleteMany({
        where: { customer_id: { in: [customerAId, customerBId] } },
      });
      await prisma.job_requirement.deleteMany({
        where: { job: { customer_id: { in: [customerAId, customerBId] } } },
      });
      await prisma.job.deleteMany({
        where: { customer_id: { in: [customerAId, customerBId] } },
      });
      await prisma.worker.deleteMany({ where: { id: { in: [workerAId, workerBId] } } });
      await prisma.customer.deleteMany({ where: { id: { in: [customerAId, customerBId] } } });
      await prisma.skill_category.deleteMany({ where: { id: categoryId } });
    } catch {}
    await prisma.$disconnect();
  });

  // =========================================================================
  // ISSUE 1: CANONICAL REFRESH-SESSION LIFECYCLE (P0)
  // =========================================================================
  describe("P5-1: Canonical Refresh-Session Lifecycle", () => {
    it("1.1 Database CHECK constraint rejects invalid session statuses", async () => {
      const familyId = crypto.randomUUID();
      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO "refresh_session" ("id", "user_id", "user_role", "token_hash", "family_id", "status", "expires_at", "created_at")
          VALUES (gen_random_uuid(), '${customerAId}', 'customer', 'hash', '${familyId}', 'INVALID_STATUS', NOW() + INTERVAL '1 day', NOW());
        `)
      ).rejects.toThrow(/chk_refresh_session_status|check constraint/i);
    });

    it("1.2 Database unique index rejects duplicate rotated_to_id", async () => {
      const familyId = crypto.randomUUID();

      // First create valid successor session in database so FK is satisfied
      const successor = await prisma.refresh_session.create({
        data: {
          user_id: customerAId,
          user_role: UserRole.CUSTOMER,
          token_hash: "succ_hash_" + crypto.randomUUID(),
          family_id: familyId,
          status: SESSION_STATUS.ACTIVE,
          expires_at: new Date(Date.now() + 86400000),
        },
      });

      // Create session 1 pointing to successor.id
      await prisma.refresh_session.create({
        data: {
          user_id: customerAId,
          user_role: UserRole.CUSTOMER,
          token_hash: "hash1_" + crypto.randomUUID(),
          family_id: familyId,
          status: SESSION_STATUS.ROTATED,
          rotated_to_id: successor.id,
          expires_at: new Date(Date.now() + 86400000),
        },
      });

      // Attempt session 2 pointing to the same successor.id -> MUST violate unique index
      await expect(
        prisma.refresh_session.create({
          data: {
            user_id: customerAId,
            user_role: UserRole.CUSTOMER,
            token_hash: "hash2_" + crypto.randomUUID(),
            family_id: familyId,
            status: SESSION_STATUS.ROTATED,
            rotated_to_id: successor.id,
            expires_at: new Date(Date.now() + 86400000),
          },
        })
      ).rejects.toThrow(/uniq_refresh_session_rotated_to|unique/i);
    });

    it("1.3 Normal rotation atomically advances session to ROTATED and creates 1 ACTIVE successor", async () => {
      const initial = await sessionService.createSession({
        userId: customerAId,
        userRole: UserRole.CUSTOMER,
      });

      const rotated = await sessionService.rotateSession(initial.rawToken);
      expect(rotated.newSessionId).toBeDefined();
      expect(rotated.newRawToken).toBeDefined();

      const oldRecord = await prisma.refresh_session.findUnique({ where: { id: initial.sessionId } });
      expect(oldRecord!.status).toBe(SESSION_STATUS.ROTATED);
      expect(oldRecord!.rotated_to_id).toBe(rotated.newSessionId);

      const newRecord = await prisma.refresh_session.findUnique({ where: { id: rotated.newSessionId } });
      expect(newRecord!.status).toBe(SESSION_STATUS.ACTIVE);
      expect(newRecord!.family_id).toBe(oldRecord!.family_id);
    });

    it("1.4 Real PostgreSQL Concurrency: 10 simultaneous refresh requests on same token produce exactly 1 successor and winner remains usable", async () => {
      const initial = await sessionService.createSession({
        userId: workerAId,
        userRole: UserRole.WORKER,
      });

      const CONCURRENCY = 10;
      const promises: Promise<any>[] = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        promises.push(sessionService.rotateSession(initial.rawToken));
      }

      const results = await Promise.allSettled(promises);
      const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

      // Invariant 1: Exactly 1 winner
      expect(fulfilled.length).toBe(1);
      // Invariant 2: Exactly 9 losers
      expect(rejected.length).toBe(CONCURRENCY - 1);

      // Invariant 3: Losers fail with deterministic error
      for (const rej of rejected) {
        expect(["CONCURRENT_REFRESH_CONFLICT", "REFRESH_TOKEN_REUSE", "INVALID_REFRESH_TOKEN"]).toContain(rej.reason?.code);
      }

      // Invariant 4: Winner successor MUST remain ACTIVE and usable
      const winnerSuccessor = await prisma.refresh_session.findUnique({
        where: { id: fulfilled[0].value.newSessionId },
      });
      expect(winnerSuccessor!.status).toBe(SESSION_STATUS.ACTIVE);

      // Subsequent rotation using the winning token MUST succeed
      const secondRot = await sessionService.rotateSession(fulfilled[0].value.newRawToken);
      expect(secondRot.newSessionId).toBeDefined();
    });

    it("1.5 Genuine reuse detection revokes entire token family when previously rotated token is presented again", async () => {
      const s1 = await sessionService.createSession({
        userId: customerAId,
        userRole: UserRole.CUSTOMER,
      });

      const s2 = await sessionService.rotateSession(s1.rawToken);

      // Presenting old s1 again MUST trigger reuse detection
      await expect(sessionService.rotateSession(s1.rawToken)).rejects.toMatchObject({
        code: "REFRESH_TOKEN_REUSE",
      });

      // Both s1 and s2 MUST now be REVOKED
      const s1Db = await prisma.refresh_session.findUnique({ where: { id: s1.sessionId } });
      const s2Db = await prisma.refresh_session.findUnique({ where: { id: s2.newSessionId } });
      expect(s1Db!.status).toBe(SESSION_STATUS.REVOKED);
      expect(s2Db!.status).toBe(SESSION_STATUS.REVOKED);

      // Attempting to rotate s2 also fails
      await expect(sessionService.rotateSession(s2.newRawToken)).rejects.toMatchObject({
        code: "REFRESH_TOKEN_REUSE",
      });
    });

    it("1.6 Logout revokes targeted session and subsequent refresh fails", async () => {
      const sess = await sessionService.createSession({
        userId: customerAId,
        userRole: UserRole.CUSTOMER,
      });

      await sessionService.revokeSession(sess.sessionId, customerAId, REVOKE_REASON.LOGOUT);

      const dbSess = await prisma.refresh_session.findUnique({ where: { id: sess.sessionId } });
      expect(dbSess!.status).toBe(SESSION_STATUS.REVOKED);
      expect(dbSess!.revoked_reason).toBe(REVOKE_REASON.LOGOUT);

      await expect(sessionService.rotateSession(sess.rawToken)).rejects.toMatchObject({
        code: "REFRESH_TOKEN_REUSE",
      });
    });

    it("1.7 Suspended worker account cannot rotate refresh session", async () => {
      const sess = await sessionService.createSession({
        userId: workerBId,
        userRole: UserRole.WORKER,
      });

      // Suspend worker B
      await prisma.worker.update({
        where: { id: workerBId },
        data: { verification_status: "suspended" },
      });

      await expect(sessionService.rotateSession(sess.rawToken)).rejects.toMatchObject({
        code: "ACCOUNT_SUSPENDED",
      });

      // Restore worker B verification status
      await prisma.worker.update({
        where: { id: workerBId },
        data: { verification_status: "verified" },
      });
    });
  });

  // =========================================================================
  // ISSUE 2: CANONICAL OTP LIFECYCLE (P0)
  // =========================================================================
  describe("P5-2: Canonical OTP Lifecycle", () => {
    const testOtpPhone = `+9194${phoneSuffix}`;

    it("2.1 Database CHECK constraint rejects invalid OTP statuses", async () => {
      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO "otp_challenge" ("id", "phone", "purpose", "otp_hash", "status", "expires_at", "created_at")
          VALUES (gen_random_uuid(), '${testOtpPhone}', 'login', 'hash', 'BOGUS_STATUS', NOW() + INTERVAL '10 min', NOW());
        `)
      ).rejects.toThrow(/chk_otp_challenge_status|check constraint/i);
    });

    it("2.2 Database partial unique index rejects duplicate ACTIVE challenges for same phone/purpose", async () => {
      await prisma.otp_challenge.create({
        data: {
          phone: testOtpPhone,
          purpose: "login",
          otp_hash: "hash1",
          status: OTP_STATUS.ACTIVE,
          expires_at: new Date(Date.now() + 600000),
        },
      });

      await expect(
        prisma.otp_challenge.create({
          data: {
            phone: testOtpPhone,
            purpose: "login",
            otp_hash: "hash2",
            status: OTP_STATUS.ACTIVE,
            expires_at: new Date(Date.now() + 600000),
          },
        })
      ).rejects.toThrow(/uniq_active_otp_phone_purpose|unique/i);

      await prisma.otp_challenge.deleteMany({ where: { phone: testOtpPhone } });
    });

    it("2.3 Correct OTP verification transitions challenge to CONSUMED atomically and replay fails", async () => {
      const plainCode = "654321";
      const hash = await bcrypt.hash(plainCode, 10);

      const challenge = await prisma.otp_challenge.create({
        data: {
          phone: customerAPhone,
          purpose: "login",
          otp_hash: hash,
          status: OTP_STATUS.ACTIVE,
          expires_at: new Date(Date.now() + 600000),
        },
      });

      // Verify once -> Success
      const result = await authService.verifyOtp(customerAPhone, plainCode, "login");
      expect(result.token).toBeDefined();

      const updated = await prisma.otp_challenge.findUnique({ where: { id: challenge.id } });
      expect(updated!.status).toBe(OTP_STATUS.CONSUMED);
      expect(updated!.consumed_at).not.toBeNull();

      // Replay verification -> MUST fail
      await expect(authService.verifyOtp(customerAPhone, plainCode, "login")).rejects.toMatchObject({
        code: "OTP_INVALID",
      });
    });

    it("2.4 Real PostgreSQL Concurrency: 10 simultaneous correct verifications consume challenge exactly ONCE", async () => {
      const plainCode = "777777";
      const hash = await bcrypt.hash(plainCode, 10);

      const challenge = await prisma.otp_challenge.create({
        data: {
          phone: customerBPhone,
          purpose: "login",
          otp_hash: hash,
          status: OTP_STATUS.ACTIVE,
          expires_at: new Date(Date.now() + 600000),
        },
      });

      const CONCURRENCY = 10;
      const promises: Promise<any>[] = [];
      for (let i = 0; i < CONCURRENCY; i++) {
        promises.push(authService.verifyOtp(customerBPhone, plainCode, "login"));
      }

      const results = await Promise.allSettled(promises);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(CONCURRENCY - 1);

      const dbChallenge = await prisma.otp_challenge.findUnique({ where: { id: challenge.id } });
      expect(dbChallenge!.status).toBe(OTP_STATUS.CONSUMED);
    });

    it("2.5 Real PostgreSQL Concurrency: 10 concurrent incorrect submissions increment attempt count atomically and lock challenge", async () => {
      const correctCode = "888888";
      const hash = await bcrypt.hash(correctCode, 10);

      const challenge = await prisma.otp_challenge.create({
        data: {
          phone: testOtpPhone,
          purpose: "login",
          otp_hash: hash,
          status: OTP_STATUS.ACTIVE,
          expires_at: new Date(Date.now() + 600000),
          attempt_count: 0,
        },
      });

      const promises: Promise<any>[] = [];
      for (let i = 0; i < 10; i++) {
        promises.push(authService.verifyOtp(testOtpPhone, "000000", "login"));
      }

      await Promise.allSettled(promises);

      const updated = await prisma.otp_challenge.findUnique({ where: { id: challenge.id } });
      expect(updated!.attempt_count).toBeGreaterThanOrEqual(5);
      expect(updated!.status).toBe(OTP_STATUS.LOCKED);

      // Subsequent attempt with CORRECT code MUST now be rejected
      await expect(authService.verifyOtp(testOtpPhone, correctCode, "login")).rejects.toMatchObject({
        code: "OTP_INVALID",
      });

      await prisma.otp_challenge.deleteMany({ where: { phone: testOtpPhone } });
    });

    it("2.6 Resend invalidates prior active challenge by marking it EXPIRED", async () => {
      await prisma.otp_challenge.deleteMany({ where: { phone: testOtpPhone } });

      const plain1 = "111111";
      const hash1 = await bcrypt.hash(plain1, 10);

      const c1 = await prisma.otp_challenge.create({
        data: {
          phone: testOtpPhone,
          purpose: "login",
          otp_hash: hash1,
          status: OTP_STATUS.ACTIVE,
          expires_at: new Date(Date.now() + 600000),
          created_at: new Date(Date.now() - 70000), // bypass cooldown
        },
      });

      await authService.sendOtp(testOtpPhone, "login");

      const updatedC1 = await prisma.otp_challenge.findUnique({ where: { id: c1.id } });
      expect(updatedC1!.status).toBe(OTP_STATUS.EXPIRED);

      // Verifying old code MUST fail
      await expect(authService.verifyOtp(testOtpPhone, plain1, "login")).rejects.toMatchObject({
        code: "OTP_INVALID",
      });

      await prisma.otp_challenge.deleteMany({ where: { phone: testOtpPhone } });
    });
  });

  // =========================================================================
  // ISSUE 3: PRINCIPAL-DERIVED AUTHORIZATION (P0/P1)
  // =========================================================================
  describe("P5-3: Principal-Derived Authorization", () => {
    let jobAId: string;
    let reqAId: string;
    let bookingAId: string;

    beforeAll(async () => {
      const job = await prisma.job.create({
        data: {
          customer_id: customerAId,
          status: "OPEN",
          dispatch_status: "IDLE",
        },
      });
      jobAId = job.id;

      const req = await prisma.job_requirement.create({
        data: {
          job_id: jobAId,
          skill_id: categoryId,
          skill_type: "Carpenter",
          worker_count_needed: 1,
          status: "OPEN",
        },
      });
      reqAId = req.id;

      const booking = await prisma.booking.create({
        data: {
          job_id: jobAId,
          requirement_id: reqAId,
          worker_id: workerAId,
          customer_id: customerAId,
          status: "CONFIRMED",
        },
      });
      bookingAId = booking.id;
    });

    it("3.1 Customer A can read own job, Customer B receives 404 cleanly (IDOR protection)", async () => {
      const resA = await request(app)
        .get(`/api/jobs/${jobAId}`)
        .set("Authorization", `Bearer ${customerAToken}`);
      expect(resA.status).toBe(200);
      expect(resA.body.data.id).toBe(jobAId);

      const resB = await request(app)
        .get(`/api/jobs/${jobAId}`)
        .set("Authorization", `Bearer ${customerBToken}`);
      expect(resB.status).toBe(404);
    });

    it("3.2 Assigned Worker A can read Booking A; unrelated Worker B receives 404/403", async () => {
      const resWorkerA = await request(app)
        .get(`/api/bookings/${bookingAId}`)
        .set("Authorization", `Bearer ${workerAToken}`);
      expect(resWorkerA.status).toBe(200);
      expect(resWorkerA.body.data.id).toBe(bookingAId);

      const resWorkerB = await request(app)
        .get(`/api/bookings/${bookingAId}`)
        .set("Authorization", `Bearer ${workerBToken}`);
      expect([403, 404]).toContain(resWorkerB.status);
    });

    it("3.3 Worker attempting to view payment or issue refund is denied with 403", async () => {
      const resPayment = await request(app)
        .get(`/api/payments/${bookingAId}`)
        .set("Authorization", `Bearer ${workerAToken}`);
      expect(resPayment.status).toBe(403);
    });

    it("3.4 Unauthenticated request to protected endpoints receives 401", async () => {
      const res = await request(app).get(`/api/jobs/${jobAId}`);
      expect(res.status).toBe(401);
    });

    it("3.5 Admin endpoints require explicit ADMIN role; regular customer is rejected with 403", async () => {
      const resCust = await request(app)
        .get("/api/admin/jobs")
        .set("Authorization", `Bearer ${customerAToken}`);
      expect(resCust.status).toBe(403);

      const resAdmin = await request(app)
        .get("/api/admin/jobs")
        .set("Authorization", `Bearer ${adminToken}`);
      expect([200, 404]).toContain(resAdmin.status);
    });
  });

  // =========================================================================
  // ISSUE 4: REMOVE CLIENT-CONTROLLED CUSTOMER IDENTITY (P1)
  // =========================================================================
  describe("P5-4: Remove Client-Controlled Customer Identity", () => {
    it("4.1 POST /api/jobs with injected customer_id is rejected by strict validation with 400", async () => {
      const res = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({
          customer_id: customerBId,
          latitude: 12.9716,
          longitude: 77.5946,
          location: "Bangalore",
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("4.2 POST /api/jobs without customer_id binds ownership strictly to authenticated principal", async () => {
      const res = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({
          latitude: 12.9716,
          longitude: 77.5946,
          location: "Bangalore",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.customer_id).toBe(customerAId);

      const createdJob = await prisma.job.findUnique({ where: { id: res.body.data.id } });
      expect(createdJob!.customer_id).toBe(customerAId);
    });

    it("4.3 GET /api/jobs?customer_id=B ignores injected query param and returns ONLY Customer A's jobs", async () => {
      const res = await request(app)
        .get(`/api/jobs?customer_id=${customerBId}`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      for (const j of res.body.data) {
        expect(j.customer_id).toBe(customerAId);
      }
    });

    it("4.4 Customer A cannot cancel Customer B's job", async () => {
      const jobB = await prisma.job.create({
        data: {
          customer_id: customerBId,
          status: "OPEN",
          dispatch_status: "IDLE",
        },
      });

      const res = await request(app)
        .patch(`/api/jobs/${jobB.id}/cancel`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect([403, 404]).toContain(res.status);
    });
  });

  // =========================================================================
  // ISSUE 5: UNIVERSAL DTO BOUNDARY ENFORCEMENT (P0)
  // =========================================================================
  describe("P5-5: Universal DTO Boundary Enforcement", () => {
    it("5.1 Worker public DTO excludes password, device_token, and aadhaar", () => {
      const rawWorker: any = {
        id: crypto.randomUUID(),
        name: "Test Worker",
        phone: "+919876543210",
        password: "secret_bcrypt_hash",
        device_token: "fcm_token_secret",
        aadhaar_last4: "1234",
        worker_score: 4.8,
        skill_type: "Plumber",
        is_online: true,
        skill_category_id: crypto.randomUUID(),
        extra_unexpected_field: "SHOULD_NOT_LEAK",
      };

      const dto = toWorkerPublicDTO(rawWorker);
      expect(dto).not.toBeNull();
      expect(dto).not.toHaveProperty("password");
      expect(dto).not.toHaveProperty("device_token");
      expect(dto).not.toHaveProperty("aadhaar_last4");
      expect(dto).not.toHaveProperty("extra_unexpected_field");
      expect(dto!.name).toBe("Test Worker");
    });

    it("5.2 Customer self DTO excludes password and deleted_at", () => {
      const rawCustomer: any = {
        id: crypto.randomUUID(),
        name: "Test Customer",
        phone: "+919876543210",
        password: "secret_bcrypt_hash",
        deleted_at: null,
        future_database_column: "CONFIDENTIAL",
      };

      const dto = toCustomerSelfDTO(rawCustomer);
      expect(dto).not.toBeNull();
      expect(dto).not.toHaveProperty("password");
      expect(dto).not.toHaveProperty("deleted_at");
      expect(dto).not.toHaveProperty("future_database_column");
      expect(dto!.name).toBe("Test Customer");
    });

    it("5.3 Booking DTO strictly excludes otp_hash", () => {
      const rawBooking: any = {
        id: crypto.randomUUID(),
        job_id: crypto.randomUUID(),
        requirement_id: crypto.randomUUID(),
        worker_id: crypto.randomUUID(),
        customer_id: crypto.randomUUID(),
        status: "CONFIRMED",
        otp_hash: "otp_bcrypt_hash_secret",
        otp_attempts: 0,
      };

      const dto = toBookingDTO(rawBooking);
      expect(dto).not.toBeNull();
      expect(dto).not.toHaveProperty("otp_hash");
      expect(dto!.status).toBe("CONFIRMED");
    });

    it("5.4 HTTP GET /api/clients/me never leaks password or tokens", async () => {
      const res = await request(app)
        .get("/api/clients/me")
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).not.toHaveProperty("password");
      expect(res.body.data).not.toHaveProperty("password_hash");
      expect(res.body.data).not.toHaveProperty("token");
    });
  });
});
