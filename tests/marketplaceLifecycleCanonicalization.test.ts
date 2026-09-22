import prisma from "../src/config/prisma";
import { JobStatus, JobAction, jobStateService, JobInvalidTransitionError } from "../src/features/jobs/jobStateMachine";
import { UserRole } from "../src/policies";

describe("P4 Issue 15: Database-Enforced Marketplace Lifecycle Canonicalization", () => {
  let customerId: string;
  let skillCatId: string;
  let jobId: string;

  beforeAll(async () => {
    const cat = await prisma.skill_category.create({
      data: { name: `LifecycleCat_${Date.now()}` },
    });
    skillCatId = cat.id;

    const cust = await prisma.customer.create({
      data: {
        phone: `+91961${String(Date.now()).slice(-7)}`,
        name: "Lifecycle Customer",
        password: "hash",
      },
    });
    customerId = cust.id;

    const job = await prisma.job.create({
      data: {
        customer_id: customerId,
        status: JobStatus.OPEN,
        dispatch_status: "IDLE",
      },
    });
    jobId = job.id;
  });

  afterAll(async () => {
    try {
      if (jobId) await prisma.$executeRawUnsafe(`DELETE FROM "job" WHERE id = '${jobId}'::uuid`);
      if (customerId) await prisma.$executeRawUnsafe(`DELETE FROM "customer" WHERE id = '${customerId}'::uuid`);
      if (skillCatId) await prisma.$executeRawUnsafe(`DELETE FROM "skill_category" WHERE id = '${skillCatId}'::uuid`);
    } catch {
      // Cleanup best effort
    }
  });

  describe("Direct Database CHECK Constraint Enforcement", () => {
    it("PostgreSQL directly rejects lowercase 'open' on job.status", async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "job" (id, customer_id, status, dispatch_status, created_at, updated_at)
           VALUES (gen_random_uuid(), '${customerId}'::uuid, 'open', 'IDLE', NOW(), NOW())`
        )
      ).rejects.toThrow();
    });

    it("PostgreSQL directly rejects arbitrary/invalid status on job.status", async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "job" (id, customer_id, status, dispatch_status, created_at, updated_at)
           VALUES (gen_random_uuid(), '${customerId}'::uuid, 'INVALID_STATUS', 'IDLE', NOW(), NOW())`
        )
      ).rejects.toThrow();
    });

    it("PostgreSQL directly rejects lowercase 'confirmed' on booking.status", async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "booking" (id, job_id, requirement_id, customer_id, worker_id, status, created_at, updated_at)
           VALUES (gen_random_uuid(), '${jobId}'::uuid, gen_random_uuid(), '${customerId}'::uuid, gen_random_uuid(), 'confirmed', NOW(), NOW())`
        )
      ).rejects.toThrow();
    });

    it("PostgreSQL directly rejects uppercase 'PENDING' on job_dispatch.status (strictly lowercase canonical)", async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "job_dispatch" (id, requirement_id, worker_id, status, created_at, updated_at)
           VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'PENDING', NOW(), NOW())`
        )
      ).rejects.toThrow();
    });

    it("PostgreSQL accepts exact canonical values", async () => {
      const canonicalJobId = "c0000000-0000-0000-0000-000000000001";
      await prisma.$executeRawUnsafe(
        `INSERT INTO "job" (id, customer_id, status, dispatch_status, created_at, updated_at)
         VALUES ('${canonicalJobId}'::uuid, '${customerId}'::uuid, 'OPEN', 'IDLE', NOW(), NOW())`
      );

      const inserted = await prisma.job.findUnique({ where: { id: canonicalJobId } });
      expect(inserted?.status).toBe("OPEN");
      expect(inserted?.dispatch_status).toBe("IDLE");

      await prisma.$executeRawUnsafe(`DELETE FROM "job" WHERE id = '${canonicalJobId}'::uuid`);
    });
  });

  describe("Application-Level State Transition Rejection", () => {
    it("State machine rejects illegal transition (e.g. CANCELLED -> START_WORK)", async () => {
      const cancelJobId = "c0000000-0000-0000-0000-000000000002";
      await prisma.$executeRawUnsafe(
        `INSERT INTO "job" (id, customer_id, status, dispatch_status, created_at, updated_at)
         VALUES ('${cancelJobId}'::uuid, '${customerId}'::uuid, 'CANCELLED', 'CANCELLED', NOW(), NOW())`
      );

      await expect(
        prisma.$transaction(async (tx) => {
          return await jobStateService.transition(tx, {
            jobId: cancelJobId,
            action: JobAction.START_WORK,
            actor: { role: UserRole.WORKER },
            reason: "Attempt start on cancelled job",
          });
        })
      ).rejects.toThrow(JobInvalidTransitionError);

      await prisma.$executeRawUnsafe(`DELETE FROM "job" WHERE id = '${cancelJobId}'::uuid`);
    });
  });
});
