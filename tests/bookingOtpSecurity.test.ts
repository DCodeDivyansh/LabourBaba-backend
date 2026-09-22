/**
 * Issue #17 — Harden Booking OTP Verification
 * Priority: P1 Marketplace Correctness (Audit Finding #31)
 *
 * Comprehensive Security & Lifecycle Verification Test Suite:
 * 1.  Authoritative Verification: Worker verifies correct OTP on CONFIRMED booking -> 200 OK.
 * 2.  Audit Metadata: verified_at, verified_by, started_at, otp_consumed_at are authoritatively set.
 * 3.  Replay Defense: Consumed OTP cannot be reused (rejected with 400/409).
 * 4.  Expiration Enforcement: Expired OTP rejected with OTP_EXPIRED (400).
 * 5.  State Guard: Verification rejected on IN_PROGRESS booking with OTP_WRONG_STATE (400).
 * 6.  State Guard: Verification rejected on AWAITING_CONFIRMATION booking with OTP_WRONG_STATE (400).
 * 7.  State Guard: Verification rejected on COMPLETED booking with OTP_WRONG_STATE (400).
 * 8.  State Guard: Verification rejected on CANCELLED booking with OTP_WRONG_STATE (400).
 * 9.  State Guard: Wrong-state verification attempts DO NOT burn attempt counters.
 * 10. Attempt Tracking: Invalid OTP returns OTP_INVALID (400) and increments otp_attempts.
 * 11. Lockout Trigger: 5 failed attempts locks OTP challenge with OTP_LOCKED (400).
 * 12. Locked Challenge Immunity: Locked challenge rejects even the correct OTP with OTP_LOCKED (400).
 * 13. Authorization: Non-assigned worker cannot verify OTP (403 Forbidden).
 * 14. Authorization: Customer cannot verify OTP (403 Forbidden).
 * 15. Authorization: Unauthenticated request rejected (401 Unauthorized).
 * 16. Strict Schema: Extra payload properties rejected with 400 Bad Request.
 * 17. Strict Schema: Non-6-digit OTP formats rejected with 400 Bad Request.
 * 18. Strict Schema: Malformed bookingId UUID rejected with 400 Bad Request.
 * 19. Information Disclosure: Booking DTO never leaks otp_hash, otp_attempts, otp_locked_at, otp_consumed_at.
 * 20. Concurrency / Atomicity: Serialized row-locking prevents double consumption and race conditions.
 */

import request from "supertest";
import { Prisma } from "@prisma/client";

// Mock Bull Board & BullMQ
jest.mock("@bull-board/api", () => ({ createBullBoard: jest.fn().mockReturnValue({}) }));
jest.mock("@bull-board/api/bullMQAdapter", () => ({ BullMQAdapter: jest.fn().mockImplementation(() => ({})) }));
jest.mock("@bull-board/express", () => ({
  ExpressAdapter: jest.fn().mockImplementation(() => ({
    setBasePath: jest.fn(),
    getRouter: jest.fn().mockReturnValue((req: any, res: any, next: any) => next()),
  })),
}));

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: jest.fn().mockResolvedValue({}) })),
  Worker: jest.fn().mockImplementation(() => ({ on: jest.fn(), close: jest.fn() })),
}));

jest.mock("../src/config/bullmq", () => ({
  dispatchQueue: { add: jest.fn() },
  timeoutQueue: { add: jest.fn() },
  connection: {},
}));

jest.mock("../src/config/prisma", () => ({
  __esModule: true,
  default: {
    booking: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    job: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    job_requirement: {
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    booking_transition: {
      create: jest.fn(),
    },
    job_transition: {
      create: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));

import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { generateToken, hashOTP } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";
import { BookingStatus, BookingAction } from "../src/features/booking/bookingStateMachine";
import { JobStatus } from "../src/features/jobs/jobStateMachine";
import { bookingConfig } from "../src/config/bookingConfig";

describe("Issue #17 — Harden Booking OTP Verification", () => {
  const customerId = "11111111-1111-4111-a111-111111111111";
  const assignedWorkerId = "22222222-2222-4222-a222-222222222222";
  const otherWorkerId = "33333333-3333-4333-a333-333333333333";
  const bookingId = "44444444-4444-4444-a444-444444444444";
  const jobId = "55555555-5555-4555-a555-555555555555";
  const requirementId = "66666666-6666-4666-a666-666666666666";

  const validOtp = "123456";
  const invalidOtp = "999999";
  let validOtpHash: string;

  let assignedWorkerToken: string;
  let otherWorkerToken: string;
  let customerToken: string;

  beforeAll(async () => {
    validOtpHash = await hashOTP(validOtp);
    assignedWorkerToken = generateToken({ id: assignedWorkerId, role: UserRole.WORKER });
    otherWorkerToken = generateToken({ id: otherWorkerId, role: UserRole.WORKER });
    customerToken = generateToken({ id: customerId, role: UserRole.CUSTOMER });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Helper to build a mock booking state record.
   */
  function buildMockBooking(overrides: Partial<any> = {}) {
    return {
      id: bookingId,
      job_id: jobId,
      requirement_id: requirementId,
      worker_id: assignedWorkerId,
      customer_id: customerId,
      status: BookingStatus.CONFIRMED,
      otp_hash: validOtpHash,
      otp_expires_at: new Date(Date.now() + 86400 * 1000), // +24 hours
      otp_attempts: 0,
      otp_locked_at: null,
      otp_consumed_at: null,
      otp_verified: false,
      verified_at: null,
      verified_by: null,
      started_at: null,
      completion_requested_at: null,
      completed_at: null,
      cancelled_at: null,
      cancelled_by: null,
      cancellation_reason: null,
      confirmed_by: null,
      created_at: new Date(),
      updated_at: new Date(),
      ...overrides,
    };
  }

  /**
   * Wire up prisma.$transaction to run callback with stateful mock.
   */
  function setupStatefulMockBooking(initialBooking: any) {
    let current = { ...initialBooking };

    const txMock = {
      $queryRaw: jest.fn().mockResolvedValue([current]),
      booking: {
        findFirst: jest.fn().mockImplementation(() => Promise.resolve(current)),
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(current)),
        update: jest.fn().mockImplementation((args: any) => {
          current = { ...current, ...args.data };
          return Promise.resolve(current);
        }),
      },
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: jobId, status: JobStatus.BOOKED }),
        update: jest.fn().mockResolvedValue({ id: jobId, status: "IN_PROGRESS" }),
      },
      booking_transition: {
        create: jest.fn().mockResolvedValue({ id: "trans-1" }),
      },
      job_transition: {
        create: jest.fn().mockResolvedValue({ id: "jtrans-1" }),
      },
    };

    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
      return cb(txMock);
    });

    (prisma.booking.findFirst as jest.Mock).mockImplementation(() => Promise.resolve(current));
    (prisma.booking.findUnique as jest.Mock).mockImplementation(() => Promise.resolve(current));

    return { txMock, getCurrent: () => current };
  }

  describe("1. Authoritative OTP Verification & Audit Metadata", () => {
    it("successfully verifies valid OTP on CONFIRMED booking and records audit timestamps", async () => {
      const { getCurrent, txMock } = setupStatefulMockBooking(buildMockBooking());

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/otp/verify`)
        .set("Authorization", `Bearer ${assignedWorkerToken}`)
        .send({ otp: validOtp });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe("OTP verified, job started");

      const updated = getCurrent();
      expect(updated.status).toBe(BookingStatus.IN_PROGRESS);
      expect(updated.otp_verified).toBe(true);
      expect(updated.otp_consumed_at).toBeInstanceOf(Date);
      expect(updated.verified_at).toBeInstanceOf(Date);
      expect(updated.verified_by).toBe(assignedWorkerId);
      expect(updated.started_at).toBeInstanceOf(Date);

      // Verify booking_transition audit log recorded
      expect(txMock.booking_transition.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            booking_id: bookingId,
            from_status: BookingStatus.CONFIRMED,
            to_status: BookingStatus.IN_PROGRESS,
            actor_id: assignedWorkerId,
          }),
        })
      );
    });
  });

  describe("2. Single-Use Consumption & Replay Prevention", () => {
    it("rejects reuse of OTP when otp_consumed_at is already populated", async () => {
      setupStatefulMockBooking(
        buildMockBooking({
          otp_consumed_at: new Date(),
          otp_verified: true,
        })
      );

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/otp/verify`)
        .set("Authorization", `Bearer ${assignedWorkerToken}`)
        .send({ otp: validOtp });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("OTP_ALREADY_USED");
      expect(res.body.message).toContain("already been verified and consumed");
    });
  });

  describe("3. Expiration Enforcement", () => {
    it("rejects expired OTP with OTP_EXPIRED (400) and does not transition status", async () => {
      const expiredBooking = buildMockBooking({
        otp_expires_at: new Date(Date.now() - 3600 * 1000), // 1 hour ago
      });
      const { getCurrent } = setupStatefulMockBooking(expiredBooking);

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/otp/verify`)
        .set("Authorization", `Bearer ${assignedWorkerToken}`)
        .send({ otp: validOtp });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("OTP_EXPIRED");
      expect(res.body.message).toContain("expired");

      // State remains unchanged
      expect(getCurrent().status).toBe(BookingStatus.CONFIRMED);
      expect(getCurrent().otp_verified).toBe(false);
    });
  });

  describe("4. Pre-Verification State Guards", () => {
    it("rejects OTP verification on IN_PROGRESS booking with OTP_WRONG_STATE without incrementing attempts", async () => {
      const { getCurrent, txMock } = setupStatefulMockBooking(
        buildMockBooking({ status: BookingStatus.IN_PROGRESS, otp_attempts: 0 })
      );

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/otp/verify`)
        .set("Authorization", `Bearer ${assignedWorkerToken}`)
        .send({ otp: validOtp });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("OTP_WRONG_STATE");
      expect(getCurrent().otp_attempts).toBe(0);
      expect(txMock.booking.update).not.toHaveBeenCalled();
    });

    it("rejects OTP verification on AWAITING_CONFIRMATION booking with OTP_WRONG_STATE", async () => {
      setupStatefulMockBooking(
        buildMockBooking({ status: BookingStatus.AWAITING_CONFIRMATION })
      );

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/otp/verify`)
        .set("Authorization", `Bearer ${assignedWorkerToken}`)
        .send({ otp: validOtp });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("OTP_WRONG_STATE");
    });

    it("rejects OTP verification on COMPLETED booking with OTP_WRONG_STATE", async () => {
      setupStatefulMockBooking(
        buildMockBooking({ status: BookingStatus.COMPLETED })
      );

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/otp/verify`)
        .set("Authorization", `Bearer ${assignedWorkerToken}`)
        .send({ otp: validOtp });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("OTP_WRONG_STATE");
    });

    it("rejects OTP verification on CANCELLED booking with OTP_WRONG_STATE", async () => {
      setupStatefulMockBooking(
        buildMockBooking({ status: BookingStatus.CANCELLED })
      );

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/otp/verify`)
        .set("Authorization", `Bearer ${assignedWorkerToken}`)
        .send({ otp: validOtp });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("OTP_WRONG_STATE");
    });
  });

  describe("5. Failed Attempt Counter & Brute-Force Lockout", () => {
    it("increments otp_attempts from 0 to 1 on invalid OTP and returns OTP_INVALID (400)", async () => {
      const { getCurrent } = setupStatefulMockBooking(
        buildMockBooking({ otp_attempts: 0 })
      );

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/otp/verify`)
        .set("Authorization", `Bearer ${assignedWorkerToken}`)
        .send({ otp: invalidOtp });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("OTP_INVALID");
      expect(res.body.message).toBe("Invalid OTP");
      expect(getCurrent().otp_attempts).toBe(1);
      expect(getCurrent().otp_locked_at).toBeNull();
    });

    it("triggers lockout when attempt count reaches max allowed (5) and sets otp_locked_at", async () => {
      const { getCurrent } = setupStatefulMockBooking(
        buildMockBooking({ otp_attempts: 4 })
      );

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/otp/verify`)
        .set("Authorization", `Bearer ${assignedWorkerToken}`)
        .send({ otp: invalidOtp });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("OTP_LOCKED");
      expect(res.body.message).toContain("Maximum verification attempts exceeded");
      expect(getCurrent().otp_attempts).toBe(5);
      expect(getCurrent().otp_locked_at).toBeInstanceOf(Date);
    });

    it("locked OTP rejects even the correct OTP with OTP_LOCKED (400)", async () => {
      setupStatefulMockBooking(
        buildMockBooking({
          otp_attempts: 5,
          otp_locked_at: new Date(),
        })
      );

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/otp/verify`)
        .set("Authorization", `Bearer ${assignedWorkerToken}`)
        .send({ otp: validOtp });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("OTP_LOCKED");
      expect(res.body.message).toContain("locked");
    });
  });

  describe("6. Authorization & Policy Enforcement", () => {
    it("rejects non-assigned worker with HTTP 403 Forbidden", async () => {
      const { getCurrent } = setupStatefulMockBooking(buildMockBooking());

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/otp/verify`)
        .set("Authorization", `Bearer ${otherWorkerToken}`)
        .send({ otp: validOtp });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      // Ensure attempts not burned by unauthorized actor
      expect(getCurrent().otp_attempts).toBe(0);
    });

    it("rejects customer role with HTTP 403 Forbidden", async () => {
      setupStatefulMockBooking(buildMockBooking());

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/otp/verify`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ otp: validOtp });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("rejects unauthenticated request with HTTP 401 Unauthorized", async () => {
      const res = await request(app)
        .post(`/api/bookings/${bookingId}/otp/verify`)
        .send({ otp: validOtp });

      expect(res.status).toBe(401);
    });
  });

  describe("7. Strict Schema & Input Validation", () => {
    it("rejects non-numeric OTP with HTTP 400 Bad Request", async () => {
      const res = await request(app)
        .post(`/api/bookings/${bookingId}/otp/verify`)
        .set("Authorization", `Bearer ${assignedWorkerToken}`)
        .send({ otp: "abcdef" });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Validation failed");
      expect(JSON.stringify(res.body.errors)).toContain("OTP must be exactly 6 digits");
    });

    it("rejects 5-digit OTP with HTTP 400 Bad Request", async () => {
      const res = await request(app)
        .post(`/api/bookings/${bookingId}/otp/verify`)
        .set("Authorization", `Bearer ${assignedWorkerToken}`)
        .send({ otp: "12345" });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Validation failed");
      expect(JSON.stringify(res.body.errors)).toContain("OTP must be exactly 6 digits");
    });

    it("rejects 7-digit OTP with HTTP 400 Bad Request", async () => {
      const res = await request(app)
        .post(`/api/bookings/${bookingId}/otp/verify`)
        .set("Authorization", `Bearer ${assignedWorkerToken}`)
        .send({ otp: "1234567" });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Validation failed");
      expect(JSON.stringify(res.body.errors)).toContain("OTP must be exactly 6 digits");
    });

    it("rejects unrecognized payload properties due to strict schema (e.g. worker_id injection)", async () => {
      const res = await request(app)
        .post(`/api/bookings/${bookingId}/otp/verify`)
        .set("Authorization", `Bearer ${assignedWorkerToken}`)
        .send({ otp: "123456", worker_id: otherWorkerId });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Validation failed");
      expect(JSON.stringify(res.body.errors)).toContain("Unrecognized key");
    });

    it("rejects invalid booking UUID with HTTP 400 Bad Request", async () => {
      const res = await request(app)
        .post("/api/bookings/invalid-not-a-uuid/otp/verify")
        .set("Authorization", `Bearer ${assignedWorkerToken}`)
        .send({ otp: "123456" });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Validation failed");
      expect(JSON.stringify(res.body.errors)).toContain("Invalid bookingId format");
    });
  });

  describe("8. Information Disclosure & DTO Safety", () => {
    it("never exposes otp_hash, otp_attempts, otp_locked_at, or otp_consumed_at on GET /api/bookings/:id", async () => {
      const mockBookingWithSecrets = buildMockBooking({
        status: BookingStatus.IN_PROGRESS,
        otp_hash: "$2b$10$supersecretsecretsaltvaluehash",
        otp_attempts: 2,
        otp_locked_at: null,
        otp_consumed_at: new Date(),
        verified_at: new Date(),
        verified_by: assignedWorkerId,
        started_at: new Date(),
      });

      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(mockBookingWithSecrets);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue(mockBookingWithSecrets);

      const res = await request(app)
        .get(`/api/bookings/${bookingId}`)
        .set("Authorization", `Bearer ${assignedWorkerToken}`);

      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data).toBeDefined();

      // Secrets must be absent
      expect(data.otp_hash).toBeUndefined();
      expect(data.otp_attempts).toBeUndefined();
      expect(data.otp_locked_at).toBeUndefined();
      expect(data.otp_consumed_at).toBeUndefined();

      // Safe verification metadata must be present
      expect(data.verified_at).toBeDefined();
      expect(data.verified_by).toBe(assignedWorkerId);
    });
  });

  describe("9. Concurrency & Atomicity Invariants", () => {
    it("simultaneous valid OTP requests: first succeeds, second fails with wrong state or already consumed", async () => {
      let state = buildMockBooking();

      const txMock = {
        $queryRaw: jest.fn().mockImplementation(() => Promise.resolve([state])),
        booking: {
          findFirst: jest.fn().mockImplementation(() => Promise.resolve(state)),
          findUnique: jest.fn().mockImplementation(() => Promise.resolve(state)),
          update: jest.fn().mockImplementation((args: any) => {
            state = { ...state, ...args.data };
            return Promise.resolve(state);
          }),
        },
        job: {
          findUnique: jest.fn().mockResolvedValue({ id: jobId, status: JobStatus.BOOKED }),
          update: jest.fn().mockResolvedValue({ id: jobId, status: "IN_PROGRESS" }),
        },
        booking_transition: {
          create: jest.fn().mockResolvedValue({ id: "trans-seq" }),
        },
        job_transition: {
          create: jest.fn().mockResolvedValue({ id: "jtrans-seq" }),
        },
      };

      // Simulate sequential transactional isolation
      let activeTx = Promise.resolve();
      (prisma.$transaction as jest.Mock).mockImplementation((cb: any) => {
        const next = activeTx.then(() => cb(txMock));
        activeTx = next.catch(() => {});
        return next;
      });

      const [res1, res2] = await Promise.all([
        request(app)
          .post(`/api/bookings/${bookingId}/otp/verify`)
          .set("Authorization", `Bearer ${assignedWorkerToken}`)
          .send({ otp: validOtp }),
        request(app)
          .post(`/api/bookings/${bookingId}/otp/verify`)
          .set("Authorization", `Bearer ${assignedWorkerToken}`)
          .send({ otp: validOtp }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses[0]).toBe(200); // exactly one succeeds
      expect([400, 409]).toContain(statuses[1]); // second fails with wrong state or already consumed
    });

    it("simultaneous invalid OTP requests serialize attempt increments without lost updates", async () => {
      let state = buildMockBooking({ otp_attempts: 0 });

      const txMock = {
        $queryRaw: jest.fn().mockImplementation(() => Promise.resolve([state])),
        booking: {
          findFirst: jest.fn().mockImplementation(() => Promise.resolve(state)),
          findUnique: jest.fn().mockImplementation(() => Promise.resolve(state)),
          update: jest.fn().mockImplementation((args: any) => {
            state = { ...state, ...args.data };
            return Promise.resolve(state);
          }),
        },
        booking_transition: { create: jest.fn() },
      };

      let activeTx = Promise.resolve();
      (prisma.$transaction as jest.Mock).mockImplementation((cb: any) => {
        const next = activeTx.then(() => cb(txMock));
        activeTx = next.catch(() => {});
        return next;
      });

      const results = await Promise.all([
        request(app)
          .post(`/api/bookings/${bookingId}/otp/verify`)
          .set("Authorization", `Bearer ${assignedWorkerToken}`)
          .send({ otp: invalidOtp }),
        request(app)
          .post(`/api/bookings/${bookingId}/otp/verify`)
          .set("Authorization", `Bearer ${assignedWorkerToken}`)
          .send({ otp: invalidOtp }),
      ]);

      expect(results[0].status).toBe(400);
      expect(results[1].status).toBe(400);
      // Both failed attempts accurately reflected
      expect(state.otp_attempts).toBe(2);
    });
  });
});
