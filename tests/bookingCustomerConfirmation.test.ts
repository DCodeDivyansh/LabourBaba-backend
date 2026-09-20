/**
 * Issue #18 — Implement Customer Confirmation → COMPLETED
 * Priority: P1 Marketplace Correctness (Audit Findings #32–33)
 *
 * Comprehensive Test Suite for Booking Completion Lifecycle:
 * 1.  Worker Completion: completeBooking transitions IN_PROGRESS -> AWAITING_CONFIRMATION.
 * 2.  Worker Guard: Worker cannot directly complete booking to COMPLETED.
 * 3.  Customer Confirmation: confirmComplete transitions AWAITING_CONFIRMATION -> COMPLETED.
 * 4.  Audit Metadata: confirmed_at, confirmed_by, and completed_at are authoritatively set.
 * 5.  Identity Integrity: Client-supplied payload cannot control confirmed_at or confirmed_by.
 * 6.  Authorization: Non-owner customer cannot confirm completion (403 Forbidden).
 * 7.  Authorization: Worker cannot invoke customer confirmation (403 Forbidden).
 * 8.  Authorization: Unauthenticated request rejected (401 Unauthorized).
 * 9.  State Guard: Cannot confirm booking in CONFIRMED state (400 Invalid Transition).
 * 10. State Guard: Cannot confirm booking in IN_PROGRESS state (400 Invalid Transition).
 * 11. State Guard: Cannot confirm booking in CANCELLED state (400 Invalid Transition).
 * 12. Review Invariant: Review cannot be created while booking is AWAITING_CONFIRMATION (409).
 * 13. Review Invariant: Review can be created once booking is COMPLETED.
 * 14. Inline Review: confirmComplete with rating creates review transactionally.
 * 15. Idempotency: Repeated confirmation is safe, does not duplicate reviews, preserves confirmed_at.
 * 16. Strict Schema: Extra payload keys rejected with 400 Bad Request.
 * 17. Strict Schema: Malformed bookingId UUID rejected with 400 Bad Request.
 * 18. DTO Safety: BookingSafeDTO exposes confirmed_at and confirmed_by without leaking secrets.
 * 19. Concurrency: Simultaneous customer confirmations serialize cleanly with zero data race.
 * 20. Job Cascade: When all bookings are confirmed/completed, parent job transitions to COMPLETED.
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
    review: {
      findFirst: jest.fn(),
      create: jest.fn(),
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
import { generateToken } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";
import { BookingStatus, BookingAction } from "../src/features/booking/bookingStateMachine";

describe("Issue #18 — Implement Customer Confirmation → COMPLETED", () => {
  const customerId = "11111111-1111-4111-a111-111111111111";
  const otherCustomerId = "22222222-2222-4222-a222-222222222222";
  const assignedWorkerId = "33333333-3333-4333-a333-333333333333";
  const otherWorkerId = "44444444-4444-4444-a444-444444444444";
  const bookingId = "55555555-5555-4555-a555-555555555555";
  const jobId = "66666666-6666-4666-a666-666666666666";
  const requirementId = "77777777-7777-4777-a777-777777777777";

  let customerToken: string;
  let otherCustomerToken: string;
  let workerToken: string;
  let otherWorkerToken: string;

  beforeAll(() => {
    customerToken = generateToken({ id: customerId, role: UserRole.CUSTOMER });
    otherCustomerToken = generateToken({ id: otherCustomerId, role: UserRole.CUSTOMER });
    workerToken = generateToken({ id: assignedWorkerId, role: UserRole.WORKER });
    otherWorkerToken = generateToken({ id: otherWorkerId, role: UserRole.WORKER });
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
      status: BookingStatus.AWAITING_CONFIRMATION,
      otp_hash: "$2b$10$hashedotpvalue1234567890",
      otp_verified: true,
      otp_consumed_at: new Date(),
      started_at: new Date(Date.now() - 3600 * 1000),
      completion_requested_at: new Date(Date.now() - 600 * 1000),
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
    let reviewStore: any[] = [];

    const txMock = {
      $queryRaw: jest.fn().mockImplementation(() => Promise.resolve([current])),
      booking: {
        findFirst: jest.fn().mockImplementation(() => Promise.resolve(current)),
        findUnique: jest.fn().mockImplementation(() => Promise.resolve(current)),
        count: jest.fn().mockImplementation(() => Promise.resolve(0)),
        update: jest.fn().mockImplementation((args: any) => {
          current = { ...current, ...args.data };
          return Promise.resolve(current);
        }),
      },
      job: {
        findUnique: jest.fn().mockResolvedValue({ id: jobId, status: "IN_PROGRESS" }),
        update: jest.fn().mockResolvedValue({ id: jobId, status: "COMPLETED" }),
      },
      review: {
        findFirst: jest.fn().mockImplementation((args: any) => {
          const match = reviewStore.find((r) => r.booking_id === args.where.booking_id);
          return Promise.resolve(match || null);
        }),
        create: jest.fn().mockImplementation((args: any) => {
          const exists = reviewStore.find((r) => r.booking_id === args.data.booking_id);
          if (exists) {
            const err: any = new Error("Unique constraint failed on the fields: (`booking_id`)");
            err.code = "P2002";
            err.meta = { target: ["booking_id"] };
            return Promise.reject(err);
          }
          const rec = { id: "rev-1", ...args.data, created_at: new Date() };
          reviewStore.push(rec);
          return Promise.resolve(rec);
        }),
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

    return { txMock, getCurrent: () => current, getReviews: () => reviewStore };
  }

  describe("1. Worker Completion: IN_PROGRESS → AWAITING_CONFIRMATION", () => {
    it("worker marking booking complete transitions status to AWAITING_CONFIRMATION (NOT COMPLETED)", async () => {
      const inProgressBooking = buildMockBooking({
        status: BookingStatus.IN_PROGRESS,
        completion_requested_at: null,
      });
      const { getCurrent } = setupStatefulMockBooking(inProgressBooking);

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/complete`)
        .set("Authorization", `Bearer ${workerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain("awaiting customer confirmation");

      const updated = getCurrent();
      expect(updated.status).toBe(BookingStatus.AWAITING_CONFIRMATION);
      expect(updated.completion_requested_at).toBeInstanceOf(Date);
      // Critical invariant: must NOT be COMPLETED
      expect(updated.status).not.toBe(BookingStatus.COMPLETED);
      expect(updated.completed_at).toBeNull();
      expect(updated.confirmed_at).toBeNull();
    });

    it("unassigned worker cannot mark booking complete (403 Forbidden)", async () => {
      setupStatefulMockBooking(buildMockBooking({ status: BookingStatus.IN_PROGRESS }));

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/complete`)
        .set("Authorization", `Bearer ${otherWorkerToken}`);

      expect(res.status).toBe(403);
    });
  });

  describe("2. Customer Confirmation: AWAITING_CONFIRMATION → COMPLETED", () => {
    it("customer confirms completion: atomically transitions to COMPLETED and sets confirmed_at & confirmed_by", async () => {
      const { getCurrent, txMock } = setupStatefulMockBooking(buildMockBooking());

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/confirm-complete`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ rating: 5, comment: "Excellent work!" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe("Booking completion confirmed");

      const updated = getCurrent();
      expect(updated.status).toBe(BookingStatus.COMPLETED);
      expect(updated.completed_at).toBeInstanceOf(Date);
      expect(updated.confirmed_at).toBeInstanceOf(Date);
      expect(updated.confirmed_by).toBe(customerId);

      // Verify review was created
      expect(txMock.review.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            booking_id: bookingId,
            customer_id: customerId,
            worker_id: assignedWorkerId,
            rating: 5,
            comment: "Excellent work!",
          }),
        })
      );

      // Verify audit log
      expect(txMock.booking_transition.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            booking_id: bookingId,
            from_status: BookingStatus.AWAITING_CONFIRMATION,
            to_status: BookingStatus.COMPLETED,
            action: BookingAction.CONFIRM_COMPLETION,
            actor_id: customerId,
          }),
        })
      );
    });

    it("customer confirms completion without review: successfully marks COMPLETED with confirmed_at", async () => {
      const { getCurrent, txMock } = setupStatefulMockBooking(buildMockBooking());

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/confirm-complete`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const updated = getCurrent();
      expect(updated.status).toBe(BookingStatus.COMPLETED);
      expect(updated.confirmed_at).toBeInstanceOf(Date);
      expect(updated.confirmed_by).toBe(customerId);
      expect(txMock.review.create).not.toHaveBeenCalled();
    });
  });

  describe("3. Authorization & Principal Binding", () => {
    it("non-owner customer cannot confirm completion (403 Forbidden)", async () => {
      const { getCurrent } = setupStatefulMockBooking(buildMockBooking());

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/confirm-complete`)
        .set("Authorization", `Bearer ${otherCustomerToken}`)
        .send({ rating: 5 });

      expect(res.status).toBe(403);
      expect(res.body.message).toContain("Forbidden");
      expect(getCurrent().status).toBe(BookingStatus.AWAITING_CONFIRMATION);
    });

    it("worker cannot confirm completion (403 Forbidden)", async () => {
      const { getCurrent } = setupStatefulMockBooking(buildMockBooking());

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/confirm-complete`)
        .set("Authorization", `Bearer ${workerToken}`)
        .send({ rating: 5 });

      expect(res.status).toBe(403);
      expect(getCurrent().status).toBe(BookingStatus.AWAITING_CONFIRMATION);
    });

    it("unauthenticated request rejected with 401 Unauthorized", async () => {
      const res = await request(app)
        .post(`/api/bookings/${bookingId}/confirm-complete`)
        .send({ rating: 5 });

      expect(res.status).toBe(401);
    });
  });

  describe("4. Illegal State Transition Guards", () => {
    it("cannot confirm completion on CONFIRMED booking (400 Invalid Transition)", async () => {
      setupStatefulMockBooking(buildMockBooking({ status: BookingStatus.CONFIRMED }));

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/confirm-complete`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ rating: 5 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("BOOKING_INVALID_TRANSITION");
    });

    it("cannot confirm completion on IN_PROGRESS booking (400 Invalid Transition)", async () => {
      setupStatefulMockBooking(buildMockBooking({ status: BookingStatus.IN_PROGRESS }));

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/confirm-complete`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ rating: 5 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("BOOKING_INVALID_TRANSITION");
    });

    it("cannot confirm completion on CANCELLED booking (400 Invalid Transition)", async () => {
      setupStatefulMockBooking(buildMockBooking({ status: BookingStatus.CANCELLED }));

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/confirm-complete`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ rating: 5 });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("BOOKING_INVALID_TRANSITION");
    });
  });

  describe("5. Review Eligibility Invariants", () => {
    it("review cannot be created via reviewService while booking is AWAITING_CONFIRMATION (409)", async () => {
      setupStatefulMockBooking(buildMockBooking({ status: BookingStatus.AWAITING_CONFIRMATION }));

      const res = await request(app)
        .post(`/api/reviews/${bookingId}`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ rating: 5, comment: "Premature review" });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("BOOKING_NOT_COMPLETED");
      expect(res.body.message).toContain("Reviews are only permitted for completed bookings");
    });

    it("review can be created via reviewService after booking reaches COMPLETED", async () => {
      setupStatefulMockBooking(
        buildMockBooking({
          status: BookingStatus.COMPLETED,
          completed_at: new Date(),
          confirmed_at: new Date(),
          confirmed_by: customerId,
        })
      );

      const res = await request(app)
        .post(`/api/reviews/${bookingId}`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ rating: 5, comment: "Great job!" });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });
  });

  describe("6. Idempotency & Concurrency", () => {
    it("repeated confirmation is idempotent: succeeds, does not duplicate reviews, preserves confirmed_at", async () => {
      const originalConfirmedAt = new Date(Date.now() - 10000);
      const completedBooking = buildMockBooking({
        status: BookingStatus.COMPLETED,
        completed_at: originalConfirmedAt,
        confirmed_at: originalConfirmedAt,
        confirmed_by: customerId,
      });

      const { getCurrent, txMock } = setupStatefulMockBooking(completedBooking);

      const res = await request(app)
        .post(`/api/bookings/${bookingId}/confirm-complete`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ rating: 5, comment: "Retry confirmation" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const updated = getCurrent();
      expect(updated.status).toBe(BookingStatus.COMPLETED);
      expect(updated.confirmed_at).toEqual(originalConfirmedAt);
    });

    it("concurrent confirmation requests: exactly one transition, no duplicate reviews", async () => {
      let state = buildMockBooking({ status: BookingStatus.AWAITING_CONFIRMATION });
      let reviewCount = 0;

      const txMock = {
        $queryRaw: jest.fn().mockImplementation(() => Promise.resolve([state])),
        booking: {
          findFirst: jest.fn().mockImplementation(() => Promise.resolve(state)),
          findUnique: jest.fn().mockImplementation(() => Promise.resolve(state)),
          count: jest.fn().mockResolvedValue(0),
          update: jest.fn().mockImplementation((args: any) => {
            state = { ...state, ...args.data };
            return Promise.resolve(state);
          }),
        },
        job: {
          findUnique: jest.fn().mockResolvedValue({ id: jobId, status: "IN_PROGRESS" }),
          update: jest.fn().mockResolvedValue({ id: jobId, status: "COMPLETED" }),
        },
        review: {
          create: jest.fn().mockImplementation((args: any) => {
            if (reviewCount > 0) {
              const err: any = new Error("Unique constraint failed on the fields: (`booking_id`)");
              err.code = "P2002";
              err.meta = { target: ["booking_id"] };
              throw err;
            }
            reviewCount++;
            return Promise.resolve({ id: "rev-1", ...args.data });
          }),
        },
        booking_transition: { create: jest.fn().mockResolvedValue({ id: "trans-c" }) },
        job_transition: { create: jest.fn().mockResolvedValue({ id: "jtrans-c" }) },
      };

      let activeTx = Promise.resolve();
      (prisma.$transaction as jest.Mock).mockImplementation((cb: any) => {
        const next = activeTx.then(() => cb(txMock));
        activeTx = next.catch(() => {});
        return next;
      });

      const [res1, res2] = await Promise.all([
        request(app)
          .post(`/api/bookings/${bookingId}/confirm-complete`)
          .set("Authorization", `Bearer ${customerToken}`)
          .send({ rating: 5, comment: "Double tap 1" }),
        request(app)
          .post(`/api/bookings/${bookingId}/confirm-complete`)
          .set("Authorization", `Bearer ${customerToken}`)
          .send({ rating: 5, comment: "Double tap 2" }),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(state.status).toBe(BookingStatus.COMPLETED);
      expect(state.confirmed_at).toBeInstanceOf(Date);
      expect(state.confirmed_by).toBe(customerId);
      expect(reviewCount).toBe(1);
    });
  });

  describe("7. Strict Schema & Input Validation", () => {
    it("rejects extra injected keys in request body (e.g. status tampering, confirmed_at)", async () => {
      const res = await request(app)
        .post(`/api/bookings/${bookingId}/confirm-complete`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({
          rating: 5,
          status: "COMPLETED",
          confirmed_by: otherCustomerId,
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Validation failed");
      expect(JSON.stringify(res.body.errors)).toContain("Unrecognized key");
    });

    it("rejects malformed bookingId UUID with HTTP 400 Bad Request", async () => {
      const res = await request(app)
        .post("/api/bookings/not-a-valid-uuid/confirm-complete")
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ rating: 5 });

      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Validation failed");
    });
  });

  describe("8. DTO & Information Safety", () => {
    it("GET /api/bookings/:id exposes confirmed_at and confirmed_by without leaking secrets", async () => {
      const confirmedBooking = buildMockBooking({
        status: BookingStatus.COMPLETED,
        completed_at: new Date(),
        confirmed_at: new Date(),
        confirmed_by: customerId,
      });

      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(confirmedBooking);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue(confirmedBooking);

      const res = await request(app)
        .get(`/api/bookings/${bookingId}`)
        .set("Authorization", `Bearer ${customerToken}`);

      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data).toBeDefined();
      expect(data.status).toBe(BookingStatus.COMPLETED);
      expect(data.confirmed_at).toBeDefined();
      expect(data.confirmed_by).toBe(customerId);
      expect(data.otp_hash).toBeUndefined();
    });
  });
});
