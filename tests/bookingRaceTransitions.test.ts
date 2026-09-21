import { bookingService } from "../src/features/booking/bookingServices";
import prisma from "../src/config/prisma";
import { UserRole } from "../src/type/userRole";
import bcrypt from "bcrypt";

describe("Issue 53 - Real PostgreSQL Booking State Transitions & Race Tests", () => {
  jest.setTimeout(45000);

  const CUSTOMER_ID = "00000000-0000-4003-a000-000000000001";
  const WORKER_ID = "00000000-0000-4003-b000-000000000001";
  const JOB_ID = "00000000-0000-4003-c000-000000000001";
  const REQ_ID = "00000000-0000-4003-d000-000000000001";
  const BOOKING_ID = "00000000-0000-4003-e000-000000000001";

  const customerActor = { id: CUSTOMER_ID, role: UserRole.CUSTOMER };
  const workerActor = { id: WORKER_ID, role: UserRole.WORKER };

  let skillCategoryId: string;
  const rawOtp = "123456";

  beforeAll(async () => {
    let category = await prisma.skill_category.findFirst();
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "BookingRaceSkill", description: "Skill for booking race tests" },
      });
    }
    skillCategoryId = category.id;

    // Seed customer
    await prisma.customer.upsert({
      where: { id: CUSTOMER_ID },
      update: { phone: "+919811000001" },
      create: { id: CUSTOMER_ID, phone: "+919811000001", name: "Race Customer", password: "hash" },
    });

    // Seed worker
    await prisma.worker.upsert({
      where: { id: WORKER_ID },
      update: { phone: "+919711000001", skill_category_id: skillCategoryId, verification_status: "verified" },
      create: {
        id: WORKER_ID,
        phone: "+919711000001",
        name: "Race Worker",
        password: "hash",
        skill_type: "BookingRaceSkill",
        skill_category_id: skillCategoryId,
        verification_status: "verified",
      },
    });
  });

  afterAll(async () => {
    await prisma.review.deleteMany({ where: { booking_id: BOOKING_ID } }).catch(() => {});
    await prisma.booking_transition.deleteMany({ where: { booking_id: BOOKING_ID } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: BOOKING_ID } }).catch(() => {});
    await prisma.job_requirement.deleteMany({ where: { id: REQ_ID } }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: JOB_ID } }).catch(() => {});
    await prisma.worker.deleteMany({ where: { id: WORKER_ID } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { id: CUSTOMER_ID } }).catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Reset test state
    await prisma.review.deleteMany({ where: { booking_id: BOOKING_ID } }).catch(() => {});
    await prisma.booking_transition.deleteMany({ where: { booking_id: BOOKING_ID } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: BOOKING_ID } }).catch(() => {});
    await prisma.job_requirement.deleteMany({ where: { id: REQ_ID } }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: JOB_ID } }).catch(() => {});

    // Create Job
    await prisma.job.create({
      data: {
        id: JOB_ID,
        customer_id: CUSTOMER_ID,
        status: "OPEN",
      },
    });

    // Create Requirement
    await prisma.job_requirement.create({
      data: {
        id: REQ_ID,
        job_id: JOB_ID,
        skill_id: skillCategoryId,
        skill_type: "BookingRaceSkill",
        worker_count_needed: 1,
        worker_count_filled: 1,
        status: "OPEN",
      },
    });

    const otpHash = await bcrypt.hash(rawOtp, 10);

    // Create Booking in CONFIRMED state with valid OTP
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
        otp_expires_at: new Date(Date.now() + 3600000), // 1 hour future
        otp_attempts: 0,
      },
    });
  });

  describe("1. Duplicate / Concurrent OTP Verification Race", () => {
    it("allows exactly one OTP verification to succeed when multiple concurrent requests are made with the same valid OTP", async () => {
      // Launch 5 concurrent OTP verification calls with the same valid OTP
      const attempts = Array(5)
        .fill(0)
        .map(() =>
          bookingService.verifyOtp(BOOKING_ID, WORKER_ID, rawOtp, workerActor)
        );

      const results = await Promise.allSettled(attempts);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Exactly 1 must succeed
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(4);

      // Verify DB state is IN_PROGRESS and OTP marked consumed
      const booking = await prisma.booking.findUnique({
        where: { id: BOOKING_ID },
      });

      expect(booking?.status).toBe("IN_PROGRESS");
      expect(booking?.otp_verified).toBe(true);
      expect(booking?.otp_consumed_at).not.toBeNull();
    });
  });

  describe("2. Concurrent Cancel vs Completion Race", () => {
    it("leaves booking in a single legal consistent state when customer cancels while worker completes", async () => {
      // Transition booking to IN_PROGRESS first
      await prisma.booking.update({
        where: { id: BOOKING_ID },
        data: { status: "IN_PROGRESS", otp_verified: true, verified_at: new Date() },
      });

      // Concurrently run customer cancellation and worker completion request
      const cancelPromise = bookingService.cancelBooking(BOOKING_ID, CUSTOMER_ID, {
        reason: "Customer changed mind",
      }, customerActor);
      const completePromise = bookingService.completeBooking(BOOKING_ID, WORKER_ID, workerActor);

      const results = await Promise.allSettled([cancelPromise, completePromise]);

      // Verify booking state is either CANCELLED or AWAITING_CONFIRMATION
      const finalBooking = await prisma.booking.findUnique({
        where: { id: BOOKING_ID },
      });

      expect(["CANCELLED", "AWAITING_CONFIRMATION"]).toContain(finalBooking?.status);

      // Verify requirement capacity invariant
      const requirement = await prisma.job_requirement.findUnique({
        where: { id: REQ_ID },
      });
      expect(requirement?.worker_count_filled).toBeGreaterThanOrEqual(0);
      expect(requirement?.worker_count_filled).toBeLessThanOrEqual(1);
    });
  });

  describe("3. Duplicate Confirmation & Review Idempotency", () => {
    it("prevents duplicate reviews when multiple concurrent confirmation requests are received", async () => {
      // Transition booking to AWAITING_CONFIRMATION
      await prisma.booking.update({
        where: { id: BOOKING_ID },
        data: {
          status: "AWAITING_CONFIRMATION",
          completion_requested_at: new Date(),
        },
      });

      // Concurrently send 3 confirmation requests
      const confirmations = Array(3)
        .fill(0)
        .map(() =>
          bookingService.confirmComplete(BOOKING_ID, CUSTOMER_ID, {
            rating: 5,
            comment: "Great service!",
          }, customerActor)
        );

      const results = await Promise.allSettled(confirmations);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      // Verify final booking is COMPLETED
      const booking = await prisma.booking.findUnique({
        where: { id: BOOKING_ID },
      });
      expect(booking?.status).toBe("COMPLETED");

      // Verify exactly 1 review exists (no duplicates)
      const reviews = await prisma.review.findMany({
        where: { booking_id: BOOKING_ID },
      });
      expect(reviews.length).toBe(1);
    });
  });

  describe("4. Illegal State Machine Transition Guards", () => {
    it("rejects direct transition from CONFIRMED to COMPLETED without OTP verification", async () => {
      await expect(
        bookingService.confirmComplete(BOOKING_ID, CUSTOMER_ID, { rating: 5 }, customerActor)
      ).rejects.toThrow();
    });
  });
});
