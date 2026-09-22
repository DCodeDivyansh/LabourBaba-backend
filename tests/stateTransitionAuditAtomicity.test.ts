import prisma from "../src/config/prisma";
import {
  bookingStateService,
  BookingAction,
  BookingStatus,
} from "../src/features/booking/bookingStateMachine";
import { UserRole } from "../src/policies";

describe("P4 Issue 13: Mandatory State-Transition Audit Atomicity", () => {
  let customerId: string;
  let workerId: string;
  let skillCatId: string;
  let jobId: string;
  let requirementId: string;
  let bookingId: string;

  beforeAll(async () => {
    // 1. Create skill category
    const cat = await prisma.skill_category.create({
      data: { name: `AuditTestSkill_${Date.now()}` },
    });
    skillCatId = cat.id;

    // 2. Create customer
    const cust = await prisma.customer.create({
      data: {
        phone: `+91981${String(Date.now()).slice(-7)}`,
        name: "Audit Customer",
        password: "hash",
      },
    });
    customerId = cust.id;

    // 3. Create worker
    const worker = await prisma.worker.create({
      data: {
        phone: `+91982${String(Date.now()).slice(-7)}`,
        name: "Audit Worker",
        password: "hash",
        skill_type: "Helper",
        skill_category_id: skillCatId,
      },
    });
    workerId = worker.id;

    // 4. Create job & requirement
    const job = await prisma.job.create({
      data: {
        customer_id: customerId,
        status: "OPEN",
        dispatch_status: "IDLE",
      },
    });
    jobId = job.id;

    const req = await prisma.job_requirement.create({
      data: {
        job_id: jobId,
        skill_id: skillCatId,
        skill_type: "Helper",
        worker_count_needed: 1,
        worker_count_filled: 1,
        status: "FILLED",
      },
    });
    requirementId = req.id;

    // 5. Create booking
    const booking = await prisma.booking.create({
      data: {
        job_id: jobId,
        requirement_id: requirementId,
        customer_id: customerId,
        worker_id: workerId,
        status: BookingStatus.CONFIRMED,
      },
    });
    bookingId = booking.id;
  });

  afterAll(async () => {
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "booking_transition" WHERE booking_id = '${bookingId}'::uuid`);
      await prisma.$executeRawUnsafe(`DELETE FROM "booking" WHERE id = '${bookingId}'::uuid`);
      await prisma.$executeRawUnsafe(`DELETE FROM "job_requirement" WHERE id = '${requirementId}'::uuid`);
      await prisma.$executeRawUnsafe(`DELETE FROM "job" WHERE id = '${jobId}'::uuid`);
      await prisma.$executeRawUnsafe(`DELETE FROM "worker" WHERE id = '${workerId}'::uuid`);
      await prisma.$executeRawUnsafe(`DELETE FROM "customer" WHERE id = '${customerId}'::uuid`);
      await prisma.$executeRawUnsafe(`DELETE FROM "skill_category" WHERE id = '${skillCatId}'::uuid`);
    } catch {
      // Cleanup best effort
    }
  });

  it("Test 1: Successful state transition atomically writes business state and mandatory audit record", async () => {
    const result = await prisma.$transaction(async (tx) => {
      return await bookingStateService.transition(tx, {
        bookingId,
        action: BookingAction.START_WORK,
        actor: { id: workerId, role: UserRole.WORKER },
        reason: "Worker started shift",
      });
    });

    expect(result.currentStatus).toBe(BookingStatus.IN_PROGRESS);
    expect(result.transitionId).toBeDefined();

    // Verify DB state for booking
    const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(dbBooking?.status).toBe(BookingStatus.IN_PROGRESS);

    // Verify DB state for transition audit
    const transitions: any[] = await prisma.$queryRawUnsafe(
      `SELECT * FROM "booking_transition" WHERE booking_id = '${bookingId}'::uuid ORDER BY created_at DESC`
    );
    expect(transitions.length).toBeGreaterThanOrEqual(1);
    const latest = transitions[0];
    expect(latest.from_status).toBe(BookingStatus.CONFIRMED);
    expect(latest.to_status).toBe(BookingStatus.IN_PROGRESS);
    expect(latest.action).toBe(BookingAction.START_WORK);
    expect(latest.actor_id).toBe(workerId);
    expect(latest.reason).toBe("Worker started shift");
  });

  it("Test 2: Failure injection on audit insertion rolls back the state transition", async () => {
    // Current booking status is IN_PROGRESS. We attempt transition to AWAITING_CONFIRMATION,
    // but inject a transaction failure immediately after or during audit creation.
    await expect(
      prisma.$transaction(async (tx) => {
        // Step 1: Update booking state
        await tx.booking.update({
          where: { id: bookingId },
          data: { status: BookingStatus.AWAITING_CONFIRMATION },
        });

        // Step 2: Inject audit failure (e.g. invalid foreign key or forced error)
        await (tx as any).booking_transition.create({
          data: {
            booking_id: "00000000-0000-0000-0000-000000000000", // Non-existent booking ID violates foreign key constraint
            from_status: BookingStatus.IN_PROGRESS,
            to_status: BookingStatus.AWAITING_CONFIRMATION,
            action: BookingAction.REQUEST_COMPLETION,
            actor_type: UserRole.WORKER,
            actor_id: workerId,
          },
        });
      })
    ).rejects.toThrow();

    // Verify booking state rolled back and remained IN_PROGRESS
    const dbBookingAfterRollback = await prisma.booking.findUnique({ where: { id: bookingId } });
    expect(dbBookingAfterRollback?.status).toBe(BookingStatus.IN_PROGRESS);

    // Verify no stray audit record exists for AWAITING_CONFIRMATION
    const transitions: any[] = await prisma.$queryRawUnsafe(
      `SELECT * FROM "booking_transition" WHERE booking_id = '${bookingId}'::uuid AND to_status = '${BookingStatus.AWAITING_CONFIRMATION}'`
    );
    expect(transitions.length).toBe(0);
  });

  it("Test 3: Audit retries do not duplicate records for already completed transitions", async () => {
    // 1. First transition IN_PROGRESS -> AWAITING_CONFIRMATION
    await prisma.$transaction(async (tx) => {
      return await bookingStateService.transition(tx, {
        bookingId,
        action: BookingAction.REQUEST_COMPLETION,
        actor: { id: workerId, role: UserRole.WORKER },
        reason: "Work completed by worker",
      });
    });

    const initialTransitions: any[] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int as count FROM "booking_transition" WHERE booking_id = '${bookingId}'::uuid`
    );
    const initialCount = initialTransitions[0].count;

    // 2. Idempotent retry of REQUEST_COMPLETION when booking is already in AWAITING_CONFIRMATION
    const retryResult = await prisma.$transaction(async (tx) => {
      return await bookingStateService.transition(tx, {
        bookingId,
        action: BookingAction.REQUEST_COMPLETION,
        actor: { id: workerId, role: UserRole.WORKER },
        reason: "Duplicate completion request",
      });
    });

    expect(retryResult.isIdempotent).toBe(true);
    expect(retryResult.currentStatus).toBe(BookingStatus.AWAITING_CONFIRMATION);

    // Verify no new audit record was created for idempotent no-op
    const afterTransitions: any[] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int as count FROM "booking_transition" WHERE booking_id = '${bookingId}'::uuid`
    );
    expect(afterTransitions[0].count).toBe(initialCount);
  });
});
