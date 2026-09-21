import { dispatchService } from "../src/features/dispatch/dispatchServices";
import prisma from "../src/config/prisma";

describe("Issue 52 - Real PostgreSQL Dispatch Concurrency & Idempotency Tests", () => {
  jest.setTimeout(45000);

  const CUSTOMER_ID = "00000000-0000-4002-a000-000000000001";
  const JOB_ID = "00000000-0000-4002-b000-000000000001";
  const REQ_ID = "00000000-0000-4002-c000-000000000001";

  // 10 test workers for concurrent acceptance race
  const workerIds: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const hex = i.toString().padStart(4, "0");
    workerIds.push(`00000000-0000-4002-d000-00000000${hex}`);
  }

  let skillCategoryId: string;

  beforeAll(async () => {
    let category = await prisma.skill_category.findFirst();
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "ConcurrencySkill", description: "Skill for concurrency tests" },
      });
    }
    skillCategoryId = category.id;

    // Seed customer
    await prisma.customer.upsert({
      where: { id: CUSTOMER_ID },
      update: { phone: "+919900000001" },
      create: { id: CUSTOMER_ID, phone: "+919900000001", name: "Concurrency Customer", password: "hash" },
    });

    // Seed 10 workers
    for (let i = 0; i < workerIds.length; i++) {
      const wId = workerIds[i];
      const phone = `+9199000001${i.toString().padStart(2, "0")}`;
      await prisma.worker.upsert({
        where: { id: wId },
        update: { phone, skill_category_id: skillCategoryId, verification_status: "verified" },
        create: {
          id: wId,
          phone,
          name: `Concurrency Worker ${i + 1}`,
          password: "hash",
          skill_type: "ConcurrencySkill",
          skill_category_id: skillCategoryId,
          verification_status: "verified",
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.booking_transition.deleteMany({ where: { booking: { requirement_id: REQ_ID } } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { requirement_id: REQ_ID } }).catch(() => {});
    await prisma.job_dispatch.deleteMany({ where: { requirement_id: REQ_ID } }).catch(() => {});
    await prisma.dispatch_wave.deleteMany({ where: { requirement_id: REQ_ID } }).catch(() => {});
    await prisma.job_requirement.deleteMany({ where: { id: REQ_ID } }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: JOB_ID } }).catch(() => {});
    await prisma.worker.deleteMany({ where: { id: { in: workerIds } } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { id: CUSTOMER_ID } }).catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean up previous test state for this requirement
    await prisma.booking_transition.deleteMany({ where: { booking: { requirement_id: REQ_ID } } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { requirement_id: REQ_ID } }).catch(() => {});
    await prisma.job_dispatch.deleteMany({ where: { requirement_id: REQ_ID } }).catch(() => {});
    await prisma.dispatch_wave.deleteMany({ where: { requirement_id: REQ_ID } }).catch(() => {});
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

    // Create Requirement with capacity = 2
    await prisma.job_requirement.create({
      data: {
        id: REQ_ID,
        job_id: JOB_ID,
        skill_id: skillCategoryId,
        skill_type: "ConcurrencySkill",
        worker_count_needed: 2,
        worker_count_filled: 0,
        status: "OPEN",
        current_wave: 1,
      },
    });

    // Create 10 dispatch invites for wave 1
    const expiry = new Date(Date.now() + 600000); // 10m future
    await prisma.job_dispatch.createMany({
      data: workerIds.map((wId, idx) => ({
        requirement_id: REQ_ID,
        worker_id: wId,
        wave_number: 1,
        wave_position: idx + 1,
        status: "pending",
        expires_at: expiry,
      })),
    });
  });

  describe("1. Simultaneous Worker Acceptance & Overbooking Invariants", () => {
    it("strictly prevents overbooking when 10 workers concurrently accept a 2-worker requirement", async () => {
      // 10 concurrent accept attempts
      const acceptPromises = workerIds.map((wId) =>
        dispatchService.acceptJob(REQ_ID, wId)
      );

      const results = await Promise.allSettled(acceptPromises);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Exactly 2 must succeed
      expect(fulfilled.length).toBe(2);
      expect(rejected.length).toBe(8);

      // Verify Database Invariants
      const requirement = await prisma.job_requirement.findUnique({
        where: { id: REQ_ID },
      });
      expect(requirement?.worker_count_filled).toBe(2);

      const bookings = await prisma.booking.findMany({
        where: { requirement_id: REQ_ID },
      });
      expect(bookings.length).toBe(2);

      // Verify worker assignments are distinct
      const assignedWorkers = new Set(bookings.map((b) => b.worker_id));
      expect(assignedWorkers.size).toBe(2);
    });
  });

  describe("2. Expired Dispatch Acceptance Protection", () => {
    it("rejects acceptance if the dispatch invitation has expired", async () => {
      // Set expires_at to past
      await prisma.job_dispatch.updateMany({
        where: { requirement_id: REQ_ID },
        data: { expires_at: new Date(Date.now() - 10000) },
      });

      await expect(
        dispatchService.acceptJob(REQ_ID, workerIds[0])
      ).rejects.toThrow();

      // Ensure zero bookings created
      const bookings = await prisma.booking.findMany({
        where: { requirement_id: REQ_ID },
      });
      expect(bookings.length).toBe(0);
    });
  });

  describe("3. Duplicate Booking Uniqueness Protection", () => {
    it("prevents the same worker from receiving multiple bookings for the same requirement", async () => {
      // Worker 1 accepts successfully
      await dispatchService.acceptJob(REQ_ID, workerIds[0]);

      // Worker 1 attempts to accept again
      await expect(
        dispatchService.acceptJob(REQ_ID, workerIds[0])
      ).rejects.toThrow();

      const bookings = await prisma.booking.findMany({
        where: { requirement_id: REQ_ID, worker_id: workerIds[0] },
      });
      expect(bookings.length).toBe(1);
    });
  });
});
