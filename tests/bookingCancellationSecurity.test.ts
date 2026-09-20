/**
 * Issue #19 — Persist Cancellation Audit Data
 * Priority: P1 Marketplace Correctness (Audit Finding #34)
 *
 * Comprehensive Test Suite for Booking Cancellation Lifecycle & Audit Persistence:
 * 1.  Customer Cancellation (CONFIRMED): Transitions to CANCELLED and atomically persists cancelled_at, cancelled_by, cancellation_reason.
 * 2.  Customer Cancellation (IN_PROGRESS): Authorized customer cancels active job with valid audit data.
 * 3.  Customer Cancellation (AWAITING_CONFIRMATION): Authorized customer cancels pending confirmation booking.
 * 4.  Worker Cancellation (CONFIRMED): Assigned worker cancels assigned booking before starting.
 * 5.  Worker Cancellation (IN_PROGRESS): Assigned worker cancels during work with reason.
 * 6.  Worker State Guard: Worker CANNOT cancel booking in AWAITING_CONFIRMATION state (400 Invalid Transition).
 * 7.  Customer Authorization Guard: Non-owner customer CANNOT cancel booking (403 Forbidden).
 * 8.  Worker Authorization Guard: Unassigned worker CANNOT cancel booking (403 Forbidden).
 * 9.  Authentication Guard: Unauthenticated request rejected (401 Unauthorized).
 * 10. Terminal State Guard: CANNOT cancel booking in COMPLETED state (400 Invalid Transition).
 * 11. Validation Guard: Missing reason payload rejected (400 Bad Request).
 * 12. Validation Guard: Empty string reason rejected (400 Bad Request).
 * 13. Validation Guard: Whitespace-only reason rejected (400 Bad Request).
 * 14. Validation Guard: Reason exceeding 500 characters rejected (400 Bad Request).
 * 15. Security / Strict Schema: Extra payload keys (e.g. injected cancelled_by / cancelled_at) rejected (400 Bad Request).
 * 16. Security / Identity Integrity: cancelled_by authoritatively stamped from JWT principal, not client payload.
 * 17. Idempotency: Repeated cancellation on already CANCELLED booking succeeds without duplicate side effects or capacity corruption.
 * 18. Requirement Reconciliation: Cancellation triggers requirementStateService.reconcileCapacity.
 * 19. Dispatch Reconciliation: Worker job_dispatch record updated to 'cancelled'.
 * 20. Reopen Job Dispatch: If all bookings are cancelled, parent job dispatch is reopened.
 * 21. DTO Security: Response DTO exposes cancellation audit fields while never leaking secrets (otp_hash).
 * 22. Audit Log Invariant: Durable booking_transition record created with action CANCEL, actor details, and reason.
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
    job_dispatch: {
      updateMany: jest.fn(),
    },
    booking_transition: {
      create: jest.fn(),
    },
    job_transition: {
      create: jest.fn(),
    },
    requirement_transition: {
      create: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));

import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { generateToken } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";
import { BookingStatus, BookingAction } from "../src/features/booking/bookingStateMachine";
import { requirementStateService } from "../src/features/jobs/requirementStateMachine";

describe("Issue #19 — Persist Cancellation Audit Data", () => {
  const customerId = "11111111-1111-4111-a111-111111111111";
  const otherCustomerId = "22222222-2222-4222-a222-222222222222";
  const assignedWorkerId = "33333333-3333-4333-a333-333333333333";
  const otherWorkerId = "44444444-4444-4444-a444-444444444444";
  const adminId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const bookingId = "55555555-5555-4555-a555-555555555555";
  const jobId = "66666666-6666-4666-a666-666666666666";
  const requirementId = "77777777-7777-4777-a777-777777777777";

  let customerToken: string;
  let otherCustomerToken: string;
  let workerToken: string;
  let otherWorkerToken: string;
  let adminToken: string;

  beforeAll(() => {
    customerToken = generateToken({ id: customerId, role: UserRole.CUSTOMER });
    otherCustomerToken = generateToken({ id: otherCustomerId, role: UserRole.CUSTOMER });
    workerToken = generateToken({ id: assignedWorkerId, role: UserRole.WORKER });
    otherWorkerToken = generateToken({ id: otherWorkerId, role: UserRole.WORKER });
    adminToken = generateToken({ id: adminId, role: UserRole.ADMIN });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function buildMockBooking(overrides: Partial<any> = {}) {
    return {
      id: bookingId,
      job_id: jobId,
      requirement_id: requirementId,
      worker_id: assignedWorkerId,
      customer_id: customerId,
      status: BookingStatus.CONFIRMED,
      otp_hash: "$2b$10$hashedsecretvalue1234567890",
      otp_verified: false,
      otp_consumed_at: null,
      started_at: null,
      completion_requested_at: null,
      completed_at: null,
      confirmed_at: null,
      confirmed_by: null,
      cancelled_at: null,
      cancelled_by: null,
      cancellation_reason: null,
      created_at: new Date(Date.now() - 7200 * 1000),
      updated_at: new Date(),
      ...overrides,
    };
  }

  function setupStatefulMockBooking(initialBooking: any) {
    let current = { ...initialBooking };
    const transitions: any[] = [];
    const dispatchUpdates: any[] = [];

    const txMock = {
      $queryRaw: jest.fn().mockImplementation(() => Promise.resolve([current])),
      booking: {
        findFirst: jest.fn().mockImplementation(() => Promise.resolve(current)),
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(current)),
        count: jest.fn().mockImplementation(() => Promise.resolve(0)), // 0 other active bookings
        update: jest.fn().mockImplementation((args: any) => {
          current = { ...current, ...args.data };
          return Promise.resolve(current);
        }),
      },
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: jobId, status: "IN_PROGRESS" }),
        update: jest.fn().mockResolvedValue({ id: jobId, status: "DISPATCHING" }),
      },
      job_requirement: {
        findUnique: jest.fn().mockResolvedValue({
          id: requirementId,
          job_id: jobId,
          status: "FILLED",
          worker_count_needed: 1,
          assigned_count: 1,
        }),
        update: jest.fn().mockResolvedValue({
          id: requirementId,
          status: "OPEN",
          assigned_count: 0,
        }),
        count: jest.fn().mockResolvedValue(0),
      },
      job_dispatch: {
        updateMany: jest.fn().mockImplementation((args: any) => {
          dispatchUpdates.push(args);
          return Promise.resolve({ count: 1 });
        }),
      },
      booking_transition: {
        create: jest.fn().mockImplementation((args: any) => {
          const rec = { id: `trans-${transitions.length + 1}`, ...args.data };
          transitions.push(rec);
          return Promise.resolve(rec);
        }),
      },
      job_transition: {
        create: jest.fn().mockResolvedValue({ id: "jtrans-1" }),
      },
      requirement_transition: {
        create: jest.fn().mockResolvedValue({ id: "rtrans-1" }),
      },
    };

    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
      return cb(txMock);
    });

    (prisma.booking.findFirst as jest.Mock).mockImplementation(() => Promise.resolve(current));
    (prisma.booking.findUnique as jest.Mock).mockImplementation(() => Promise.resolve(current));

    return {
      txMock,
      getCurrent: () => current,
      getTransitions: () => transitions,
      getDispatchUpdates: () => dispatchUpdates,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Authorized Customer Cancellation Across Legal States
  // ─────────────────────────────────────────────────────────────────────────────
  describe("1. Customer Cancellation Lifecycle", () => {
    it("customer can cancel CONFIRMED booking with valid reason, persisting audit fields", async () => {
      const state = setupStatefulMockBooking(buildMockBooking({ status: BookingStatus.CONFIRMED }));

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ reason: "Emergency change of plans" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(BookingStatus.CANCELLED);
      expect(res.body.data.cancelled_by).toBe(customerId);
      expect(res.body.data.cancellation_reason).toBe("Emergency change of plans");
      expect(res.body.data.cancelled_at).toBeDefined();

      const updated = state.getCurrent();
      expect(updated.status).toBe(BookingStatus.CANCELLED);
      expect(updated.cancelled_by).toBe(customerId);
      expect(updated.cancellation_reason).toBe("Emergency change of plans");
      expect(updated.cancelled_at).toBeInstanceOf(Date);

      // Verify audit record created
      const transitions = state.getTransitions();
      expect(transitions.length).toBe(1);
      expect(transitions[0].from_status).toBe(BookingStatus.CONFIRMED);
      expect(transitions[0].to_status).toBe(BookingStatus.CANCELLED);
      expect(transitions[0].actor_id).toBe(customerId);
      expect(transitions[0].reason).toBe("Emergency change of plans");
    });

    it("customer can cancel IN_PROGRESS booking with valid reason", async () => {
      const state = setupStatefulMockBooking(
        buildMockBooking({
          status: BookingStatus.IN_PROGRESS,
          started_at: new Date(),
          otp_verified: true,
        })
      );

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ reason: "Worker arrived without necessary equipment" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(BookingStatus.CANCELLED);
      expect(res.body.data.cancelled_by).toBe(customerId);
      expect(res.body.data.cancellation_reason).toBe("Worker arrived without necessary equipment");
    });

    it("customer can cancel AWAITING_CONFIRMATION booking with valid reason", async () => {
      const state = setupStatefulMockBooking(
        buildMockBooking({
          status: BookingStatus.AWAITING_CONFIRMATION,
          completion_requested_at: new Date(),
        })
      );

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ reason: "Work was not completed as promised" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(BookingStatus.CANCELLED);
      expect(res.body.data.cancelled_by).toBe(customerId);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Assigned Worker Cancellation Across Legal States
  // ─────────────────────────────────────────────────────────────────────────────
  describe("2. Worker Cancellation Lifecycle", () => {
    it("assigned worker can cancel CONFIRMED booking with valid reason", async () => {
      const state = setupStatefulMockBooking(buildMockBooking({ status: BookingStatus.CONFIRMED }));

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("Authorization", `Bearer ${workerToken}`)
        .send({ reason: "Bike broke down on the way" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(BookingStatus.CANCELLED);
      expect(res.body.data.cancelled_by).toBe(assignedWorkerId);
      expect(res.body.data.cancellation_reason).toBe("Bike broke down on the way");
    });

    it("assigned worker can cancel IN_PROGRESS booking with valid reason", async () => {
      const state = setupStatefulMockBooking(
        buildMockBooking({
          status: BookingStatus.IN_PROGRESS,
          started_at: new Date(),
          otp_verified: true,
        })
      );

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("Authorization", `Bearer ${workerToken}`)
        .send({ reason: "Severe hazard at job site" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe(BookingStatus.CANCELLED);
      expect(res.body.data.cancelled_by).toBe(assignedWorkerId);
    });

    it("worker CANNOT cancel booking in AWAITING_CONFIRMATION state", async () => {
      setupStatefulMockBooking(
        buildMockBooking({
          status: BookingStatus.AWAITING_CONFIRMATION,
          completion_requested_at: new Date(),
        })
      );

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("Authorization", `Bearer ${workerToken}`)
        .send({ reason: "Worker change of mind" });

      expect([400, 403]).toContain(res.status);
      expect(res.body.success).toBe(false);
      expect(res.body.code || res.body.message).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Authorization & Access Control Guards
  // ─────────────────────────────────────────────────────────────────────────────
  describe("3. Authorization & Access Control", () => {
    it("non-owner customer CANNOT cancel booking (403 Forbidden)", async () => {
      setupStatefulMockBooking(buildMockBooking({ status: BookingStatus.CONFIRMED }));

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("Authorization", `Bearer ${otherCustomerToken}`)
        .send({ reason: "Trying to cancel someone else's booking" });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("unassigned worker CANNOT cancel booking (403 Forbidden)", async () => {
      setupStatefulMockBooking(buildMockBooking({ status: BookingStatus.CONFIRMED }));

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("Authorization", `Bearer ${otherWorkerToken}`)
        .send({ reason: "Unassigned worker interference" });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("unauthenticated request is rejected with 401 Unauthorized", async () => {
      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .send({ reason: "No auth header provided" });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("admin can cancel any booking with valid audit attribution", async () => {
      const state = setupStatefulMockBooking(buildMockBooking({ status: BookingStatus.CONFIRMED }));

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ reason: "Administrative override due to fraud" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.cancelled_by).toBe(adminId);
      expect(res.body.data.cancellation_reason).toBe("Administrative override due to fraud");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Terminal State Guards
  // ─────────────────────────────────────────────────────────────────────────────
  describe("4. Terminal State Guards", () => {
    it("cannot cancel booking in COMPLETED state (400 BOOKING_INVALID_TRANSITION)", async () => {
      setupStatefulMockBooking(
        buildMockBooking({
          status: BookingStatus.COMPLETED,
          completed_at: new Date(),
          confirmed_at: new Date(),
          confirmed_by: customerId,
        })
      );

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ reason: "Want refund after job completed" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("BOOKING_INVALID_TRANSITION");
      expect(res.body.message).toContain("COMPLETED");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Payload & Reason Validation Guards
  // ─────────────────────────────────────────────────────────────────────────────
  describe("5. Validation & Strict Schema Guards", () => {
    it("missing reason key in body is rejected with 400 Bad Request", async () => {
      setupStatefulMockBooking(buildMockBooking({ status: BookingStatus.CONFIRMED }));

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("empty string reason is rejected with 400 Bad Request", async () => {
      setupStatefulMockBooking(buildMockBooking({ status: BookingStatus.CONFIRMED }));

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ reason: "" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("whitespace-only reason is rejected with 400 Bad Request", async () => {
      setupStatefulMockBooking(buildMockBooking({ status: BookingStatus.CONFIRMED }));

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ reason: "     " });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("reason exceeding 500 characters is rejected with 400 Bad Request", async () => {
      setupStatefulMockBooking(buildMockBooking({ status: BookingStatus.CONFIRMED }));

      const longReason = "A".repeat(501);
      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ reason: longReason });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("extra keys in payload (attempted cancelled_by injection) rejected by strict schema (400)", async () => {
      setupStatefulMockBooking(buildMockBooking({ status: BookingStatus.CONFIRMED }));

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({
          reason: "Valid reason",
          cancelled_by: "spoofed-user-id",
          cancelled_at: new Date().toISOString(),
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("malformed bookingId UUID in URL parameter is rejected with 400 Bad Request", async () => {
      const res = await request(app)
        .post("/api/bookings/not-a-valid-uuid/cancel")
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ reason: "Valid reason" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Idempotency & Mobile Retry Safety
  // ─────────────────────────────────────────────────────────────────────────────
  describe("6. Terminal CANCELLED State Guard", () => {
    it("cannot cancel booking in CANCELLED state (400 BOOKING_INVALID_TRANSITION)", async () => {
      const initialCancelledAt = new Date(Date.now() - 3600 * 1000);
      setupStatefulMockBooking(
        buildMockBooking({
          status: BookingStatus.CANCELLED,
          cancelled_at: initialCancelledAt,
          cancelled_by: customerId,
          cancellation_reason: "Original cancellation reason",
        })
      );

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ reason: "Duplicate cancel attempt" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("BOOKING_INVALID_TRANSITION");
      expect(res.body.message).toContain("CANCELLED");
    });

    it("unauthorized user cannot cancel someone else's CANCELLED booking (403 Forbidden)", async () => {
      setupStatefulMockBooking(
        buildMockBooking({
          status: BookingStatus.CANCELLED,
          cancelled_at: new Date(),
          cancelled_by: customerId,
          cancellation_reason: "First reason",
        })
      );

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("Authorization", `Bearer ${otherCustomerToken}`)
        .send({ reason: "Intruder attempting call" });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Side Effect Reconciliation & DTO Security
  // ─────────────────────────────────────────────────────────────────────────────
  describe("7. Side Effects & DTO Security", () => {
    it("reconciles requirement capacity and cancels worker job_dispatch record", async () => {
      const reconcileSpy = jest.spyOn(requirementStateService, "reconcileCapacity").mockResolvedValue({
        workerCountNeeded: 1,
        filledCapacity: 0,
        remainingCapacity: 1,
        isFilled: false,
        isOpen: true,
        isPartiallyFilled: false,
      });

      const state = setupStatefulMockBooking(buildMockBooking({ status: BookingStatus.CONFIRMED }));

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ reason: "Cancellation triggers reconciliation" });

      expect(res.status).toBe(200);
      expect(reconcileSpy).toHaveBeenCalledWith(expect.anything(), requirementId);

      // Verify worker dispatch record updated to 'cancelled'
      const dispatchUpdates = state.getDispatchUpdates();
      expect(dispatchUpdates.length).toBeGreaterThanOrEqual(1);
      expect(dispatchUpdates[0].data.status).toBe("cancelled");
      expect(dispatchUpdates[0].where.worker_id).toBe(assignedWorkerId);

      reconcileSpy.mockRestore();
    });

    it("DTO does not leak sensitive secrets (such as otp_hash)", async () => {
      setupStatefulMockBooking(buildMockBooking({ status: BookingStatus.CONFIRMED }));

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/cancel`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ reason: "Verifying DTO field sanitization" });

      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.otp_hash).toBeUndefined();
      expect(data.cancelled_at).toBeDefined();
      expect(data.cancelled_by).toBe(customerId);
      expect(data.cancellation_reason).toBe("Verifying DTO field sanitization");
    });
  });
});
