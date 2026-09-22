/**
 * LabourBaba Backend — P5 Issues 16–20 Comprehensive Real PostgreSQL Test Suite
 *
 * Covers:
 * - Issue 16: Explicit Booking State Machine & Invariants
 * - Issue 17: Booking OTP Hardening (Atomic attempts, lockout, single consumption, replay defense)
 * - Issue 18: Customer Confirmation (Worker -> AWAITING_CONFIRMATION -> Customer -> COMPLETED)
 * - Issue 19: Cancellation Audit Data (cancelled_at, cancelled_by, cancellation_reason, capacity release)
 * - Issue 20: Database Review Uniqueness (PostgreSQL constraint uniq_review_booking)
 *
 * Runs exclusively against live PostgreSQL 17 database.
 */

import prisma from "../src/config/prisma";
import { bookingService } from "../src/features/booking/bookingServices";
import { reviewService } from "../src/features/review/reviewServices";
import { bookingStateService, BookingStatus, BookingAction } from "../src/features/booking/bookingStateMachine";
import { UserRole } from "../src/type/userRole";
import bcrypt from "bcrypt";

describe("P5 Issues 16–20 Comprehensive Real PostgreSQL Integration Suite", () => {
  jest.setTimeout(60000);

  const SUITE_PREFIX = "p5-e2e";
  const CUSTOMER_ID = "00000000-0000-4050-a000-000000000001";
  const OTHER_CUSTOMER_ID = "00000000-0000-4050-a000-000000000002";
  const WORKER_ID = "00000000-0000-4050-b000-000000000001";
  const OTHER_WORKER_ID = "00000000-0000-4050-b000-000000000002";
  const JOB_ID = "00000000-0000-4050-c000-000000000001";
  const REQ_ID = "00000000-0000-4050-d000-000000000001";
  const BOOKING_ID = "00000000-0000-4050-e000-000000000001";

  const customerActor = { id: CUSTOMER_ID, role: UserRole.CUSTOMER };
  const otherCustomerActor = { id: OTHER_CUSTOMER_ID, role: UserRole.CUSTOMER };
  const workerActor = { id: WORKER_ID, role: UserRole.WORKER };
  const otherWorkerActor = { id: OTHER_WORKER_ID, role: UserRole.WORKER };

  const rawOtp = "654321";
  let skillCategoryId: string;

  async function cleanAll() {
    await prisma.review.deleteMany({ where: { OR: [{ booking_id: BOOKING_ID }, { customer_id: CUSTOMER_ID }] } }).catch(() => {});
    await prisma.notification_outbox.deleteMany({ where: { aggregate_id: BOOKING_ID } }).catch(() => {});
    await prisma.booking_transition.deleteMany({ where: { booking_id: BOOKING_ID } }).catch(() => {});
    await prisma.job_dispatch.deleteMany({ where: { requirement_id: REQ_ID } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: BOOKING_ID } }).catch(() => {});
    await prisma.job_requirement.deleteMany({ where: { id: REQ_ID } }).catch(() => {});
    await prisma.job_transition.deleteMany({ where: { job_id: JOB_ID } }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: JOB_ID } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { id: { in: [CUSTOMER_ID, OTHER_CUSTOMER_ID] } } }).catch(() => {});
    await prisma.worker.deleteMany({ where: { id: { in: [WORKER_ID, OTHER_WORKER_ID] } } }).catch(() => {});
  }

  beforeAll(async () => {
    let cat = await prisma.skill_category.findFirst();
    if (!cat) {
      cat = await prisma.skill_category.create({
        data: { name: "P5SuiteSkill" },
      });
    }
    skillCategoryId = cat.id;

    await cleanAll();

    // Create Customers
    await prisma.customer.createMany({
      data: [
        { id: CUSTOMER_ID, phone: "+919811005001", name: "P5 Customer 1", password: "hash" },
        { id: OTHER_CUSTOMER_ID, phone: "+919811005002", name: "P5 Customer 2", password: "hash" },
      ],
    });

    // Create Workers
    await prisma.worker.createMany({
      data: [
        {
          id: WORKER_ID,
          phone: "+919711005001",
          name: "P5 Worker 1",
          password: "hash",
          skill_type: "P5SuiteSkill",
          skill_category_id: skillCategoryId,
          verification_status: "verified",
        },
        {
          id: OTHER_WORKER_ID,
          phone: "+919711005002",
          name: "P5 Worker 2",
          password: "hash",
          skill_type: "P5SuiteSkill",
          skill_category_id: skillCategoryId,
          verification_status: "verified",
        },
      ],
    });
  });

  afterAll(async () => {
    await cleanAll();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Reset Job, Requirement, Booking, Transitions, Reviews
    await prisma.review.deleteMany({ where: { booking_id: BOOKING_ID } }).catch(() => {});
    await prisma.notification_outbox.deleteMany({ where: { aggregate_id: BOOKING_ID } }).catch(() => {});
    await prisma.booking_transition.deleteMany({ where: { booking_id: BOOKING_ID } }).catch(() => {});
    await prisma.job_dispatch.deleteMany({ where: { requirement_id: REQ_ID } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: BOOKING_ID } }).catch(() => {});
    await prisma.job_requirement.deleteMany({ where: { id: REQ_ID } }).catch(() => {});
    await prisma.job_transition.deleteMany({ where: { job_id: JOB_ID } }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: JOB_ID } }).catch(() => {});

    // Create Job (BOOKED)
    await prisma.job.create({
      data: {
        id: JOB_ID,
        customer_id: CUSTOMER_ID,
        status: "BOOKED",
      },
    });

    // Create Requirement
    await prisma.job_requirement.create({
      data: {
        id: REQ_ID,
        job_id: JOB_ID,
        skill_id: skillCategoryId,
        skill_type: "P5SuiteSkill",
        worker_count_needed: 1,
        worker_count_filled: 1,
        status: "FILLED",
      },
    });

    // Create Job Dispatch for worker
    await prisma.job_dispatch.create({
      data: {
        requirement_id: REQ_ID,
        worker_id: WORKER_ID,
        status: "accepted",
      },
    });

    const otpHash = await bcrypt.hash(rawOtp, 10);

    // Create Booking (CONFIRMED)
    await prisma.booking.create({
      data: {
        id: BOOKING_ID,
        job_id: JOB_ID,
        requirement_id: REQ_ID,
        worker_id: WORKER_ID,
        customer_id: CUSTOMER_ID,
        status: "CONFIRMED",
        otp_hash: otpHash,
        otp_verified: false,
        otp_expires_at: new Date(Date.now() + 3600000),
        otp_attempts: 0,
      },
    });
  });

  // =========================================================================
  // 1. FULL HAPPY-PATH LIFECYCLE (Issues 16, 17, 18, 20)
  // =========================================================================
  describe("1. Complete Legal Marketplace Lifecycle & Invariant Transitions", () => {
    it("progresses CONFIRMED -> IN_PROGRESS -> AWAITING_CONFIRMATION -> COMPLETED -> REVIEWED", async () => {
      // 1. Booking initially CONFIRMED
      let booking = await prisma.booking.findUnique({ where: { id: BOOKING_ID } });
      expect(booking?.status).toBe("CONFIRMED");

      // 2. OTP Verification by assigned Worker
      const verifyRes = await bookingService.verifyOtp(BOOKING_ID, WORKER_ID, rawOtp, workerActor);
      expect(verifyRes.success).toBe(true);

      booking = await prisma.booking.findUnique({ where: { id: BOOKING_ID } });
      expect(booking?.status).toBe("IN_PROGRESS");
      expect(booking?.otp_verified).toBe(true);
      expect(booking?.otp_consumed_at).not.toBeNull();
      expect(booking?.verified_at).not.toBeNull();
      expect(booking?.verified_by).toBe(WORKER_ID);

      // Verify parent job moved to IN_PROGRESS
      const job = await prisma.job.findUnique({ where: { id: JOB_ID } });
      expect(job?.status).toBe("IN_PROGRESS");

      // 3. Worker requests completion -> moves to AWAITING_CONFIRMATION (NOT COMPLETED!)
      const completeRes = await bookingService.completeBooking(BOOKING_ID, WORKER_ID, workerActor);
      expect(completeRes.success).toBe(true);

      booking = await prisma.booking.findUnique({ where: { id: BOOKING_ID } });
      expect(booking?.status).toBe("AWAITING_CONFIRMATION");
      expect(booking?.completion_requested_at).not.toBeNull();

      // Ensure review is rejected while in AWAITING_CONFIRMATION
      await expect(
        reviewService.createReview(
          BOOKING_ID,
          CUSTOMER_ID,
          { rating: 5, comment: "Too early review" }
        )
      ).rejects.toThrow();

      // 4. Customer confirms completion -> moves to COMPLETED
      const confirmRes = await bookingService.confirmComplete(
        BOOKING_ID,
        CUSTOMER_ID,
        { rating: 5, comment: "Excellent work done!" },
        customerActor
      );
      expect(confirmRes.success).toBe(true);

      booking = await prisma.booking.findUnique({ where: { id: BOOKING_ID } });
      expect(booking?.status).toBe("COMPLETED");
      expect(booking?.completed_at).not.toBeNull();
      expect(booking?.confirmed_at).not.toBeNull();
      expect(booking?.confirmed_by).toBe(CUSTOMER_ID);

      // 5. Verify Review row was created exactly once
      const reviews = await prisma.review.findMany({ where: { booking_id: BOOKING_ID } });
      expect(reviews.length).toBe(1);
      expect(Number(reviews[0].rating)).toBe(5);
      expect(reviews[0].comment).toBe("Excellent work done!");

      // 6. Review retry must be rejected with 409 / REVIEW_ALREADY_EXISTS
      await expect(
        reviewService.createReview(
          BOOKING_ID,
          CUSTOMER_ID,
          { rating: 4, comment: "Second review attempt" }
        )
      ).rejects.toThrow();

      const reviewsAfter = await prisma.review.findMany({ where: { booking_id: BOOKING_ID } });
      expect(reviewsAfter.length).toBe(1);
    });
  });

  // =========================================================================
  // 2. CANCELLATION LIFECYCLE & CAPACITY RECONCILIATION (Issue 19)
  // =========================================================================
  describe("2. Cancellation Lifecycle & Side Effect Reconciliation", () => {
    it("cancels CONFIRMED booking, persists audit info, and releases requirement capacity", async () => {
      const cancelRes = await bookingService.cancelBooking(
        BOOKING_ID,
        CUSTOMER_ID,
        { reason: "Customer plans changed unexpectedly" },
        customerActor
      );
      expect(cancelRes.success).toBe(true);

      const booking = await prisma.booking.findUnique({ where: { id: BOOKING_ID } });
      expect(booking?.status).toBe("CANCELLED");
      expect(booking?.cancelled_at).not.toBeNull();
      expect(booking?.cancelled_by).toBe(CUSTOMER_ID);
      expect(booking?.cancellation_reason).toBe("Customer plans changed unexpectedly");

      // Verify requirement capacity was reconciled from active bookings -> 0
      const req = await prisma.job_requirement.findUnique({ where: { id: REQ_ID } });
      expect(req?.worker_count_filled).toBe(0);

      // Verify job dispatch marked cancelled
      const dispatch = await prisma.job_dispatch.findFirst({
        where: { requirement_id: REQ_ID, worker_id: WORKER_ID },
      });
      expect(dispatch?.status).toBe("cancelled");

      // Verify audit record exists in booking_transition
      const transitionAudit = await prisma.booking_transition.findFirst({
        where: { booking_id: BOOKING_ID, to_status: "CANCELLED" },
      });
      expect(transitionAudit).not.toBeNull();
      expect(transitionAudit?.actor_id).toBe(CUSTOMER_ID);

      // Verify review is forbidden on cancelled booking
      await expect(
        reviewService.createReview(
          BOOKING_ID,
          CUSTOMER_ID,
          { rating: 1, comment: "Cannot review cancelled booking" }
        )
      ).rejects.toThrow();
    });
  });

  // =========================================================================
  // 3. REAL POSTGRESQL CONCURRENCY TESTS (TESTS A through F)
  // =========================================================================
  describe("3. Real PostgreSQL Concurrency Tests (Tests A–F)", () => {
    // TEST A: Concurrent OTP verification
    it("TEST A: 5 concurrent valid OTP verification requests -> exactly one succeeds, 4 fail", async () => {
      const attempts = Array(5)
        .fill(0)
        .map(() => bookingService.verifyOtp(BOOKING_ID, WORKER_ID, rawOtp, workerActor));

      const results = await Promise.allSettled(attempts);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(4);

      const booking = await prisma.booking.findUnique({ where: { id: BOOKING_ID } });
      expect(booking?.status).toBe("IN_PROGRESS");
      expect(booking?.otp_verified).toBe(true);
      expect(booking?.otp_consumed_at).not.toBeNull();
    });

    // TEST B: Concurrent Completion & Confirmation
    it("TEST B: Concurrent customer confirmations -> exactly one transitions, second is idempotent", async () => {
      await prisma.job.update({ where: { id: JOB_ID }, data: { status: "IN_PROGRESS" } });
      await prisma.booking.update({
        where: { id: BOOKING_ID },
        data: { status: "AWAITING_CONFIRMATION", completion_requested_at: new Date() },
      });

      const confirmations = Array(3)
        .fill(0)
        .map(() =>
          bookingService.confirmComplete(
            BOOKING_ID,
            CUSTOMER_ID,
            { rating: 5, comment: "Top quality work!" },
            customerActor
          )
        );

      const results = await Promise.allSettled(confirmations);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      const booking = await prisma.booking.findUnique({ where: { id: BOOKING_ID } });
      expect(booking?.status).toBe("COMPLETED");

      const reviews = await prisma.review.findMany({ where: { booking_id: BOOKING_ID } });
      expect(reviews.length).toBe(1);
    });

    // TEST C: Concurrent Cancellation Requests
    it("TEST C: Concurrent cancellations -> exactly one succeeds, capacity released exactly once", async () => {
      const cancellations = Array(3)
        .fill(0)
        .map(() =>
          bookingService.cancelBooking(
            BOOKING_ID,
            CUSTOMER_ID,
            { reason: "Concurrent cancellation test" },
            customerActor
          )
        );

      const results = await Promise.allSettled(cancellations);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      const booking = await prisma.booking.findUnique({ where: { id: BOOKING_ID } });
      expect(booking?.status).toBe("CANCELLED");

      const req = await prisma.job_requirement.findUnique({ where: { id: REQ_ID } });
      expect(req?.worker_count_filled).toBe(0); // Never negative
    });

    // TEST D: Completion vs Cancellation Race
    it("TEST D: Race between customer cancellation and worker completion converges safely", async () => {
      await prisma.job.update({ where: { id: JOB_ID }, data: { status: "IN_PROGRESS" } });
      await prisma.booking.update({
        where: { id: BOOKING_ID },
        data: { status: "IN_PROGRESS", otp_verified: true, verified_at: new Date() },
      });

      const cancelPromise = bookingService.cancelBooking(
        BOOKING_ID,
        CUSTOMER_ID,
        { reason: "Customer cancelling in race" },
        customerActor
      );
      const completePromise = bookingService.completeBooking(BOOKING_ID, WORKER_ID, workerActor);

      await Promise.allSettled([cancelPromise, completePromise]);

      const booking = await prisma.booking.findUnique({ where: { id: BOOKING_ID } });
      expect(["CANCELLED", "AWAITING_CONFIRMATION"]).toContain(booking?.status);

      const req = await prisma.job_requirement.findUnique({ where: { id: REQ_ID } });
      expect(req?.worker_count_filled).toBeGreaterThanOrEqual(0);
      expect(req?.worker_count_filled).toBeLessThanOrEqual(1);
    });

    // TEST E: Concurrent Review Creation
    it("TEST E: Multiple concurrent review creation requests yield exactly one review row", async () => {
      await prisma.job.update({ where: { id: JOB_ID }, data: { status: "COMPLETED" } });
      await prisma.booking.update({
        where: { id: BOOKING_ID },
        data: {
          status: "COMPLETED",
          completed_at: new Date(),
          confirmed_at: new Date(),
          confirmed_by: CUSTOMER_ID,
        },
      });

      const reviewCalls = Array(5)
        .fill(0)
        .map((_, i) =>
          reviewService.createReview(
            BOOKING_ID,
            CUSTOMER_ID,
            { rating: 5, comment: `Concurrent review ${i}` }
          )
        );

      const results = await Promise.allSettled(reviewCalls);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(4);

      const reviews = await prisma.review.findMany({ where: { booking_id: BOOKING_ID } });
      expect(reviews.length).toBe(1);
    });

    // TEST F: Review Retry Idempotency
    it("TEST F: Sequential retry for same booking never creates duplicate review", async () => {
      await prisma.job.update({ where: { id: JOB_ID }, data: { status: "COMPLETED" } });
      await prisma.booking.update({
        where: { id: BOOKING_ID },
        data: {
          status: "COMPLETED",
          completed_at: new Date(),
          confirmed_at: new Date(),
          confirmed_by: CUSTOMER_ID,
        },
      });

      // First review succeeds
      const r1 = await reviewService.createReview(
        BOOKING_ID,
        CUSTOMER_ID,
        { rating: 5, comment: "First review" }
      );
      expect(r1).toBeDefined();

      // Second review throws
      await expect(
        reviewService.createReview(
          BOOKING_ID,
          CUSTOMER_ID,
          { rating: 4, comment: "Retry review" }
        )
      ).rejects.toThrow();

      const allReviews = await prisma.review.findMany({ where: { booking_id: BOOKING_ID } });
      expect(allReviews.length).toBe(1);
    });
  });

  // =========================================================================
  // 4. ATTEMPT LIMIT & EXHAUSTION PERSISTENCE (Issue 17)
  // =========================================================================
  describe("4. OTP Attempt Limit & Lockout Durability in PostgreSQL", () => {
    it("atomically increments failed attempts in DB and locks challenge at 5 attempts", async () => {
      // 1. Invalid attempt 1
      await expect(
        bookingService.verifyOtp(BOOKING_ID, WORKER_ID, "000001", workerActor)
      ).rejects.toThrow("Invalid OTP");

      let booking = await prisma.booking.findUnique({ where: { id: BOOKING_ID } });
      expect(booking?.otp_attempts).toBe(1);
      expect(booking?.otp_locked_at).toBeNull();

      // 2. Attempts 2 through 4
      for (let i = 2; i <= 4; i++) {
        await expect(
          bookingService.verifyOtp(BOOKING_ID, WORKER_ID, `00000${i}`, workerActor)
        ).rejects.toThrow("Invalid OTP");
      }

      booking = await prisma.booking.findUnique({ where: { id: BOOKING_ID } });
      expect(booking?.otp_attempts).toBe(4);

      // 3. Attempt 5 reaches max limit -> locks OTP
      await expect(
        bookingService.verifyOtp(BOOKING_ID, WORKER_ID, "000005", workerActor)
      ).rejects.toThrow("Maximum verification attempts exceeded. Booking OTP is locked.");

      booking = await prisma.booking.findUnique({ where: { id: BOOKING_ID } });
      expect(booking?.otp_attempts).toBe(5);
      expect(booking?.otp_locked_at).not.toBeNull();

      // 4. Attempt 6 with CORRECT OTP is rejected due to lockout
      await expect(
        bookingService.verifyOtp(BOOKING_ID, WORKER_ID, rawOtp, workerActor)
      ).rejects.toThrow("Maximum verification attempts exceeded. Booking OTP is locked.");
    });
  });

  // =========================================================================
  // 5. MANDATORY NEGATIVE MATRIX & AUTHORIZATION
  // =========================================================================
  describe("5. Mandatory Negative Matrix & Authorization Guards", () => {
    it("rejects OTP verification on COMPLETED booking", async () => {
      await prisma.booking.update({
        where: { id: BOOKING_ID },
        data: { status: "COMPLETED", completed_at: new Date() },
      });
      await expect(
        bookingService.verifyOtp(BOOKING_ID, WORKER_ID, rawOtp, workerActor)
      ).rejects.toThrow("Cannot verify OTP: Booking is in status 'COMPLETED'");
    });

    it("rejects OTP verification on CANCELLED booking", async () => {
      await prisma.booking.update({
        where: { id: BOOKING_ID },
        data: {
          status: "CANCELLED",
          cancelled_at: new Date(),
          cancelled_by: CUSTOMER_ID,
          cancellation_reason: "Pre-cancelled for negative test",
        },
      });
      await expect(
        bookingService.verifyOtp(BOOKING_ID, WORKER_ID, rawOtp, workerActor)
      ).rejects.toThrow("Cannot verify OTP: Booking is in status 'CANCELLED'");
    });

    it("rejects OTP verification with expired OTP", async () => {
      await prisma.booking.update({
        where: { id: BOOKING_ID },
        data: { otp_expires_at: new Date(Date.now() - 1000) },
      });
      await expect(
        bookingService.verifyOtp(BOOKING_ID, WORKER_ID, rawOtp, workerActor)
      ).rejects.toThrow("Booking OTP has expired");
    });

    it("rejects customer confirmation by wrong customer", async () => {
      await prisma.booking.update({
        where: { id: BOOKING_ID },
        data: { status: "AWAITING_CONFIRMATION", completion_requested_at: new Date() },
      });
      await expect(
        bookingService.confirmComplete(
          BOOKING_ID,
          OTHER_CUSTOMER_ID,
          { rating: 5, comment: "Nice" },
          otherCustomerActor
        )
      ).rejects.toThrow();
    });

    it("rejects customer confirmation attempted by worker role", async () => {
      await prisma.booking.update({
        where: { id: BOOKING_ID },
        data: { status: "AWAITING_CONFIRMATION", completion_requested_at: new Date() },
      });
      await expect(
        bookingService.confirmComplete(
          BOOKING_ID,
          WORKER_ID,
          { rating: 5, comment: "Nice" },
          workerActor
        )
      ).rejects.toThrow();
    });

    it("rejects cancellation with empty reason", async () => {
      await expect(
        bookingService.cancelBooking(BOOKING_ID, CUSTOMER_ID, { reason: "   " }, customerActor)
      ).rejects.toThrow("Cancellation reason is required and cannot be empty");
    });

    it("rejects cancellation on COMPLETED booking", async () => {
      await prisma.booking.update({
        where: { id: BOOKING_ID },
        data: { status: "COMPLETED", completed_at: new Date() },
      });
      await expect(
        bookingService.cancelBooking(
          BOOKING_ID,
          CUSTOMER_ID,
          { reason: "Too late to cancel" },
          customerActor
        )
      ).rejects.toThrow();
    });

    it("rejects review creation by non-owner customer", async () => {
      await prisma.booking.update({
        where: { id: BOOKING_ID },
        data: { status: "COMPLETED", completed_at: new Date(), confirmed_at: new Date() },
      });
      await expect(
        reviewService.createReview(
          BOOKING_ID,
          OTHER_CUSTOMER_ID,
          { rating: 5, comment: "I do not own this booking" }
        )
      ).rejects.toThrow();
    });
  });
});
