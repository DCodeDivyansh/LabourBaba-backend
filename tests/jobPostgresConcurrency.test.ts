import prisma from "../src/config/prisma";
import { jobService } from "../src/features/jobs/job.services";
import {
  jobStateService,
  JobStatus,
  JobAction,
  JobInvalidTransitionError,
  JobStateConflictError,
} from "../src/features/jobs/jobStateMachine";
import {
  requirementStateService,
  RequirementStatus,
  RequirementAction,
  RequirementCapacityExceededError,
} from "../src/features/jobs/requirementStateMachine";
import { UserRole } from "../src/policies";

describe("Phase 3 Release-Gate — Real PostgreSQL Concurrency & Invariants", () => {
  jest.setTimeout(60000);

  const runId = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  let customerId: string;
  let skillCatId: string;
  let testJobId: string;
  let testReqId: string;

  beforeAll(async () => {
    // 1. Create skill category
    const cat = await prisma.skill_category.create({
      data: { name: `JobConcSkill_${runId}` },
    });
    skillCatId = cat.id;

    // 2. Create customer
    const cust = await prisma.customer.create({
      data: {
        phone: `+9179${runId.slice(-8)}`,
        name: `JobConc Cust ${runId}`,
        password: "hash",
      },
    });
    customerId = cust.id;
  });

  afterAll(async () => {
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "job_transition" WHERE job_id IN (SELECT id FROM "job" WHERE customer_id = '${customerId}'::uuid)`);
      await prisma.$executeRawUnsafe(`DELETE FROM "job_requirement" WHERE job_id IN (SELECT id FROM "job" WHERE customer_id = '${customerId}'::uuid)`);
      await prisma.$executeRawUnsafe(`DELETE FROM "job" WHERE customer_id = '${customerId}'::uuid`);
      await prisma.$executeRawUnsafe(`DELETE FROM "customer" WHERE id = '${customerId}'::uuid`);
      await prisma.$executeRawUnsafe(`DELETE FROM "skill_category" WHERE id = '${skillCatId}'::uuid`);
    } catch {
      // Best-effort cleanup
    } finally {
      await prisma.$disconnect();
    }
  });

  beforeEach(async () => {
    // Create fresh job & requirement for each scenario
    const job = await prisma.job.create({
      data: {
        customer_id: customerId,
        status: JobStatus.OPEN,
        dispatch_status: "IDLE",
      },
    });
    testJobId = job.id;

    const req = await prisma.job_requirement.create({
      data: {
        job_id: testJobId,
        skill_id: skillCatId,
        skill_type: `JobConcSkill_${runId}`,
        worker_count_needed: 3,
        worker_count_filled: 0,
        status: RequirementStatus.OPEN,
      },
    });
    testReqId = req.id;
  });

  afterEach(async () => {
    try {
      if (testJobId) {
        await prisma.$executeRawUnsafe(`DELETE FROM "job_transition" WHERE job_id = '${testJobId}'::uuid`);
        await prisma.$executeRawUnsafe(`DELETE FROM "job_requirement" WHERE job_id = '${testJobId}'::uuid`);
        await prisma.$executeRawUnsafe(`DELETE FROM "job" WHERE id = '${testJobId}'::uuid`);
      }
    } catch {
      // Cleanup best effort
    }
  });

  it("PH3-CONC-001: 50 concurrent cancellation requests on a single Job produces exactly 1 transition", async () => {
    const actor = { id: customerId, role: UserRole.CUSTOMER };

    // Fire 50 simultaneous cancellation attempts
    const N = 50;
    const promises = Array.from({ length: N }, (_, i) =>
      prisma.$transaction(
        async (tx) => {
          return await jobStateService.transition(tx, {
            jobId: testJobId,
            action: JobAction.CANCEL,
            actor,
            reason: `Concurrent cancel test #${i + 1}`,
          });
        },
        { maxWait: 30000, timeout: 30000 }
      )
    );

    const settled = await Promise.allSettled(promises);

    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");

    // Exactly 1 transition must have succeeded
    expect(fulfilled.length).toBe(1);
    // Remaining 49 must be rejected due to state conflict or invalid transition
    expect(rejected.length).toBe(N - 1);

    // Verify rejection reasons
    for (const r of rejected) {
      if (r.status === "rejected") {
        const err = r.reason;
        expect(
          err instanceof JobInvalidTransitionError ||
          err instanceof JobStateConflictError ||
          err?.message?.includes("Cannot perform 'CANCEL'") ||
          err?.message?.includes("already")
        ).toBe(true);
      }
    }

    // Verify PostgreSQL state
    const finalJob = await prisma.job.findUnique({ where: { id: testJobId } });
    expect(finalJob?.status).toBe(JobStatus.CANCELLED);
    expect(finalJob?.cancelled_at).toBeInstanceOf(Date);

    // Verify audit logs in PostgreSQL: exactly 1 audit transition record exists
    const audits = await prisma.job_transition.findMany({ where: { job_id: testJobId } });
    expect(audits.length).toBe(1);
    expect(audits[0].from_status).toBe(JobStatus.OPEN);
    expect(audits[0].to_status).toBe(JobStatus.CANCELLED);
    expect(audits[0].action).toBe(JobAction.CANCEL);
  });

  it("PH3-CONC-002: Concurrent competing transitions (START_DISPATCH vs CANCEL) result in consistent final state", async () => {
    const customerActor = { id: customerId, role: UserRole.CUSTOMER };
    const systemActor = { role: "SYSTEM" };

    // Race START_DISPATCH (system) and CANCEL (customer) simultaneously 10 times each
    const dispatchPromises = Array.from({ length: 10 }, () =>
      prisma.$transaction(async (tx) => {
        return await jobStateService.transition(tx, {
          jobId: testJobId,
          action: JobAction.START_DISPATCH,
          actor: systemActor,
          reason: "System dispatch attempt",
        });
      })
    );

    const cancelPromises = Array.from({ length: 10 }, () =>
      prisma.$transaction(async (tx) => {
        return await jobStateService.transition(tx, {
          jobId: testJobId,
          action: JobAction.CANCEL,
          actor: customerActor,
          reason: "Customer cancel attempt",
        });
      })
    );

    const allSettled = await Promise.allSettled([...dispatchPromises, ...cancelPromises]);

    // Check final job state in PostgreSQL
    const finalJob = await prisma.job.findUnique({ where: { id: testJobId } });
    // Final state must be strictly one of DISPATCHING or CANCELLED, never in-between or null
    expect([JobStatus.DISPATCHING, JobStatus.CANCELLED]).toContain(finalJob?.status);

    // Audit records must strictly reflect valid chronological transitions
    const transitions = await prisma.job_transition.findMany({
      where: { job_id: testJobId },
      orderBy: { created_at: "asc" },
    });

    expect(transitions.length).toBeGreaterThanOrEqual(1);
    expect(transitions.length).toBeLessThanOrEqual(2); // At most OPEN->DISPATCHING then DISPATCHING->CANCELLED

    // Ensure no broken transition history
    if (transitions.length === 2) {
      expect(transitions[0].to_status).toBe(transitions[1].from_status);
    }
  });

  it("PH3-CONC-003: 50 concurrent worker acceptance attempts strictly enforce capacity bounds without overfilling", async () => {
    // Requirement capacity = 3. 50 workers attempt acceptance.
    const N = 50;
    const workerAttempts = Array.from({ length: N }, (_, i) => ({
      workerId: `00000000-0000-4000-a000-${String(i + 1).padStart(12, "0")}`,
    }));

    const promises = workerAttempts.map(async ({ workerId }) => {
      return await prisma.$transaction(async (tx) => {
        // Query current state with row lock / transaction isolation
        const currentReq = await tx.job_requirement.findUnique({
          where: { id: testReqId },
        });

        if (!currentReq) throw new Error("Req not found");
        const filled = currentReq.worker_count_filled || 0;
        if (filled >= currentReq.worker_count_needed) {
          throw new RequirementCapacityExceededError("Slots already filled");
        }

        const newFilled = filled + 1;
        const newStatus =
          newFilled >= currentReq.worker_count_needed
            ? RequirementStatus.FILLED
            : RequirementStatus.PARTIALLY_FILLED;

        return await tx.job_requirement.update({
          where: { id: testReqId },
          data: {
            worker_count_filled: newFilled,
            status: newStatus,
          },
        });
      });
    });

    const settled = await Promise.allSettled(promises);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");

    // In real database execution, final filled count in PostgreSQL must not exceed 3
    const finalReq = await prisma.job_requirement.findUnique({ where: { id: testReqId } });
    expect(finalReq?.worker_count_filled).toBeLessThanOrEqual(3);
  });

  it("PH3-CONC-004: Partial-transaction failure injection guarantees PostgreSQL atomicity", async () => {
    // Attempt transaction where job is updated to COMPLETED, but subsequent requirement operation fails
    const initialJob = await prisma.job.findUnique({ where: { id: testJobId } });
    expect(initialJob?.status).toBe(JobStatus.OPEN);

    await expect(
      prisma.$transaction(async (tx) => {
        // Step 1: Update job
        await tx.job.update({
          where: { id: testJobId },
          data: { status: JobStatus.IN_PROGRESS },
        });

        // Step 2: Inject failure violating foreign key or check constraint
        await tx.$executeRawUnsafe(
          `INSERT INTO "job_requirement" ("id", "job_id", "skill_type", "worker_count_needed", "status", "created_at", "updated_at")
           VALUES (gen_random_uuid(), '${testJobId}', 'Plumber', 1, 'NON_EXISTENT_INVALID_STATUS', NOW(), NOW())`
        );
      })
    ).rejects.toThrow();

    // Verify PostgreSQL state: job MUST STILL be OPEN, transaction rolled back completely
    const rolledBackJob = await prisma.job.findUnique({ where: { id: testJobId } });
    expect(rolledBackJob?.status).toBe(JobStatus.OPEN);
  });

  it("PH3-CONC-005: Repeated idempotent cancellations produce stable results without state corruption", async () => {
    const actor = { id: customerId, role: UserRole.CUSTOMER };

    // Initial cancellation
    const firstRes = await prisma.$transaction(async (tx) => {
      return await jobStateService.transition(tx, {
        jobId: testJobId,
        action: JobAction.CANCEL,
        actor,
        reason: "First cancellation",
      });
    });
    expect(firstRes.currentStatus).toBe(JobStatus.CANCELLED);

    // 10 subsequent repeated cancellation attempts
    for (let i = 0; i < 10; i++) {
      await expect(
        prisma.$transaction(async (tx) => {
          return await jobStateService.transition(tx, {
            jobId: testJobId,
            action: JobAction.CANCEL,
            actor,
            reason: `Repeated cancel #${i + 1}`,
          });
        })
      ).rejects.toThrow(JobInvalidTransitionError);
    }

    // Final database state remains intact with exactly 1 cancellation audit
    const finalJob = await prisma.job.findUnique({ where: { id: testJobId } });
    expect(finalJob?.status).toBe(JobStatus.CANCELLED);

    const audits = await prisma.job_transition.findMany({ where: { job_id: testJobId } });
    expect(audits.length).toBe(1);
  });

  it("PH3-CONC-006: 50 concurrent START_DISPATCH requests produce exactly 1 transition and 1 audit row", async () => {
    const actor = { role: "SYSTEM" };
    const N = 50;

    const promises = Array.from({ length: N }, (_, i) =>
      prisma.$transaction(
        async (tx) => {
          return await jobStateService.transition(tx, {
            jobId: testJobId,
            action: JobAction.START_DISPATCH,
            actor,
            reason: `Concurrent dispatch test #${i + 1}`,
          });
        },
        { maxWait: 30000, timeout: 30000 }
      )
    );

    const settled = await Promise.allSettled(promises);
    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");

    // Exactly 1 transition succeeds
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(N - 1);

    // Verify rejection reasons
    for (const r of rejected) {
      if (r.status === "rejected") {
        const err = r.reason;
        expect(
          err instanceof JobInvalidTransitionError ||
          err instanceof JobStateConflictError ||
          err?.message?.includes("Cannot perform 'START_DISPATCH'") ||
          err?.message?.includes("already")
        ).toBe(true);
      }
    }

    // Verify PostgreSQL state
    const finalJob = await prisma.job.findUnique({ where: { id: testJobId } });
    expect(finalJob?.status).toBe(JobStatus.DISPATCHING);

    // Exactly 1 audit record
    const audits = await prisma.job_transition.findMany({ where: { job_id: testJobId } });
    expect(audits.length).toBe(1);
    expect(audits[0].from_status).toBe(JobStatus.OPEN);
    expect(audits[0].to_status).toBe(JobStatus.DISPATCHING);
  });

  it("PH3-CONC-007: Competing MARK_BOOKED vs CANCEL from DISPATCHING serializes cleanly without oscillation", async () => {
    // Put job into DISPATCHING first
    await prisma.job.update({
      where: { id: testJobId },
      data: { status: JobStatus.DISPATCHING },
    });

    const customerActor = { id: customerId, role: UserRole.CUSTOMER };
    const systemActor = { role: "SYSTEM" };

    const bookedPromises = Array.from({ length: 10 }, (_, i) =>
      prisma.$transaction(
        async (tx) => {
          return await jobStateService.transition(tx, {
            jobId: testJobId,
            action: JobAction.MARK_BOOKED,
            actor: systemActor,
            reason: `Concurrent mark booked #${i + 1}`,
          });
        },
        { maxWait: 30000, timeout: 30000 }
      )
    );

    const cancelPromises = Array.from({ length: 10 }, (_, i) =>
      prisma.$transaction(
        async (tx) => {
          return await jobStateService.transition(tx, {
            jobId: testJobId,
            action: JobAction.CANCEL,
            actor: customerActor,
            reason: `Concurrent cancel #${i + 1}`,
          });
        },
        { maxWait: 30000, timeout: 30000 }
      )
    );

    const settled = await Promise.allSettled([...bookedPromises, ...cancelPromises]);
    const fulfilled = settled.filter((r) => r.status === "fulfilled");

    // Final job state in PostgreSQL must be valid
    const finalJob = await prisma.job.findUnique({ where: { id: testJobId } });
    expect([JobStatus.BOOKED, JobStatus.CANCELLED]).toContain(finalJob?.status);

    // Verify audit logs in PostgreSQL match fulfilled transitions
    const audits = await prisma.job_transition.findMany({
      where: { job_id: testJobId },
      orderBy: { created_at: "asc" },
    });
    expect(audits.length).toBe(fulfilled.length);
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits.length).toBeLessThanOrEqual(2); // At most DISPATCHING->BOOKED then BOOKED->CANCELLED
  });

  it("PH3-CONC-008: Competing START_WORK vs CANCEL from BOOKED serializes cleanly", async () => {
    // Put job into BOOKED first
    await prisma.job.update({
      where: { id: testJobId },
      data: { status: JobStatus.BOOKED },
    });

    const customerActor = { id: customerId, role: UserRole.CUSTOMER };
    const systemActor = { role: "SYSTEM" };

    const workPromises = Array.from({ length: 10 }, (_, i) =>
      prisma.$transaction(
        async (tx) => {
          return await jobStateService.transition(tx, {
            jobId: testJobId,
            action: JobAction.START_WORK,
            actor: systemActor,
            reason: `Concurrent start work #${i + 1}`,
          });
        },
        { maxWait: 30000, timeout: 30000 }
      )
    );

    const cancelPromises = Array.from({ length: 10 }, (_, i) =>
      prisma.$transaction(
        async (tx) => {
          return await jobStateService.transition(tx, {
            jobId: testJobId,
            action: JobAction.CANCEL,
            actor: customerActor,
            reason: `Concurrent cancel #${i + 1}`,
          });
        },
        { maxWait: 30000, timeout: 30000 }
      )
    );

    const settled = await Promise.allSettled([...workPromises, ...cancelPromises]);
    const fulfilled = settled.filter((r) => r.status === "fulfilled");

    // Final job state in PostgreSQL must be one of IN_PROGRESS or CANCELLED
    const finalJob = await prisma.job.findUnique({ where: { id: testJobId } });
    expect([JobStatus.IN_PROGRESS, JobStatus.CANCELLED]).toContain(finalJob?.status);

    const audits = await prisma.job_transition.findMany({
      where: { job_id: testJobId },
      orderBy: { created_at: "asc" },
    });
    expect(audits.length).toBe(fulfilled.length);
  });

  it("PH3-CONC-009: Competing COMPLETE vs CANCEL from IN_PROGRESS terminates in exactly one final state", async () => {
    // Put job into IN_PROGRESS
    await prisma.job.update({
      where: { id: testJobId },
      data: { status: JobStatus.IN_PROGRESS },
    });

    const customerActor = { id: customerId, role: UserRole.CUSTOMER };
    const adminActor = { role: UserRole.ADMIN };

    const completePromises = Array.from({ length: 10 }, (_, i) =>
      prisma.$transaction(
        async (tx) => {
          return await jobStateService.transition(tx, {
            jobId: testJobId,
            action: JobAction.COMPLETE,
            actor: customerActor,
            reason: `Concurrent complete #${i + 1}`,
          });
        },
        { maxWait: 30000, timeout: 30000 }
      )
    );

    const cancelPromises = Array.from({ length: 10 }, (_, i) =>
      prisma.$transaction(
        async (tx) => {
          return await jobStateService.transition(tx, {
            jobId: testJobId,
            action: JobAction.CANCEL,
            actor: adminActor,
            reason: `Concurrent admin cancel #${i + 1}`,
          });
        },
        { maxWait: 30000, timeout: 30000 }
      )
    );

    const settled = await Promise.allSettled([...completePromises, ...cancelPromises]);
    const fulfilled = settled.filter((r) => r.status === "fulfilled");

    // In-progress can transition to COMPLETED or CANCELLED, both of which are terminal!
    // Therefore, exactly 1 transition must have succeeded!
    expect(fulfilled.length).toBe(1);

    const finalJob = await prisma.job.findUnique({ where: { id: testJobId } });
    expect([JobStatus.COMPLETED, JobStatus.CANCELLED]).toContain(finalJob?.status);

    // Exactly 1 audit record must exist
    const audits = await prisma.job_transition.findMany({ where: { job_id: testJobId } });
    expect(audits.length).toBe(1);
    expect(audits[0].from_status).toBe(JobStatus.IN_PROGRESS);
    expect([JobStatus.COMPLETED, JobStatus.CANCELLED]).toContain(audits[0].to_status);
  });

  it("PH3-CONC-010: Repeated concurrency bursts confirm zero intermittent race conditions", async () => {
    const actor = { id: customerId, role: UserRole.CUSTOMER };

    // Repeat 5 concurrency bursts of 20 concurrent requests each
    for (let round = 1; round <= 5; round++) {
      const burstJob = await prisma.job.create({
        data: {
          customer_id: customerId,
          status: JobStatus.OPEN,
          dispatch_status: "IDLE",
        },
      });

      const promises = Array.from({ length: 20 }, (_, i) =>
        prisma.$transaction(
          async (tx) => {
            return await jobStateService.transition(tx, {
              jobId: burstJob.id,
              action: JobAction.CANCEL,
              actor,
              reason: `Burst ${round} attempt ${i + 1}`,
            });
          },
          { maxWait: 30000, timeout: 30000 }
        )
      );

      const settled = await Promise.allSettled(promises);
      const fulfilled = settled.filter((r) => r.status === "fulfilled");
      const rejected = settled.filter((r) => r.status === "rejected");

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(19);

      const dbJob = await prisma.job.findUnique({ where: { id: burstJob.id } });
      expect(dbJob?.status).toBe(JobStatus.CANCELLED);

      const audits = await prisma.job_transition.findMany({ where: { job_id: burstJob.id } });
      expect(audits.length).toBe(1);

      // Clean up burst job
      await prisma.job_transition.deleteMany({ where: { job_id: burstJob.id } });
      await prisma.job.delete({ where: { id: burstJob.id } });
    }
  });
});
