/**
 * Issue #24 — real PostgreSQL capacity proof.
 *
 * These tests intentionally use the production acceptance service and a real
 * PostgreSQL database. They do not mock Prisma, locks, or capacity state.
 */
import prisma from "../src/config/prisma";
import { acceptDispatch, DispatchAcceptanceError } from "../src/features/dispatch/dispatchServices";

describe("Issue #24: PostgreSQL booking-capacity concurrency", () => {
  const runId = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  let categoryId: string;
  let customerId: string;
  let jobId: string;
  const workerIds: string[] = [];
  const requirementIds: string[] = [];

  beforeAll(async () => {
    const category = await prisma.skill_category.create({
      data: { name: `Issue 24 ${runId}` },
    });
    categoryId = category.id;
    const customer = await prisma.customer.create({
      data: {
        phone: `+9177${runId.slice(-8)}`,
        name: "Issue 24 Capacity Test Customer",
        password: "not-used-by-test",
      },
    });
    customerId = customer.id;
    const job = await prisma.job.create({
      data: { customer_id: customerId, status: "OPEN", location: "PostgreSQL test" },
    });
    jobId = job.id;
  }, 30000);

  afterAll(async () => {
    try {
      await prisma.booking.deleteMany({ where: { OR: [{ requirement_id: { in: requirementIds } }, { job_id: jobId }] } });
      await prisma.job_dispatch.deleteMany({ where: { requirement_id: { in: requirementIds } } });
      await prisma.dispatch_wave.deleteMany({ where: { requirement_id: { in: requirementIds } } });
      await prisma.job_requirement.deleteMany({ where: { OR: [{ id: { in: requirementIds } }, { job_id: jobId }] } });
      await prisma.job.deleteMany({ where: { id: jobId } });
      await prisma.worker.deleteMany({ where: { id: { in: workerIds } } });
      await prisma.customer.deleteMany({ where: { id: customerId } });
      await prisma.skill_category.deleteMany({ where: { id: categoryId } });
    } finally {
      await prisma.$disconnect();
    }
  }, 30000);

  async function runRace(capacity: number, workerCount = 50) {
    const requirement = await prisma.job_requirement.create({
      data: {
        job_id: jobId,
        skill_type: "Issue 24 Labor",
        worker_count_needed: capacity,
        worker_count_filled: 0,
        status: "DISPATCHING",
      },
    });
    requirementIds.push(requirement.id);

    const workers = [] as Array<{ id: string }>;
    // Fixture writes are intentionally sequential. The test's concurrency is
    // exclusively the acceptance operation, not foreign-key fixture setup.
    for (let index = 0; index < workerCount; index += 1) {
      const worker = await prisma.worker.create({
        data: {
          phone: `+918${runId.slice(-7)}${String(requirementIds.length).padStart(2, "0")}${String(index).padStart(2, "0")}`,
          name: `Issue 24 Worker ${requirementIds.length}-${index}`,
          password: "not-used-by-test",
          skill_type: "Issue 24 Labor",
          skill_category_id: categoryId,
          is_online: true,
        },
      });
      workerIds.push(worker.id);
      await prisma.job_dispatch.create({
        data: {
          requirement_id: requirement.id,
          worker_id: worker.id,
          status: "pending",
          expires_at: new Date(Date.now() + 60_000),
        },
      });
      workers.push(worker);
    }

    const outcomes = await Promise.allSettled(
      workers.map((worker) => acceptDispatch(requirement.id, worker.id)),
    );
    const successful = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");

    for (const rejectedOutcome of rejected) {
      const error = (rejectedOutcome as PromiseRejectedResult).reason;
      expect(error).toBeInstanceOf(DispatchAcceptanceError);
      expect((error as DispatchAcceptanceError).statusCode).toBe(409);
      expect(["SLOTS_FULL", "BOOKING_ALREADY_EXISTS", "DISPATCH_ALREADY_ACCEPTED"]).toContain(
        (error as DispatchAcceptanceError).code,
      );
    }

    const [freshRequirement, bookingCount, duplicateCount] = await Promise.all([
      prisma.job_requirement.findUniqueOrThrow({ where: { id: requirement.id } }),
      prisma.booking.count({ where: { requirement_id: requirement.id } }),
      prisma.$queryRaw<Array<{ duplicates: bigint }>>`
        SELECT COUNT(*)::bigint AS duplicates
        FROM (
          SELECT requirement_id, worker_id
          FROM booking
          WHERE requirement_id = ${requirement.id}::uuid
          GROUP BY requirement_id, worker_id
          HAVING COUNT(*) > 1
        ) duplicate_bookings
      `,
    ]);

    const expectedSuccessful = Math.min(capacity, workerCount);
    expect(successful).toHaveLength(expectedSuccessful);
    expect(bookingCount).toBe(expectedSuccessful);
    expect(freshRequirement.worker_count_filled).toBe(expectedSuccessful);
    expect(freshRequirement.worker_count_filled!).toBeLessThanOrEqual(freshRequirement.worker_count_needed);
    expect(freshRequirement.worker_count_needed - freshRequirement.worker_count_filled!).toBeGreaterThanOrEqual(0);
    expect(Number(duplicateCount[0].duplicates)).toBe(0);
    return { requirement, workers, outcomes };
  }

  it("allows exactly 2 of 50 concurrent accepts and never overbooks", async () => {
    await runRace(2);
  }, 60000);

  it("enforces 1, 2, and 10 slot capacity under 50 simultaneous accepts", async () => {
    await runRace(1);
    await runRace(2);
    await runRace(10);
  }, 120000);

  it("turns concurrent same-worker retries into one booking and a controlled conflict", async () => {
    const { requirement, workers, outcomes } = await runRace(2, 1);
    // The first helper call consumed one slot. Two further simultaneous retries
    // must neither consume the remaining slot nor create another booking.
    const retries = await Promise.allSettled([
      acceptDispatch(requirement.id, workers[0].id),
      acceptDispatch(requirement.id, workers[0].id),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(retries.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(0);
    const [bookings, freshRequirement] = await Promise.all([
      prisma.booking.count({ where: { requirement_id: requirement.id, worker_id: workers[0].id } }),
      prisma.job_requirement.findUniqueOrThrow({ where: { id: requirement.id } }),
    ]);
    expect(bookings).toBe(1);
    expect(freshRequirement.worker_count_filled).toBe(1);
  }, 60000);
});
