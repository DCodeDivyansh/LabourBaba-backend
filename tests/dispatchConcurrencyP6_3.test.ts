/**
 * LabourBaba Backend — P6 Issue 3 Concurrency Verification Suite
 *
 * PROOF OF CONCURRENCY INVARIANTS AGAINST REAL POSTGRESQL + POSTGIS
 *
 * Core Market Invariant Under Test:
 *   For any requirement:
 *   successful worker assignments/bookings MUST NEVER exceed the authoritative required capacity.
 *   Y <= X at all times, with zero duplicate worker assignments, zero overbooking,
 *   zero negative capacity, and atomic cross-entity consistency.
 */

import prisma from "../src/config/prisma";
import { acceptDispatch, DispatchAcceptanceError } from "../src/features/dispatch/dispatchServices";
import { jobService } from "../src/features/jobs/job.services";
import { RequirementStatus } from "../src/features/jobs/requirementStateMachine";
import { processTimeoutJob } from "../src/workers/timeoutWorker";
import { app, io } from "../src/server";
import { signAccessToken } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";
import request from "supertest";
import crypto from "crypto";

// Extend timeout for heavy concurrent tests against real PostgreSQL
jest.setTimeout(400000);

describe("LabourBaba Backend — P6 Issue 3: Concurrent Dispatch & Worker Acceptance Runtime Proof", () => {
  const suiteId = crypto.randomBytes(4).toString("hex");
  let sharedCategoryId: string;
  let sharedCustomerId: string;

  beforeAll(async () => {
    // Verify real PostgreSQL connection
    const pgCheck = await prisma.$queryRawUnsafe<any[]>("SELECT version(), postgis_full_version()");
    expect(pgCheck).toBeDefined();
    expect(pgCheck.length).toBeGreaterThan(0);

    const category = await prisma.skill_category.create({
      data: { name: `P6-3 Cat ${suiteId}` },
    });
    sharedCategoryId = category.id;

    const customer = await prisma.customer.create({
      data: {
        phone: `+9171${suiteId.slice(-8)}`,
        name: "P6-3 Concurrency Customer",
        password: "hash",
      },
    });
    sharedCustomerId = customer.id;
  });

  afterAll(async () => {
    try {
      if (sharedCustomerId) {
        await prisma.customer.delete({ where: { id: sharedCustomerId } }).catch(() => {});
      }
      if (sharedCategoryId) {
        await prisma.skill_category.delete({ where: { id: sharedCategoryId } }).catch(() => {});
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  // Helper to create test workers
  async function createWorkers(count: number, prefix: string): Promise<Array<{ id: string; name: string }>> {
    const workers: Array<{ id: string; name: string }> = [];
    for (let i = 0; i < count; i++) {
      const randPhone = `+91${Math.floor(1000000000 + Math.random() * 9000000000)}`;
      const worker = await prisma.worker.create({
        data: {
          phone: randPhone,
          name: `${prefix} Worker ${i}`,
          password: "hash",
          skill_type: "Labor",
          skill_category_id: sharedCategoryId,
          is_online: true,
        },
      });
      workers.push({ id: worker.id, name: worker.name });
    }
    return workers;
  }

  // Helper to set up a job and requirement with dispatches
  async function setupJobAndDispatches(capacity: number, workers: Array<{ id: string }>) {
    const job = await prisma.job.create({
      data: {
        customer_id: sharedCustomerId,
        status: "DISPATCHING",
        location: "P6-3 Test Location",
      },
    });

    const requirement = await prisma.job_requirement.create({
      data: {
        job_id: job.id,
        skill_type: "Labor",
        worker_count_needed: capacity,
        worker_count_filled: 0,
        status: "DISPATCHING",
      },
    });

    for (let i = 0; i < workers.length; i++) {
      await prisma.job_dispatch.create({
        data: {
          requirement_id: requirement.id,
          worker_id: workers[i].id,
          wave_number: 1,
          wave_position: i + 1,
          status: "pending",
          expires_at: new Date(Date.now() + 120000), // 2 min expiry
        },
      });
    }

    return { job, requirement };
  }

  // Helper to clean up a test run
  async function cleanupRun(requirementId: string, jobId: string, workerIds: string[]) {
    try {
      await prisma.booking.deleteMany({ where: { requirement_id: requirementId } }).catch(() => {});
      await prisma.job_dispatch.deleteMany({ where: { requirement_id: requirementId } }).catch(() => {});
      await prisma.job_requirement.delete({ where: { id: requirementId } }).catch(() => {});
      await prisma.job.delete({ where: { id: jobId } }).catch(() => {});
      if (workerIds.length > 0) {
        await prisma.worker.deleteMany({ where: { id: { in: workerIds } } }).catch(() => {});
      }
    } catch (e) {
      // Ignore cleanup error
    }
  }

  // Helper to verify PostgreSQL invariants directly
  async function verifyPostgreSqlInvariants(requirementId: string, expectedCapacity: number) {
    const [req, bookingCount, uniqueWorkers, duplicates] = await Promise.all([
      prisma.job_requirement.findUniqueOrThrow({ where: { id: requirementId } }),
      prisma.booking.count({ where: { requirement_id: requirementId } }),
      prisma.booking.findMany({
        where: { requirement_id: requirementId },
        select: { worker_id: true },
        distinct: ["worker_id"],
      }),
      prisma.$queryRaw<Array<{ duplicates: bigint }>>`
        SELECT COUNT(*)::bigint AS duplicates
        FROM (
          SELECT requirement_id, worker_id
          FROM booking
          WHERE requirement_id = ${requirementId}::uuid
          GROUP BY requirement_id, worker_id
          HAVING COUNT(*) > 1
        ) d
      `,
    ]);

    // 1. Authoritative capacity invariant: worker_count_filled <= worker_count_needed
    expect(req.worker_count_filled).toBeLessThanOrEqual(req.worker_count_needed);
    expect(req.worker_count_filled).toBe(expectedCapacity);
    expect(req.worker_count_filled).toBeGreaterThanOrEqual(0);

    // 2. Booking count matches ledger exactly
    expect(bookingCount).toBe(expectedCapacity);

    // 3. Zero duplicate bookings for any worker
    expect(Number(duplicates[0]?.duplicates || 0)).toBe(0);
    expect(uniqueWorkers.length).toBe(bookingCount);

    // 4. Requirement state matches filled status
    if (expectedCapacity >= req.worker_count_needed) {
      expect(req.status).toBe("FILLED");
    } else if (expectedCapacity > 0) {
      expect(req.status).toBe("PARTIALLY_FILLED");
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 1 — CAPACITY 1: 20 CONCURRENT WORKER ACCEPTANCE ATTEMPTS
  // ══════════════════════════════════════════════════════════════════════════════
  it("Scenario 1: Capacity 1 with 20 simultaneous workers produces exactly 1 booking and 0 overbooking", async () => {
    const workerCount = 20;
    const capacity = 1;
    const workers = await createWorkers(workerCount, "S1");
    const workerIds = workers.map((w) => w.id);
    const { job, requirement } = await setupJobAndDispatches(capacity, workers);

    try {
      const outcomes = await Promise.allSettled(
        workers.map((w) => acceptDispatch(requirement.id, w.id))
      );

      const successful = outcomes.filter((o) => o.status === "fulfilled");
      const rejected = outcomes.filter((o) => o.status === "rejected");

      expect(successful).toHaveLength(1);
      expect(rejected).toHaveLength(workerCount - 1);

      // Verify all rejected calls received controlled 409 conflict
      for (const rej of rejected) {
        const error = (rej as PromiseRejectedResult).reason;
        expect(error).toBeInstanceOf(DispatchAcceptanceError);
        expect(error.statusCode).toBe(409);
        expect(["SLOTS_FULL", "BOOKING_ALREADY_EXISTS", "DISPATCH_ALREADY_ACCEPTED"]).toContain(error.code);
      }

      await verifyPostgreSqlInvariants(requirement.id, 1);
    } finally {
      await cleanupRun(requirement.id, job.id, workerIds);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 2 — CAPACITY 2: 50 SIMULTANEOUS WORKERS (10 REPEATED ITERATIONS)
  // ══════════════════════════════════════════════════════════════════════════════
  it("Scenario 2: Mandatory P6 Scenario — Capacity 2 with 50 simultaneous workers across 10 repeated iterations", async () => {
    const iterations = 10;
    const capacity = 2;
    const workerCount = 50;

    for (let iter = 1; iter <= iterations; iter++) {
      const workers = await createWorkers(workerCount, `S2_Iter${iter}`);
      const workerIds = workers.map((w) => w.id);
      const { job, requirement } = await setupJobAndDispatches(capacity, workers);

      try {
        const outcomes = await Promise.allSettled(
          workers.map((w) => acceptDispatch(requirement.id, w.id))
        );

        const successful = outcomes.filter((o) => o.status === "fulfilled");
        const rejected = outcomes.filter((o) => o.status === "rejected");

        expect(successful).toHaveLength(capacity);
        expect(rejected).toHaveLength(workerCount - capacity);

        for (const rej of rejected) {
          const error = (rej as PromiseRejectedResult).reason;
          expect(error).toBeInstanceOf(DispatchAcceptanceError);
          expect(error.statusCode).toBe(409);
        }

        await verifyPostgreSqlInvariants(requirement.id, capacity);
      } finally {
        await cleanupRun(requirement.id, job.id, workerIds);
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 3 — 100+ CONCURRENT REQUESTS STRESS TEST (LATENCY & CONFLICT AUDIT)
  // ══════════════════════════════════════════════════════════════════════════════
  it("Scenario 3: Stress Test — 100 simultaneous acceptance requests against Capacity 2 with latency audit", async () => {
    const workerCount = 100;
    const capacity = 2;
    const workers = await createWorkers(workerCount, "S3");
    const workerIds = workers.map((w) => w.id);
    const { job, requirement } = await setupJobAndDispatches(capacity, workers);

    try {
      const latencies: number[] = [];
      const startTime = Date.now();

      const outcomes = await Promise.allSettled(
        workers.map(async (w) => {
          const reqStart = Date.now();
          try {
            const res = await acceptDispatch(requirement.id, w.id);
            latencies.push(Date.now() - reqStart);
            return res;
          } catch (err) {
            latencies.push(Date.now() - reqStart);
            throw err;
          }
        })
      );

      const totalDuration = Date.now() - startTime;
      const successful = outcomes.filter((o) => o.status === "fulfilled");
      const rejected = outcomes.filter((o) => o.status === "rejected");

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      const p99 = latencies[Math.floor(latencies.length * 0.99)];

      console.log(`[STRESS_TEST_METRICS] Total: ${workerCount}, Success: ${successful.length}, Conflicts: ${rejected.length}, Duration: ${totalDuration}ms, p50: ${p50}ms, p95: ${p95}ms, p99: ${p99}ms`);

      expect(successful).toHaveLength(capacity);
      expect(rejected).toHaveLength(workerCount - capacity);

      await verifyPostgreSqlInvariants(requirement.id, capacity);
    } finally {
      await cleanupRun(requirement.id, job.id, workerIds);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 4 — MULTIPLE CAPACITIES MATRIX (1, 2, 5, 10)
  // ══════════════════════════════════════════════════════════════════════════════
  it("Scenario 4: Multiple Capacities Matrix (Test D: Capacity 5 -> 100 workers, Test E: Capacity 10 -> 100 workers)", async () => {
    const testCases = [
      { capacity: 5, workerCount: 100 },
      { capacity: 10, workerCount: 100 },
    ];

    for (const tc of testCases) {
      const workers = await createWorkers(tc.workerCount, `S4_Cap${tc.capacity}`);
      const workerIds = workers.map((w) => w.id);
      const { job, requirement } = await setupJobAndDispatches(tc.capacity, workers);

      try {
        const outcomes = await Promise.allSettled(
          workers.map((w) => acceptDispatch(requirement.id, w.id))
        );

        const successful = outcomes.filter((o) => o.status === "fulfilled");
        const rejected = outcomes.filter((o) => o.status === "rejected");

        expect(successful).toHaveLength(tc.capacity);
        expect(rejected).toHaveLength(tc.workerCount - tc.capacity);

        await verifyPostgreSqlInvariants(requirement.id, tc.capacity);
      } finally {
        await cleanupRun(requirement.id, job.id, workerIds);
      }
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 5 — DUPLICATE WORKER REQUESTS (50 SIMULTANEOUS FROM SAME WORKER)
  // ══════════════════════════════════════════════════════════════════════════════
  it("Scenario 5: Duplicate Worker Requests — 50 simultaneous requests from SAME worker yields exactly 1 booking", async () => {
    const capacity = 2;
    const workers = await createWorkers(1, "S5_Single");
    const worker = workers[0];
    const { job, requirement } = await setupJobAndDispatches(capacity, [worker]);

    try {
      const duplicateAttempts = 50;
      const outcomes = await Promise.allSettled(
        Array.from({ length: duplicateAttempts }).map(() =>
          acceptDispatch(requirement.id, worker.id)
        )
      );

      const successful = outcomes.filter((o) => o.status === "fulfilled");
      const rejected = outcomes.filter((o) => o.status === "rejected");

      expect(successful).toHaveLength(1);
      expect(rejected).toHaveLength(duplicateAttempts - 1);

      for (const rej of rejected) {
        const error = (rej as PromiseRejectedResult).reason;
        if (!(error instanceof DispatchAcceptanceError)) {
          console.error('[UNEXPECTED_REJECTION_ERROR]', {
            name: error?.name,
            constructor: error?.constructor?.name,
            message: error?.message,
            code: error?.code,
            meta: error?.meta,
            stack: error?.stack,
          });
        }
        expect(error).toBeInstanceOf(DispatchAcceptanceError);
        expect(error.statusCode).toBe(409);
        expect(["BOOKING_ALREADY_EXISTS", "DISPATCH_ALREADY_ACCEPTED"]).toContain(error.code);
      }

      // Final PostgreSQL state: filled count is exactly 1, exactly 1 booking
      await verifyPostgreSqlInvariants(requirement.id, 1);
    } finally {
      await cleanupRun(requirement.id, job.id, [worker.id]);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 6 — MIXED WORKERS + DUPLICATES
  // ══════════════════════════════════════════════════════════════════════════════
  it("Scenario 6: Mixed Workers + Duplicates — 20 workers sending 5 requests each (100 total) for Capacity 3", async () => {
    const capacity = 3;
    const workerCount = 20;
    const duplicateFactor = 5;
    const workers = await createWorkers(workerCount, "S6_Mixed");
    const workerIds = workers.map((w) => w.id);
    const { job, requirement } = await setupJobAndDispatches(capacity, workers);

    try {
      const allRequests: Array<{ workerId: string }> = [];
      for (const w of workers) {
        for (let d = 0; d < duplicateFactor; d++) {
          allRequests.push({ workerId: w.id });
        }
      }
      // Shuffle requests to maximize race randomness
      allRequests.sort(() => Math.random() - 0.5);

      const outcomes = await Promise.allSettled(
        allRequests.map((req) => acceptDispatch(requirement.id, req.workerId))
      );

      const successful = outcomes.filter((o) => o.status === "fulfilled");
      const rejected = outcomes.filter((o) => o.status === "rejected");

      // Exactly 3 unique workers win slots
      expect(successful).toHaveLength(capacity);
      expect(rejected).toHaveLength(allRequests.length - capacity);

      await verifyPostgreSqlInvariants(requirement.id, capacity);
    } finally {
      await cleanupRun(requirement.id, job.id, workerIds);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 7 — ACCEPTANCE VS CANCELLATION RACE
  // ══════════════════════════════════════════════════════════════════════════════
  it("Scenario 7: Acceptance vs Cancellation Race — Concurrently racing acceptance and cancellation", async () => {
    const capacity = 2;
    const workerCount = 10;
    const workers = await createWorkers(workerCount, "S7_Race");
    const workerIds = workers.map((w) => w.id);
    const { job, requirement } = await setupJobAndDispatches(capacity, workers);

    try {
      // Race: 10 worker acceptances vs 1 job cancellation
      const cancelPromise = jobService.cancelJob(job.id, sharedCustomerId, undefined, "Race cancellation");
      const acceptPromises = workers.map((w) => acceptDispatch(requirement.id, w.id));

      const [cancelOutcome, ...acceptOutcomes] = await Promise.allSettled([
        cancelPromise,
        ...acceptPromises,
      ]);

      const successfulAccepts = acceptOutcomes.filter((o) => o.status === "fulfilled");
      const bookingCount = await prisma.booking.count({ where: { requirement_id: requirement.id } });
      const freshReq = await prisma.job_requirement.findUniqueOrThrow({ where: { id: requirement.id } });
      const freshJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });

      // Invariants:
      // 1. Total bookings must NEVER exceed capacity
      expect(bookingCount).toBeLessThanOrEqual(capacity);
      expect(freshReq.worker_count_filled).toBe(bookingCount);

      // 2. If cancellation succeeded and requirement is CANCELLED:
      if (freshReq.status === "CANCELLED") {
        expect(freshJob.status).toBe("CANCELLED");
      }
    } finally {
      await cleanupRun(requirement.id, job.id, workerIds);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 8 — ACCEPTANCE VS EXPIRATION / TIMEOUT
  // ══════════════════════════════════════════════════════════════════════════════
  it("Scenario 8: Acceptance vs Expiration / Timeout — Acceptance racing with timeoutWorker", async () => {
    const capacity = 1;
    const workers = await createWorkers(5, "S8_Timeout");
    const workerIds = workers.map((w) => w.id);
    const { job, requirement } = await setupJobAndDispatches(capacity, workers);

    try {
      // Race: processTimeoutJob for wave 1 vs worker acceptances
      const timeoutPromise = processTimeoutJob({
        requirementId: requirement.id,
        jobId: job.id,
        waveNumber: 1,
        waveSize: 5,
        totalWorkersFound: 5,
        offset: 0,
        candidatesExhausted: true,
      });

      const acceptPromises = workers.map((w) => acceptDispatch(requirement.id, w.id));

      await Promise.allSettled([timeoutPromise, ...acceptPromises]);

      const bookingCount = await prisma.booking.count({ where: { requirement_id: requirement.id } });
      const freshReq = await prisma.job_requirement.findUniqueOrThrow({ where: { id: requirement.id } });

      // Invariant: At most 1 booking (capacity 1)
      expect(bookingCount).toBeLessThanOrEqual(capacity);
      expect(freshReq.worker_count_filled).toBe(bookingCount);
      expect(freshReq.worker_count_filled).toBeLessThanOrEqual(freshReq.worker_count_needed);
    } finally {
      await cleanupRun(requirement.id, job.id, workerIds);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 9 — FAILURE INJECTION & TRANSACTION ROLLBACK PROOF
  // ══════════════════════════════════════════════════════════════════════════════
  it("Scenario 9: Failure Injection — Simulated booking insertion failure completely rolls back capacity counter", async () => {
    const capacity = 2;
    const workers = await createWorkers(1, "S9_Fail");
    const worker = workers[0];
    const { job, requirement } = await setupJobAndDispatches(capacity, [worker]);

    try {
      // Intentionally cause booking creation failure by passing an invalid job_id in an atomic test transaction
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.$queryRawUnsafe(
            `SELECT id FROM job_requirement WHERE id = '${requirement.id}'::uuid FOR UPDATE`
          );

          await tx.job_requirement.update({
            where: { id: requirement.id },
            data: { worker_count_filled: 1, status: "PARTIALLY_FILLED" },
          });

          // Violate foreign key on booking to simulate crash / failure
          await tx.booking.create({
            data: {
              job_id: "00000000-0000-0000-0000-000000000000", // Non-existent job
              requirement_id: requirement.id,
              worker_id: worker.id,
              customer_id: sharedCustomerId,
              status: "CONFIRMED",
            },
          });
        })
      ).rejects.toThrow();

      // Verify PostgreSQL state rolled back completely
      const freshReq = await prisma.job_requirement.findUniqueOrThrow({ where: { id: requirement.id } });
      const bookingCount = await prisma.booking.count({ where: { requirement_id: requirement.id } });

      expect(freshReq.worker_count_filled).toBe(0);
      expect(freshReq.status).toBe("DISPATCHING");
      expect(bookingCount).toBe(0);
    } finally {
      await cleanupRun(requirement.id, job.id, [worker.id]);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 10 — POST-COMMIT NOTIFICATION FAILURE ISOLATION
  // ══════════════════════════════════════════════════════════════════════════════
  it("Scenario 10: Notification Failure Isolation — DB COMMIT succeeds despite Socket.IO notification error", async () => {
    const capacity = 1;
    const workers = await createWorkers(1, "S10_Notif");
    const worker = workers[0];
    const { job, requirement } = await setupJobAndDispatches(capacity, [worker]);

    // Mock Socket.IO emit to throw an error to simulate notification layer failure
    const originalTo = io?.to;
    if (io) {
      (io as any).to = jest.fn().mockImplementation(() => {
        throw new Error("Simulated Socket.IO network failure");
      });
    }

    try {
      // Worker acceptance must SUCCEED because business transaction is already committed
      const res = await acceptDispatch(requirement.id, worker.id);
      expect(res).toBeDefined();
      expect(res.booking).toBeDefined();
      expect(res.booking.worker_id).toBe(worker.id);

      // Verify direct PostgreSQL state
      const [freshReq, bookingCount, freshDispatch, outboxCount] = await Promise.all([
        prisma.job_requirement.findUniqueOrThrow({ where: { id: requirement.id } }),
        prisma.booking.count({ where: { requirement_id: requirement.id } }),
        prisma.job_dispatch.findFirstOrThrow({
          where: { requirement_id: requirement.id, worker_id: worker.id },
        }),
        prisma.notification_outbox.count({
          where: { aggregate_id: res.booking.id },
        }),
      ]);

      expect(freshReq.worker_count_filled).toBe(1);
      expect(freshReq.status).toBe("FILLED");
      expect(bookingCount).toBe(1);
      expect(freshDispatch.status).toBe("accepted");
      expect(outboxCount).toBeGreaterThanOrEqual(1);
    } finally {
      if (io && originalTo) {
        (io as any).to = originalTo;
      }
      await cleanupRun(requirement.id, job.id, [worker.id]);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 11 — PRODUCTION HTTP ENDPOINT CONCURRENCY (POST /api/dispatch/:id/accept)
  // ══════════════════════════════════════════════════════════════════════════════
  it("Scenario 11: Production HTTP Verification — 25 concurrent requests via Supertest POST /api/dispatch/:id/accept", async () => {
    const capacity = 2;
    const workerCount = 25;
    const workers = await createWorkers(workerCount, "S11_HTTP");
    const workerIds = workers.map((w) => w.id);
    const { job, requirement } = await setupJobAndDispatches(capacity, workers);

    try {
      // Generate real JWT tokens for all workers
      const workerTokens = workers.map((w) =>
        signAccessToken({ id: w.id, role: UserRole.WORKER, phone: "+919999999999" })
      );

      const reqStart = Date.now();
      const responses = await Promise.all(
        workers.map((w, idx) =>
          request(app)
            .post(`/api/dispatch/${requirement.id}/accept`)
            .set("Authorization", `Bearer ${workerTokens[idx]}`)
            .send()
        )
      );
      const totalDuration = Date.now() - reqStart;

      const successful = responses.filter((r) => r.status === 200);
      const conflicts = responses.filter((r) => r.status === 409);
      const unexpected = responses.filter((r) => r.status !== 200 && r.status !== 409);

      console.log(`[HTTP_ENDPOINT_METRICS] Total: ${workerCount}, 200 OK: ${successful.length}, 409 Conflicts: ${conflicts.length}, Unexpected: ${unexpected.length}, Duration: ${totalDuration}ms`);

      expect(unexpected).toHaveLength(0);
      expect(successful).toHaveLength(capacity);
      expect(conflicts).toHaveLength(workerCount - capacity);

      // Verify PostgreSQL invariants directly
      await verifyPostgreSqlInvariants(requirement.id, capacity);
    } finally {
      await cleanupRun(requirement.id, job.id, workerIds);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // TEST 12 — SCALING BENCHMARKS MATRIX (10, 25, 50, 100, 200 CONCURRENT REQUESTS)
  // ══════════════════════════════════════════════════════════════════════════════
  it("Scenario 12: Scaling Benchmarks Matrix — Measuring latency curve under 10, 25, 50, 100, 200 concurrent requests", async () => {
    const scales = [10, 25, 50, 100, 200];
    const capacity = 2;

    for (const count of scales) {
      const workers = await createWorkers(count, `S12_${count}`);
      const workerIds = workers.map((w) => w.id);
      const { job, requirement } = await setupJobAndDispatches(capacity, workers);

      try {
        const latencies: number[] = [];
        const scaleStart = Date.now();

        const outcomes = await Promise.allSettled(
          workers.map(async (w) => {
            const t0 = Date.now();
            try {
              const res = await acceptDispatch(requirement.id, w.id);
              latencies.push(Date.now() - t0);
              return res;
            } catch (err) {
              latencies.push(Date.now() - t0);
              throw err;
            }
          })
        );

        const totalMs = Date.now() - scaleStart;
        const successful = outcomes.filter((o) => o.status === "fulfilled");
        const rejected = outcomes.filter((o) => o.status === "rejected");

        latencies.sort((a, b) => a - b);
        const p50 = latencies[Math.floor(latencies.length * 0.5)];
        const p95 = latencies[Math.floor(latencies.length * 0.95)];
        const p99 = latencies[Math.floor(latencies.length * 0.99)];
        const max = latencies[latencies.length - 1];

        console.log(`[SCALING_MATRIX_${count}] Requests: ${count}, Success: ${successful.length}, Conflicts: ${rejected.length}, Total: ${totalMs}ms, p50: ${p50}ms, p95: ${p95}ms, p99: ${p99}ms, max: ${max}ms`);

        expect(successful).toHaveLength(capacity);
        expect(rejected).toHaveLength(count - capacity);

        await verifyPostgreSqlInvariants(requirement.id, capacity);
      } finally {
        await cleanupRun(requirement.id, job.id, workerIds);
      }
    }
  }, 240000);
});

