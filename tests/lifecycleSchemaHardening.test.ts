/**
 * Issue #31 — Lifecycle Schema Hardening Integration Tests
 *
 * Tests the real PostgreSQL database invariants for:
 * 1. Valid lifecycle state persistence.
 * 2. Database CHECK constraint enforcement against invalid/typoed states.
 * 3. NOT NULL constraints on required lifecycle columns.
 * 4. Default state assignment on new row creation.
 * 5. @updatedAt automatic mutation tracking.
 */
import prisma from '../src/config/prisma';

describe('Issue #31: Harden Lifecycle Schema Fields & Database Invariants', () => {
  jest.setTimeout(30000);
  const runId = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  let categoryId: string;
  let customerId: string;
  let workerId: string;
  let jobId: string;
  let requirementId: string;

  beforeAll(async () => {
    const category = await prisma.skill_category.create({
      data: { name: `LifecycleCat_${runId}` },
    });
    categoryId = category.id;

    const customer = await prisma.customer.create({
      data: {
        phone: `+9176${runId.slice(-8)}`,
        name: `Lifecycle Customer ${runId}`,
        password: 'password123',
      },
    });
    customerId = customer.id;

    const worker = await prisma.worker.create({
      data: {
        phone: `+9186${runId.slice(-8)}`,
        name: `Lifecycle Worker ${runId}`,
        password: 'password123',
        skill_type: `LifecycleCat_${runId}`,
        skill_category_id: categoryId,
        verification_status: 'pending',
      },
    });
    workerId = worker.id;

    const job = await prisma.job.create({
      data: {
        customer_id: customerId,
        status: 'OPEN',
        dispatch_status: 'IDLE',
      },
    });
    jobId = job.id;

    const requirement = await prisma.job_requirement.create({
      data: {
        job_id: jobId,
        skill_type: `LifecycleCat_${runId}`,
        skill_id: categoryId,
        worker_count_needed: 1,
        status: 'OPEN',
      },
    });
    requirementId = requirement.id;
  }, 30000);

  afterAll(async () => {
    try {
      await prisma.booking.deleteMany({ where: { OR: [{ requirement_id: requirementId }, { job_id: jobId }] } });
      await prisma.job_dispatch.deleteMany({ where: { requirement_id: requirementId } });
      await prisma.dispatch_wave.deleteMany({ where: { requirement_id: requirementId } });
      await prisma.job_requirement.deleteMany({ where: { id: requirementId } });
      await prisma.job.deleteMany({ where: { id: jobId } });
      await prisma.worker_skill.deleteMany({ where: { worker_id: workerId } });
      await prisma.worker.deleteMany({ where: { id: workerId } });
      await prisma.customer.deleteMany({ where: { id: customerId } });
      await prisma.skill_category.deleteMany({ where: { id: categoryId } });
    } finally {
      await prisma.$disconnect();
    }
  }, 30000);

  describe('A. Defaults & NOT NULL Enforcement', () => {
    it('MUST assign default status on newly created job if not provided', async () => {
      const createdJob = await prisma.job.create({
        data: {
          customer_id: customerId,
        },
      });

      expect(createdJob.status).toBe('OPEN');
      expect(createdJob.dispatch_status).toBe('IDLE');
      expect(createdJob.created_at).toBeInstanceOf(Date);
      expect(createdJob.updated_at).toBeInstanceOf(Date);

      await prisma.job.delete({ where: { id: createdJob.id } });
    });

    it('MUST assign default status on newly created booking if not provided', async () => {
      const createdBooking = await prisma.booking.create({
        data: {
          job_id: jobId,
          requirement_id: requirementId,
          worker_id: workerId,
          customer_id: customerId,
        },
      });

      expect(createdBooking.status).toBe('CONFIRMED');
      expect(createdBooking.created_at).toBeInstanceOf(Date);
      expect(createdBooking.updated_at).toBeInstanceOf(Date);

      await prisma.booking.delete({ where: { id: createdBooking.id } });
    });

    it('MUST reject NULL for job status at the database layer', async () => {
      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO "job" ("id", "customer_id", "status", "created_at", "updated_at")
          VALUES (gen_random_uuid(), '${customerId}', NULL, NOW(), NOW());
        `)
      ).rejects.toThrow();
    });

    it('MUST reject NULL for booking status at the database layer', async () => {
      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO "booking" ("id", "job_id", "requirement_id", "worker_id", "customer_id", "status", "created_at", "updated_at")
          VALUES (gen_random_uuid(), '${jobId}', '${requirementId}', '${workerId}', '${customerId}', NULL, NOW(), NOW());
        `)
      ).rejects.toThrow();
    });

    it('MUST reject NULL for worker verification_status at the database layer', async () => {
      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO "worker" ("id", "skill_category_id", "phone", "skill_type", "password", "name", "verification_status")
          VALUES (gen_random_uuid(), '${categoryId}', '+919999999999', 'Plumber', 'pass', 'Test', NULL);
        `)
      ).rejects.toThrow();
    });
  });

  describe('B. Database CHECK Constraint Enforcement', () => {
    it('MUST reject invalid status for job at the database level', async () => {
      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO "job" ("id", "customer_id", "status", "created_at", "updated_at")
          VALUES (gen_random_uuid(), '${customerId}', 'INVALID_TYPO_STATUS', NOW(), NOW());
        `)
      ).rejects.toThrow(/chk_job_status|check constraint/i);
    });

    it('MUST reject invalid status for booking at the database level', async () => {
      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO "booking" ("id", "job_id", "requirement_id", "worker_id", "customer_id", "status", "created_at", "updated_at")
          VALUES (gen_random_uuid(), '${jobId}', '${requirementId}', '${workerId}', '${customerId}', 'GARBAGE_STATUS', NOW(), NOW());
        `)
      ).rejects.toThrow(/chk_booking_status|check constraint/i);
    });

    it('MUST reject invalid status for worker verification_status at the database level', async () => {
      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO "worker" ("id", "skill_category_id", "phone", "skill_type", "password", "name", "verification_status")
          VALUES (gen_random_uuid(), '${categoryId}', '+919999999998', 'Plumber', 'pass', 'Test', 'unverified_bogus');
        `)
      ).rejects.toThrow(/chk_worker_verification_status|check constraint/i);
    });

    it('MUST reject invalid status for job_requirement at the database level', async () => {
      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO "job_requirement" ("id", "job_id", "skill_type", "worker_count_needed", "status", "created_at", "updated_at")
          VALUES (gen_random_uuid(), '${jobId}', 'Plumber', 1, 'NOT_A_REAL_STATUS', NOW(), NOW());
        `)
      ).rejects.toThrow(/chk_job_requirement_status|check constraint/i);
    });

    it('MUST accept all canonical Job status values', async () => {
      const statuses = ['OPEN', 'DISPATCHING', 'BOOKED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];
      for (const st of statuses) {
        const updated = await prisma.job.update({
          where: { id: jobId },
          data: { status: st },
        });
        expect(updated.status).toBe(st);
      }
    });

    it('MUST accept all canonical Booking status values', async () => {
      const testBooking = await prisma.booking.create({
        data: {
          job_id: jobId,
          requirement_id: requirementId,
          worker_id: workerId,
          customer_id: customerId,
          status: 'CONFIRMED',
        },
      });

      const statuses = ['CONFIRMED', 'IN_PROGRESS', 'AWAITING_CONFIRMATION', 'COMPLETED'];
      for (const st of statuses) {
        const updated = await prisma.booking.update({
          where: { id: testBooking.id },
          data: { status: st },
        });
        expect(updated.status).toBe(st);
      }

      // Transition to CANCELLED satisfies chk_booking_cancellation_audit constraint
      const cancelledBooking = await prisma.booking.update({
        where: { id: testBooking.id },
        data: {
          status: 'CANCELLED',
          cancelled_at: new Date(),
          cancelled_by: 'CUSTOMER',
          cancellation_reason: 'Testing cancellation audit',
        },
      });
      expect(cancelledBooking.status).toBe('CANCELLED');

      await prisma.booking.delete({ where: { id: testBooking.id } });
    });
  });

  describe('C. @updatedAt Automatic Mutation Tracking', () => {
    it('MUST automatically advance updated_at on job mutation', async () => {
      const initialJob = await prisma.job.findUniqueOrThrow({ where: { id: jobId } });
      const initialUpdatedAt = initialJob.updated_at.getTime();

      // Wait 100ms to guarantee timestamp advancement
      await new Promise((resolve) => setTimeout(resolve, 100));

      const updatedJob = await prisma.job.update({
        where: { id: jobId },
        data: { location: `Updated Location ${Date.now()}` },
      });

      expect(updatedJob.updated_at.getTime()).toBeGreaterThan(initialUpdatedAt);
    });

    it('MUST automatically advance updated_at on job_requirement mutation', async () => {
      const initialReq = await prisma.job_requirement.findUniqueOrThrow({ where: { id: requirementId } });
      const initialUpdatedAt = initialReq.updated_at.getTime();

      await new Promise((resolve) => setTimeout(resolve, 100));

      const updatedReq = await prisma.job_requirement.update({
        where: { id: requirementId },
        data: { rate_per_day: 550 },
      });

      expect(updatedReq.updated_at.getTime()).toBeGreaterThan(initialUpdatedAt);
    });

    it('MUST automatically advance updated_at on skill_category mutation', async () => {
      const initialCat = await prisma.skill_category.findUniqueOrThrow({ where: { id: categoryId } });
      const initialUpdatedAt = initialCat.updated_at.getTime();

      await new Promise((resolve) => setTimeout(resolve, 100));

      const updatedCat = await prisma.skill_category.update({
        where: { id: categoryId },
        data: { is_active: true },
      });

      expect(updatedCat.updated_at.getTime()).toBeGreaterThan(initialUpdatedAt);
    });
  });
});
