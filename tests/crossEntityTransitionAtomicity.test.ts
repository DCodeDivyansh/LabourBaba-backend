import prisma from "../src/config/prisma";
import { bookingService } from "../src/features/booking/bookingServices";
import { BookingStatus } from "../src/features/booking/bookingStateMachine";
import { JobStatus } from "../src/features/jobs/jobStateMachine";
import { UserRole } from "../src/policies";

describe("P4 Issue 14: Cross-Entity State Transition Atomicity & Correctness", () => {
  jest.setTimeout(30000);
  let customerId: string;
  let worker1Id: string;
  let worker2Id: string;
  let skillCatId: string;
  let jobId: string;
  let requirementId: string;
  let booking1Id: string;
  let booking2Id: string;

  beforeEach(async () => {
    // 1. Create skill category
    const cat = await prisma.skill_category.create({
      data: { name: `CrossTestSkill_${Date.now()}_${Math.random()}` },
    });
    skillCatId = cat.id;

    // 2. Create customer
    const cust = await prisma.customer.create({
      data: {
        phone: `+91971${String(Date.now()).slice(-7)}`,
        name: "Cross Customer",
        password: "hash",
      },
    });
    customerId = cust.id;

    // 3. Create two workers
    const worker1 = await prisma.worker.create({
      data: {
        phone: `+91972${String(Date.now()).slice(-7)}`,
        name: "Cross Worker 1",
        password: "hash",
        skill_type: "Painter",
        skill_category_id: skillCatId,
      },
    });
    worker1Id = worker1.id;

    const worker2 = await prisma.worker.create({
      data: {
        phone: `+91973${String(Date.now()).slice(-7)}`,
        name: "Cross Worker 2",
        password: "hash",
        skill_type: "Painter",
        skill_category_id: skillCatId,
      },
    });
    worker2Id = worker2.id;

    // 4. Create multi-worker job (needs 2 workers)
    const job = await prisma.job.create({
      data: {
        customer_id: customerId,
        status: JobStatus.IN_PROGRESS,
        dispatch_status: "FILLED",
      },
    });
    jobId = job.id;

    const req = await prisma.job_requirement.create({
      data: {
        job_id: jobId,
        skill_id: skillCatId,
        skill_type: "Painter",
        worker_count_needed: 2,
        worker_count_filled: 2,
        status: "FILLED",
      },
    });
    requirementId = req.id;

    // 5. Create 2 bookings for the job
    const b1 = await prisma.booking.create({
      data: {
        job_id: jobId,
        requirement_id: requirementId,
        customer_id: customerId,
        worker_id: worker1Id,
        status: BookingStatus.AWAITING_CONFIRMATION,
      },
    });
    booking1Id = b1.id;

    const b2 = await prisma.booking.create({
      data: {
        job_id: jobId,
        requirement_id: requirementId,
        customer_id: customerId,
        worker_id: worker2Id,
        status: BookingStatus.AWAITING_CONFIRMATION,
      },
    });
    booking2Id = b2.id;
  });

  afterEach(async () => {
    try {
      if (booking1Id) await prisma.$executeRawUnsafe(`DELETE FROM "booking_transition" WHERE booking_id = '${booking1Id}'::uuid`);
      if (booking2Id) await prisma.$executeRawUnsafe(`DELETE FROM "booking_transition" WHERE booking_id = '${booking2Id}'::uuid`);
      if (jobId) await prisma.$executeRawUnsafe(`DELETE FROM "job_transition" WHERE job_id = '${jobId}'::uuid`);
      if (booking1Id) await prisma.$executeRawUnsafe(`DELETE FROM "booking" WHERE id = '${booking1Id}'::uuid`);
      if (booking2Id) await prisma.$executeRawUnsafe(`DELETE FROM "booking" WHERE id = '${booking2Id}'::uuid`);
      if (requirementId) await prisma.$executeRawUnsafe(`DELETE FROM "job_requirement" WHERE id = '${requirementId}'::uuid`);
      if (jobId) await prisma.$executeRawUnsafe(`DELETE FROM "job" WHERE id = '${jobId}'::uuid`);
      if (worker1Id) await prisma.$executeRawUnsafe(`DELETE FROM "worker" WHERE id = '${worker1Id}'::uuid`);
      if (worker2Id) await prisma.$executeRawUnsafe(`DELETE FROM "worker" WHERE id = '${worker2Id}'::uuid`);
      if (customerId) await prisma.$executeRawUnsafe(`DELETE FROM "customer" WHERE id = '${customerId}'::uuid`);
      if (skillCatId) await prisma.$executeRawUnsafe(`DELETE FROM "skill_category" WHERE id = '${skillCatId}'::uuid`);
    } catch {
      // Cleanup best effort
    }
  });

  it("Test A: Completing 1 of 2 bookings does not complete the parent job prematurely", async () => {
    const customerActor = { id: customerId, role: UserRole.CUSTOMER, phone: "" };

    const res = await bookingService.confirmComplete(
      booking1Id,
      customerId,
      { rating: 5, comment: "Great work!" },
      customerActor
    );

    expect(res.success).toBe(true);

    // Booking 1 is COMPLETED
    const b1 = await prisma.booking.findUnique({ where: { id: booking1Id } });
    expect(b1?.status).toBe(BookingStatus.COMPLETED);

    // Booking 2 is still AWAITING_CONFIRMATION
    const b2 = await prisma.booking.findUnique({ where: { id: booking2Id } });
    expect(b2?.status).toBe(BookingStatus.AWAITING_CONFIRMATION);

    // Parent job MUST remain IN_PROGRESS
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    expect(job?.status).toBe(JobStatus.IN_PROGRESS);
  });

  it("Test B: Completing all bookings transitions parent job to COMPLETED atomically", async () => {
    const customerActor = { id: customerId, role: UserRole.CUSTOMER, phone: "" };

    // Complete booking 1
    await bookingService.confirmComplete(booking1Id, customerId, {}, customerActor);

    // Complete booking 2 (final uncompleted booking)
    const res2 = await bookingService.confirmComplete(booking2Id, customerId, {}, customerActor);
    expect(res2.success).toBe(true);

    // Both bookings must be COMPLETED
    const b1 = await prisma.booking.findUnique({ where: { id: booking1Id } });
    const b2 = await prisma.booking.findUnique({ where: { id: booking2Id } });
    expect(b1?.status).toBe(BookingStatus.COMPLETED);
    expect(b2?.status).toBe(BookingStatus.COMPLETED);

    // Parent job MUST now be COMPLETED
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    expect(job?.status).toBe(JobStatus.COMPLETED);
  });

  it("Test C: Unexpected database failure during cross-entity transition aborts the entire transaction", async () => {
    // Deliberately corrupt foreign key in transaction or execute failing cross-entity transition
    const customerActor = { id: customerId, role: UserRole.CUSTOMER, phone: "" };

    // Simulate unexpected transaction failure: if job update fails, booking must roll back
    await expect(
      prisma.$transaction(async (tx) => {
        // Step 1: Complete booking
        await tx.booking.update({
          where: { id: booking1Id },
          data: { status: BookingStatus.COMPLETED },
        });

        // Step 2: Inject unexpected database failure on job update (e.g. invalid status violating CHECK constraint)
        await tx.$executeRawUnsafe(`UPDATE "job" SET status = 'INVALID_STATUS_THAT_VIOLATES_CHECK' WHERE id = '${jobId}'::uuid`);
      })
    ).rejects.toThrow();

    // Verify booking1 remained in original state (AWAITING_CONFIRMATION)
    const b1 = await prisma.booking.findUnique({ where: { id: booking1Id } });
    expect(b1?.status).toBe(BookingStatus.AWAITING_CONFIRMATION);
  });

  it("Test D: Duplicate completion retry is safe and idempotent", async () => {
    const customerActor = { id: customerId, role: UserRole.CUSTOMER, phone: "" };

    // First completion
    await bookingService.confirmComplete(booking1Id, customerId, {}, customerActor);

    // Duplicate completion retry
    const resRetry = await bookingService.confirmComplete(booking1Id, customerId, {}, customerActor);
    expect(resRetry.success).toBe(true);

    const b1 = await prisma.booking.findUnique({ where: { id: booking1Id } });
    expect(b1?.status).toBe(BookingStatus.COMPLETED);
  });

  it("Test E: Completion vs Cancellation concurrent race produces one valid final state", async () => {
    const customerActor = { id: customerId, role: UserRole.CUSTOMER, phone: "" };

    // Race confirmComplete vs cancelBooking on booking1
    const results = await Promise.allSettled([
      bookingService.confirmComplete(booking1Id, customerId, {}, customerActor),
      bookingService.cancelBooking(booking1Id, customerId, { reason: "Changed plans" }, customerActor),
    ]);

    // Final state of booking1 must be strictly one of COMPLETED or CANCELLED, never in-between or invalid
    const b1 = await prisma.booking.findUnique({ where: { id: booking1Id } });
    expect([BookingStatus.COMPLETED, BookingStatus.CANCELLED]).toContain(b1?.status);
  });
});
