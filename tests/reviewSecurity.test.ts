/**
 * Issue #1 Security & Authorization Test Suite: Review Identity Remediation
 *
 * Core Security Invariants:
 * 1. Authorship: Only the authenticated customer (via JWT req.user.id) can author a review.
 * 2. Client-Supplied Identity Neutralization: customer_id, worker_id, booking_id in request body
 *    are rejected via strict Zod schema validation and never determine authorship.
 * 3. Booking Ownership: Scoped lookup ensures Customer A cannot review Customer B's booking (403/404).
 * 4. Role Authorization: Only CUSTOMER role is permitted; WORKER and ADMIN roles are rejected with 403.
 * 5. Lifecycle Validation: Only bookings in terminal 'COMPLETED' state can be reviewed; PENDING,
 *    IN_PROGRESS, and CANCELLED states return 409 conflict.
 * 6. Database-Backed Uniqueness: Exactly one review per booking is enforced via DB unique constraint
 *    and application P2002 handling. Unrelated P2002 errors are never swallowed.
 * 7. Concurrency & Replay: Concurrent duplicate review creation results in exactly 1 review; the racing
 *    request receives a safe 409.
 * 8. Malformed Route Parameters: Non-UUID booking IDs return 400 validation error without raw DB errors.
 * 9. confirmComplete() Lifecycle: Repeated confirmation is idempotent; non-completed reviews are rejected;
 *    unrelated errors in confirmComplete() are rethrown.
 */

import request from "supertest";
import { Prisma } from "@prisma/client";

// Mock Bull Board to prevent queue adapter validation failures during test server startup
jest.mock("@bull-board/api", () => ({
  createBullBoard: jest.fn().mockReturnValue({}),
}));
jest.mock("@bull-board/api/bullMQAdapter", () => ({
  BullMQAdapter: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("@bull-board/express", () => ({
  ExpressAdapter: jest.fn().mockImplementation(() => ({
    setBasePath: jest.fn(),
    getRouter: jest.fn().mockReturnValue((req: any, res: any, next: any) => next()),
  })),
}));

// Mock the bullmq module itself to avoid Redis connection attempts
jest.mock("bullmq", () => {
  return {
    Queue: jest.fn().mockImplementation(() => ({
      add: jest.fn().mockResolvedValue({}),
    })),
    Worker: jest.fn().mockImplementation(() => ({
      on: jest.fn(),
      close: jest.fn(),
    })),
  };
});

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
    },
    review: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
  },
}));

import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { generateToken } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";
import { reviewService, isReviewUniqueConstraintError, ReviewError } from "../src/features/review/reviewServices";
import { bookingService } from "../src/features/booking/bookingServices";

describe("Issue #1 — Review Identity Security & Invariant Suite", () => {
  const CUSTOMER_A_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const CUSTOMER_B_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  const WORKER_ID = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
  const ADMIN_ID = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
  const BOOKING_A_ID = "11111111-1111-4111-a111-111111111111";
  const BOOKING_B_ID = "22222222-2222-4222-a222-222222222222";

  let customerAToken: string;
  let customerBToken: string;
  let workerToken: string;
  let adminToken: string;

  beforeAll(() => {
    customerAToken = generateToken({ id: CUSTOMER_A_ID, phone: "+919876543210", role: UserRole.CUSTOMER });
    customerBToken = generateToken({ id: CUSTOMER_B_ID, phone: "+919876543211", role: UserRole.CUSTOMER });
    workerToken = generateToken({ id: WORKER_ID, phone: "+919999999999", role: UserRole.WORKER });
    adminToken = generateToken({ id: ADMIN_ID, phone: "+918888888888", role: UserRole.ADMIN });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // T1 — Customer Can Review Own Completed Booking
  // ==========================================================================
  describe("T1: Customer Can Review Own Completed Booking", () => {
    it("MUST successfully create review with author derived from authenticated principal", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_ID,
        status: "COMPLETED",
      });
      (prisma.review.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.review.create as jest.Mock).mockImplementation(({ data }) =>
        Promise.resolve({
          id: "review-uuid-1",
          ...data,
        })
      );

      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({
          rating: 4.5,
          comment: "Excellent carpentry work, completed promptly!",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.customer_id).toBe(CUSTOMER_A_ID);
      expect(res.body.data.booking_id).toBe(BOOKING_A_ID);
      expect(res.body.data.worker_id).toBe(WORKER_ID);

      // Verify Prisma call arguments
      expect(prisma.review.create).toHaveBeenCalledWith({
        data: {
          booking_id: BOOKING_A_ID,
          worker_id: WORKER_ID,
          customer_id: CUSTOMER_A_ID,
          rating: 4.5,
          comment: "Excellent carpentry work, completed promptly!",
        },
      });
    });
  });

  // ==========================================================================
  // T2 — Client customer_id Cannot Control Author
  // ==========================================================================
  describe("T2: Client customer_id Injection Prevention", () => {
    it("MUST reject request when client provides customer_id in body (strict validation)", async () => {
      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({
          customer_id: CUSTOMER_B_ID,
          rating: 5,
          comment: "Attempting to spoof customer",
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Validation failed");
      expect(prisma.review.create).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // T3 — Client worker_id Cannot Control Author
  // ==========================================================================
  describe("T3: Client worker_id Injection Prevention", () => {
    it("MUST reject request when client provides worker_id in body (strict validation)", async () => {
      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({
          worker_id: "99999999-9999-4999-a999-999999999999",
          rating: 5,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(prisma.review.create).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // T4 — Client booking_id Body Field Cannot Override URL
  // ==========================================================================
  describe("T4: Body booking_id Injection Prevention", () => {
    it("MUST reject request when client provides booking_id in body", async () => {
      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({
          booking_id: BOOKING_B_ID,
          rating: 4,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(prisma.review.create).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // T5 — Customer A Cannot Review Customer B's Booking
  // ==========================================================================
  describe("T5: Cross-Customer Booking Ownership Enforcement", () => {
    it("MUST return 403 Forbidden when Customer A attempts to review Customer B's booking", async () => {
      // Booking exists in database but belongs to Customer B
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_B_ID,
        customer_id: CUSTOMER_B_ID,
        status: "COMPLETED",
      });

      const res = await request(app)
        .post(`/api/reviews/${BOOKING_B_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({
          rating: 1,
          comment: "Malicious review on another customer's booking",
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("FORBIDDEN_BOOKING_ACCESS");
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it("MUST return 404 Not Found when booking does not exist at all", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({ rating: 5 });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("BOOKING_NOT_FOUND");
      expect(prisma.review.create).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // T6 & T7 — Role Authorization Matrix (Worker & Admin Blocked)
  // ==========================================================================
  describe("T6 & T7: Role-Based Access Control", () => {
    it("T6: MUST reject worker with 403 Forbidden", async () => {
      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${workerToken}`)
        .send({ rating: 5 });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Forbidden");
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it("T7: MUST reject admin with 403 Forbidden (reviews strictly customer-authored)", async () => {
      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ rating: 5 });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Forbidden");
      expect(prisma.review.create).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // T8 — Non-Reviewable Booking State is Rejected
  // ==========================================================================
  describe("T8: Non-Reviewable Booking State Rejection", () => {
    const nonReviewableStates = ["PENDING", "IN_PROGRESS", "CANCELLED", "CONFIRMED"];

    test.each(nonReviewableStates)(
      "MUST reject review when booking status is '%s' with 409 Conflict",
      async (status) => {
        (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
          id: BOOKING_A_ID,
          customer_id: CUSTOMER_A_ID,
          worker_id: WORKER_ID,
          status,
        });

        const res = await request(app)
          .post(`/api/reviews/${BOOKING_A_ID}`)
          .set("Authorization", `Bearer ${customerAToken}`)
          .send({ rating: 5 });

        expect(res.status).toBe(409);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe("BOOKING_NOT_COMPLETED");
        expect(res.body.message).toContain("Reviews are only permitted for completed bookings");
        expect(prisma.review.create).not.toHaveBeenCalled();
      }
    );
  });

  // ==========================================================================
  // T9 & T13 — Duplicate Review & Retry Semantics
  // ==========================================================================
  describe("T9 & T13: Duplicate Review Prevention & Retry Handling", () => {
    it("MUST reject second review attempt with 409 Conflict when review already exists", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_ID,
        status: "COMPLETED",
      });
      // Review already exists
      (prisma.review.findFirst as jest.Mock).mockResolvedValue({
        id: "existing-review-uuid",
        booking_id: BOOKING_A_ID,
        rating: 5,
      });

      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({ rating: 4, comment: "Second review attempt" });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("REVIEW_ALREADY_EXISTS");
      expect(res.body.message).toContain("already been submitted");
      expect(prisma.review.create).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // T10 — Concurrent Duplicate Review Prevention
  // ==========================================================================
  describe("T10: Concurrent Duplicate Review Creation (Race Condition Simulation)", () => {
    it("MUST handle concurrent requests safely: exactly one creates review, second gets 409 via P2002", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_ID,
        status: "COMPLETED",
      });
      // Pre-check finds nothing for both racing requests
      (prisma.review.findFirst as jest.Mock).mockResolvedValue(null);

      // First call succeeds; second call fails with database unique constraint violation (P2002)
      let callCount = 0;
      (prisma.review.create as jest.Mock).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            id: "review-1",
            booking_id: BOOKING_A_ID,
            rating: 5,
          });
        }
        const p2002Err: any = new Prisma.PrismaClientKnownRequestError(
          "Unique constraint failed on the fields: (`booking_id`)",
          {
            code: "P2002",
            clientVersion: "7.8.0",
            meta: { target: ["booking_id"] },
          }
        );
        return Promise.reject(p2002Err);
      });

      const [res1, res2] = await Promise.all([
        request(app)
          .post(`/api/reviews/${BOOKING_A_ID}`)
          .set("Authorization", `Bearer ${customerAToken}`)
          .send({ rating: 5, comment: "Concurrent request 1" }),
        request(app)
          .post(`/api/reviews/${BOOKING_A_ID}`)
          .set("Authorization", `Bearer ${customerAToken}`)
          .send({ rating: 5, comment: "Concurrent request 2" }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([201, 409]);

      const conflictRes = res1.status === 409 ? res1 : res2;
      expect(conflictRes.body.success).toBe(false);
      expect(conflictRes.body.code).toBe("REVIEW_ALREADY_EXISTS");
      expect(conflictRes.body.message).toContain("already been submitted");
    });
  });

  // ==========================================================================
  // T11 — Missing Authentication
  // ==========================================================================
  describe("T11: Missing Authentication Token", () => {
    it("MUST reject unauthenticated request with 401 Unauthorized", async () => {
      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .send({ rating: 5 });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(prisma.review.create).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // T12 — Malformed Booking UUID
  // ==========================================================================
  describe("T12: Malformed UUID Route Parameter Validation", () => {
    it("MUST return 400 Bad Request on non-UUID route param without raw DB error exposure", async () => {
      const res = await request(app)
        .post("/api/reviews/not-a-valid-uuid")
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({ rating: 5 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("INVALID_BOOKING_ID");
      expect(res.body.message).toBe("Invalid booking ID format. Must be a valid UUID.");
      expect(prisma.booking.findFirst).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // T14 & T15 — Direct Uniqueness & P2002 Error Classification
  // ==========================================================================
  describe("T14 & T15: Database P2002 Error Classification & Leakage Prevention", () => {
    it("isReviewUniqueConstraintError MUST accurately detect review booking_id violations", () => {
      const reviewP2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint", {
        code: "P2002",
        clientVersion: "7.8.0",
        meta: { target: ["booking_id"] },
      });
      expect(isReviewUniqueConstraintError(reviewP2002)).toBe(true);

      const reviewNamedIndexP2002 = {
        code: "P2002",
        meta: { target: "review_booking_id_key" },
        message: "Unique constraint failed on the constraint: review_booking_id_key",
      };
      expect(isReviewUniqueConstraintError(reviewNamedIndexP2002)).toBe(true);
    });

    it("isReviewUniqueConstraintError MUST NOT classify unrelated P2002 (e.g. phone or payment) as review error", () => {
      const phoneP2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint", {
        code: "P2002",
        clientVersion: "7.8.0",
        meta: { target: ["phone"] },
      });
      expect(isReviewUniqueConstraintError(phoneP2002)).toBe(false);

      const paymentP2002 = {
        code: "P2002",
        meta: { target: ["razorpay_order_id"] },
        message: "Unique constraint failed on payment order id",
      };
      expect(isReviewUniqueConstraintError(paymentP2002)).toBe(false);
    });

    it("Service layer MUST rethrow unrelated database errors rather than swallowing as duplicate review", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_ID,
        status: "COMPLETED",
      });
      (prisma.review.findFirst as jest.Mock).mockResolvedValue(null);

      // Unrelated database error
      const dbConnectionErr = new Error("Connection pool exhausted");
      (prisma.review.create as jest.Mock).mockRejectedValue(dbConnectionErr);

      await expect(
        reviewService.createReview(BOOKING_A_ID, CUSTOMER_A_ID, { rating: 5 })
      ).rejects.toThrow("Connection pool exhausted");
    });
  });

  // ==========================================================================
  // T16 — confirmComplete() Review Handling
  // ==========================================================================
  describe("T16: confirmComplete() Duplicate and State Handling", () => {
    it("MUST allow repeated confirmation without failing when review duplicate constraint fires", async () => {
      const mockTx = {
        booking: {
          findFirst: jest.fn().mockResolvedValue({
            id: BOOKING_A_ID,
            customer_id: CUSTOMER_A_ID,
            worker_id: WORKER_ID,
            status: "COMPLETED",
          }),
        },
        review: {
          create: jest.fn().mockRejectedValue({
            code: "P2002",
            meta: { target: ["booking_id"] },
            message: "Unique constraint failed on booking_id",
          }),
        },
      };

      (prisma.$transaction as jest.Mock).mockImplementationOnce((cb) => cb(mockTx));

      const result = await bookingService.confirmComplete(BOOKING_A_ID, CUSTOMER_A_ID, {
        rating: 5,
        comment: "Repeated confirmation test",
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe("Booking completion confirmed");
    });

    it("MUST reject review creation in confirmComplete when booking status is not COMPLETED", async () => {
      const mockTx = {
        booking: {
          findFirst: jest.fn().mockResolvedValue({
            id: BOOKING_A_ID,
            customer_id: CUSTOMER_A_ID,
            worker_id: WORKER_ID,
            status: "IN_PROGRESS",
          }),
        },
        review: {
          create: jest.fn(),
        },
      };

      (prisma.$transaction as jest.Mock).mockImplementationOnce((cb) => cb(mockTx));

      await expect(
        bookingService.confirmComplete(BOOKING_A_ID, CUSTOMER_A_ID, {
          rating: 5,
        })
      ).rejects.toThrow("Cannot review a booking that is not completed");

      expect(mockTx.review.create).not.toHaveBeenCalled();
    });

    it("MUST rethrow unrelated database error inside confirmComplete transaction", async () => {
      const mockTx = {
        booking: {
          findFirst: jest.fn().mockResolvedValue({
            id: BOOKING_A_ID,
            customer_id: CUSTOMER_A_ID,
            worker_id: WORKER_ID,
            status: "COMPLETED",
          }),
        },
        review: {
          create: jest.fn().mockRejectedValue(new Error("Database disk full")),
        },
      };

      (prisma.$transaction as jest.Mock).mockImplementationOnce((cb) => cb(mockTx));

      await expect(
        bookingService.confirmComplete(BOOKING_A_ID, CUSTOMER_A_ID, {
          rating: 5,
        })
      ).rejects.toThrow("Database disk full");
    });
  });

  // ==========================================================================
  // ATTACK SUITE (All 13 Invariant Attacks)
  // ==========================================================================
  describe("Security Attack Verification Suite (Attacks 1–13)", () => {
    it("ATTACK 1: Customer A supplies Customer B's customer_id in body -> rejected by strict schema", async () => {
      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({
          customer_id: CUSTOMER_B_ID,
          rating: 5,
        });
      expect(res.status).toBe(400);
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it("ATTACK 2: Customer A supplies arbitrary worker_id in body -> rejected by strict schema", async () => {
      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({
          worker_id: "00000000-0000-0000-0000-000000000000",
          rating: 5,
        });
      expect(res.status).toBe(400);
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it("ATTACK 3: Customer A supplies booking_id in body -> rejected by strict schema", async () => {
      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({
          booking_id: BOOKING_B_ID,
          rating: 5,
        });
      expect(res.status).toBe(400);
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it("ATTACK 4: Customer A accesses Booking B by known UUID -> 403 Forbidden", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_B_ID,
        customer_id: CUSTOMER_B_ID,
        status: "COMPLETED",
      });

      const res = await request(app)
        .post(`/api/reviews/${BOOKING_B_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({ rating: 5 });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN_BOOKING_ACCESS");
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it("ATTACK 5: Worker attempts to create customer review -> 403 Forbidden", async () => {
      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${workerToken}`)
        .send({ rating: 5 });

      expect(res.status).toBe(403);
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it("ATTACK 6: Admin attempts customer impersonation -> 403 Forbidden", async () => {
      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ rating: 5 });

      expect(res.status).toBe(403);
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it("ATTACK 7: Unauthenticated request -> 401 Unauthorized", async () => {
      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .send({ rating: 5 });

      expect(res.status).toBe(401);
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it("ATTACK 8: Booking is PENDING -> 409 Conflict", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_ID,
        status: "PENDING",
      });

      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({ rating: 5 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("BOOKING_NOT_COMPLETED");
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it("ATTACK 9: Booking is IN_PROGRESS -> 409 Conflict", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_ID,
        status: "IN_PROGRESS",
      });

      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({ rating: 5 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("BOOKING_NOT_COMPLETED");
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it("ATTACK 10: Booking is CANCELLED -> 409 Conflict", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_ID,
        status: "CANCELLED",
      });

      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({ rating: 5 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("BOOKING_NOT_COMPLETED");
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it("ATTACK 11: Duplicate review submitted sequentially -> 409 Conflict", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_ID,
        status: "COMPLETED",
      });
      (prisma.review.findFirst as jest.Mock).mockResolvedValue({
        id: "existing-review",
        booking_id: BOOKING_A_ID,
      });

      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({ rating: 5 });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("REVIEW_ALREADY_EXISTS");
      expect(prisma.review.create).not.toHaveBeenCalled();
    });

    it("ATTACK 12: Simultaneous duplicate review attempts -> DB uniqueness protects and returns 409", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_ID,
        status: "COMPLETED",
      });
      (prisma.review.findFirst as jest.Mock).mockResolvedValue(null);

      let executionCount = 0;
      (prisma.review.create as jest.Mock).mockImplementation(() => {
        executionCount++;
        if (executionCount === 1) {
          return Promise.resolve({ id: "review-winner", booking_id: BOOKING_A_ID, rating: 5 });
        }
        return Promise.reject({
          code: "P2002",
          meta: { target: ["booking_id"] },
          message: "Unique constraint failed on booking_id",
        });
      });

      const [r1, r2] = await Promise.all([
        request(app).post(`/api/reviews/${BOOKING_A_ID}`).set("Authorization", `Bearer ${customerAToken}`).send({ rating: 5 }),
        request(app).post(`/api/reviews/${BOOKING_A_ID}`).set("Authorization", `Bearer ${customerAToken}`).send({ rating: 5 }),
      ]);

      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([201, 409]);
    });

    it("ATTACK 13: Unrelated P2002 error must NOT be swallowed as already reviewed", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_ID,
        status: "COMPLETED",
      });
      (prisma.review.findFirst as jest.Mock).mockResolvedValue(null);

      // An unrelated P2002 (e.g. some foreign key or internal unique violation on another entity)
      const unrelatedP2002 = new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on user_phone_key",
        {
          code: "P2002",
          clientVersion: "7.8.0",
          meta: { target: ["phone"] },
        }
      );
      (prisma.review.create as jest.Mock).mockRejectedValue(unrelatedP2002);

      const res = await request(app)
        .post(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({ rating: 5 });

      // Controller should treat unexpected/unrelated errors as 500 (internal error), NOT 409
      expect(res.status).toBe(500);
      expect(res.body.code).toBe("REVIEW_INTERNAL_ERROR");
      expect(res.body.message).not.toContain("phone");
    });
  });
});
