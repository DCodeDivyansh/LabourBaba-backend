import { outboxService, OutboxRecord } from "../src/services/outboxService";
import { OutboxWorker } from "../src/workers/outboxWorker";
import prisma from "../src/config/prisma";

describe("P3 Issue 8 — Outbox Multi-Instance & Real PostgreSQL Concurrency Tests", () => {
  jest.setTimeout(60000);

  const testWorkerId = "00000000-0000-4000-b000-000000000001";
  const testRequirementId = "00000000-0000-4000-b000-000000000002";

  beforeAll(async () => {
    await prisma.$connect();
    // Clean up any existing test records
    await (prisma as any).notification_outbox.deleteMany({
      where: { recipient_id: testWorkerId },
    }).catch(() => {});
  });

  afterAll(async () => {
    // Clean up test records
    await (prisma as any).notification_outbox.deleteMany({
      where: { recipient_id: testWorkerId },
    }).catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await (prisma as any).notification_outbox.deleteMany({
      where: { recipient_id: testWorkerId },
    }).catch(() => {});
  });

  // =========================================================================
  // TEST 1 & TEST 9 — Two & Many Concurrent Workers Claiming Same Event
  // =========================================================================
  describe("1. Atomic Claiming & Multi-Worker Contention", () => {
    it("TEST 1: Two workers claiming the same single pending event results in EXACTLY ONE claim", async () => {
      const idempotencyKey = `test:outbox:contention:2w:${Date.now()}`;

      const created = await prisma.$transaction(async (tx) => {
        return await outboxService.createOutboxEvent(tx, {
          eventType: "incoming_job",
          aggregateType: "requirement",
          aggregateId: testRequirementId,
          recipientType: "worker",
          recipientId: testWorkerId,
          payload: { title: "Contention Job 1", rate: 600 },
          idempotencyKey,
        });
      });

      expect(created).toBeDefined();

      // Simulate 2 workers executing atomic claim at the exact same moment
      const [workerAClaim, workerBClaim] = await Promise.all([
        outboxService.claimPendingEvents(10),
        outboxService.claimPendingEvents(10),
      ]);

      const workerAIds = workerAClaim.map((r) => r.id);
      const workerBIds = workerBClaim.map((r) => r.id);

      const isClaimedByA = workerAIds.includes(created!.id);
      const isClaimedByB = workerBIds.includes(created!.id);

      // Invariant: Exactly one worker must claim the event. Both workers CANNOT claim it.
      expect(isClaimedByA !== isClaimedByB).toBe(true);
      expect(isClaimedByA && isClaimedByB).toBe(false);

      // Verify database state is PROCESSING
      const recordInDb = await (prisma as any).notification_outbox.findUnique({
        where: { id: created!.id },
      });
      expect(recordInDb.status).toBe("PROCESSING");
    });

    it("TEST 9: High-concurrency stress — 20 simultaneous workers contending for a single event", async () => {
      const idempotencyKey = `test:outbox:stress:20w:${Date.now()}`;

      const created = await prisma.$transaction(async (tx) => {
        return await outboxService.createOutboxEvent(tx, {
          eventType: "incoming_job",
          aggregateType: "requirement",
          aggregateId: testRequirementId,
          recipientType: "worker",
          recipientId: testWorkerId,
          payload: { title: "Stress Job", rate: 700 },
          idempotencyKey,
        });
      });

      // Launch 20 concurrent claim operations
      const NUM_WORKERS = 20;
      const claimPromises = Array.from({ length: NUM_WORKERS }, () =>
        outboxService.claimPendingEvents(10)
      );

      const claimResults = await Promise.all(claimPromises);

      let totalClaimsOfOurEvent = 0;
      for (const batch of claimResults) {
        if (batch.some((r) => r.id === created!.id)) {
          totalClaimsOfOurEvent++;
        }
      }

      // CRITICAL INVARIANT: Across 20 concurrent database transactions, exactly 1 succeeds in claiming
      expect(totalClaimsOfOurEvent).toBe(1);
    });
  });

  // =========================================================================
  // TEST 2 & TEST 11 — Multi-Worker Distribution & Batch Claiming (LIMIT N + SKIP LOCKED)
  // =========================================================================
  describe("2. Batch Distribution & Non-Overlapping Claims across Multiple Instances", () => {
    it("TEST 2 & 11: 5 concurrent workers claiming 50 events partition work with zero duplicate ownership", async () => {
      const TOTAL_EVENTS = 50;
      const createdIds: string[] = [];

      // Create 50 pending events in batch
      for (let i = 0; i < TOTAL_EVENTS; i++) {
        const idempotencyKey = `test:outbox:batch50:${i}:${Date.now()}`;
        const event = await prisma.$transaction(async (tx) => {
          return await outboxService.createOutboxEvent(tx, {
            eventType: "incoming_job",
            aggregateType: "requirement",
            aggregateId: testRequirementId,
            recipientType: "worker",
            recipientId: testWorkerId,
            payload: { index: i, title: `Batch Job ${i}` },
            idempotencyKey,
          });
        });
        if (event) createdIds.push(event.id);
      }

      expect(createdIds.length).toBe(TOTAL_EVENTS);

      // Run 5 concurrent worker processes claiming batches of 10
      const NUM_WORKERS = 5;
      const workerClaims = await Promise.all(
        Array.from({ length: NUM_WORKERS }, () => outboxService.claimPendingEvents(10))
      );

      const allClaimedIds: string[] = [];
      const duplicateIds: string[] = [];

      for (const batch of workerClaims) {
        for (const record of batch) {
          if (createdIds.includes(record.id)) {
            if (allClaimedIds.includes(record.id)) {
              duplicateIds.push(record.id);
            }
            allClaimedIds.push(record.id);
          }
        }
      }

      // Invariants:
      // 1. Zero duplicate claims across workers
      expect(duplicateIds).toHaveLength(0);
      // 2. All 50 events claimed across the 5 workers
      expect(allClaimedIds.length).toBe(TOTAL_EVENTS);
    });
  });

  // =========================================================================
  // TEST 3, 8 & 9 — Crash Recovery, Lease Expiration & Active Lease Protection
  // =========================================================================
  describe("3. Lease Expiration & Crash Recovery", () => {
    it("TEST 8: Worker cannot claim an in-flight PROCESSING event whose lease has NOT expired", async () => {
      const idempotencyKey = `test:outbox:active_lease:${Date.now()}`;

      const event = await prisma.$transaction(async (tx) => {
        return await outboxService.createOutboxEvent(tx, {
          eventType: "incoming_job",
          aggregateType: "requirement",
          aggregateId: testRequirementId,
          recipientType: "worker",
          recipientId: testWorkerId,
          payload: { title: "Active Lease Job" },
          idempotencyKey,
        });
      });

      // Claim the event so it becomes PROCESSING with fresh updated_at (active lease)
      const claim1 = await outboxService.claimPendingEvents(10);
      expect(claim1.some((r) => r.id === event!.id)).toBe(true);

      // Immediate second claim attempt while lease is active (< 5 min)
      const claim2 = await outboxService.claimPendingEvents(10);
      expect(claim2.some((r) => r.id === event!.id)).toBe(false);
    });

    it("TEST 3 & 8: Worker crash / abandoned PROCESSING event is automatically reclaimed after lease expires", async () => {
      const idempotencyKey = `test:outbox:expired_lease:${Date.now()}`;

      const event = await prisma.$transaction(async (tx) => {
        return await outboxService.createOutboxEvent(tx, {
          eventType: "incoming_job",
          aggregateType: "requirement",
          aggregateId: testRequirementId,
          recipientType: "worker",
          recipientId: testWorkerId,
          payload: { title: "Crashed Worker Job" },
          idempotencyKey,
        });
      });

      // Worker 1 claims event
      await outboxService.claimPendingEvents(10);

      // Simulate Worker 1 crashing and lease expiring (updated_at set to 10 minutes ago)
      await (prisma as any).notification_outbox.update({
        where: { id: event!.id },
        data: {
          status: "PROCESSING",
          updated_at: new Date(Date.now() - 10 * 60 * 1000),
        },
      });

      // Worker 2 runs atomic claim — should automatically reclaim the expired PROCESSING event
      const reclaimed = await outboxService.claimPendingEvents(10, 5);
      const isReclaimed = reclaimed.some((r) => r.id === event!.id);

      expect(isReclaimed).toBe(true);

      // Verify updated_at has been refreshed to now
      const inDb = await (prisma as any).notification_outbox.findUnique({
        where: { id: event!.id },
      });
      expect(inDb.status).toBe("PROCESSING");
      expect(new Date(inDb.updated_at).getTime()).toBeGreaterThan(Date.now() - 5000);
    });
  });

  // =========================================================================
  // TEST 4 & 5 — Idempotency & Duplicate Prevention
  // =========================================================================
  describe("4. Idempotency & Duplicate Prevention", () => {
    it("TEST 5: Duplicate createOutboxEvent calls with same idempotency key return existing row without duplication", async () => {
      const idempotencyKey = `test:outbox:idempotent_creation:${Date.now()}`;

      const first = await prisma.$transaction(async (tx) => {
        return await outboxService.createOutboxEvent(tx, {
          eventType: "booking_confirmed",
          aggregateType: "requirement",
          aggregateId: testRequirementId,
          recipientType: "worker",
          recipientId: testWorkerId,
          payload: { bookingId: "b-test-1" },
          idempotencyKey,
        });
      });

      const second = await prisma.$transaction(async (tx) => {
        return await outboxService.createOutboxEvent(tx, {
          eventType: "booking_confirmed",
          aggregateType: "requirement",
          aggregateId: testRequirementId,
          recipientType: "worker",
          recipientId: testWorkerId,
          payload: { bookingId: "b-test-1" },
          idempotencyKey,
        });
      });

      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(first!.id).toBe(second!.id);

      // Verify in DB there is exactly 1 row
      const count = await (prisma as any).notification_outbox.count({
        where: { idempotency_key: idempotencyKey },
      });
      expect(count).toBe(1);
    });
  });

  // =========================================================================
  // TEST 6 & 7 — Retries, Exponential Backoff & Terminal Failure
  // =========================================================================
  describe("5. Retries, Exponential Backoff & Terminal Failure", () => {
    it("TEST 6: Transient failure schedules retry with exponential backoff and increments attempt counter", async () => {
      const idempotencyKey = `test:outbox:retry_backoff:${Date.now()}`;

      const event = await prisma.$transaction(async (tx) => {
        return await outboxService.createOutboxEvent(tx, {
          eventType: "incoming_job",
          aggregateType: "requirement",
          aggregateId: testRequirementId,
          recipientType: "worker",
          recipientId: testWorkerId,
          payload: { title: "Retry Job" },
          idempotencyKey,
        });
      });

      // Fail attempt 1 (transient)
      await outboxService.markEventFailure(event!.id, "503 Service Unavailable", false);

      const afterAttempt1 = await (prisma as any).notification_outbox.findUnique({
        where: { id: event!.id },
      });
      expect(afterAttempt1.status).toBe("PENDING");
      expect(afterAttempt1.attempts).toBe(1);
      expect(new Date(afterAttempt1.available_at).getTime()).toBeGreaterThan(Date.now());

      // While available_at is in the future, it should NOT be claimable right now
      const claimImmediate = await outboxService.claimPendingEvents(10);
      expect(claimImmediate.some((r) => r.id === event!.id)).toBe(false);
    });

    it("TEST 7: Permanent failure transitions immediately to terminal FAILED status", async () => {
      const idempotencyKey = `test:outbox:permanent_fail:${Date.now()}`;

      const event = await prisma.$transaction(async (tx) => {
        return await outboxService.createOutboxEvent(tx, {
          eventType: "incoming_job",
          aggregateType: "requirement",
          aggregateId: testRequirementId,
          recipientType: "worker",
          recipientId: testWorkerId,
          payload: { title: "Permanent Fail Job" },
          idempotencyKey,
        });
      });

      // Fail permanently (e.g. invalid token or unregistered device)
      await outboxService.markEventFailure(event!.id, "UNREGISTERED_DEVICE_TOKEN", true);

      const inDb = await (prisma as any).notification_outbox.findUnique({
        where: { id: event!.id },
      });
      expect(inDb.status).toBe("FAILED");
      expect(inDb.failed_at).toBeDefined();
      expect(inDb.last_error).toBe("UNREGISTERED_DEVICE_TOKEN");

      // Cannot be claimed
      const claim = await outboxService.claimPendingEvents(10);
      expect(claim.some((r) => r.id === event!.id)).toBe(false);
    });

    it("TEST 7b: Reaching max_attempts transitions event to terminal FAILED status", async () => {
      const idempotencyKey = `test:outbox:max_attempts:${Date.now()}`;

      const event = await prisma.$transaction(async (tx) => {
        return await outboxService.createOutboxEvent(tx, {
          eventType: "incoming_job",
          aggregateType: "requirement",
          aggregateId: testRequirementId,
          recipientType: "worker",
          recipientId: testWorkerId,
          payload: { title: "Max Attempts Job" },
          idempotencyKey,
        });
      });

      // Set attempts to 4 of 5
      await (prisma as any).notification_outbox.update({
        where: { id: event!.id },
        data: { attempts: 4, max_attempts: 5 },
      });

      // 5th failure should trigger terminal FAILED
      await outboxService.markEventFailure(event!.id, "5th network failure", false);

      const inDb = await (prisma as any).notification_outbox.findUnique({
        where: { id: event!.id },
      });
      expect(inDb.status).toBe("FAILED");
      expect(inDb.attempts).toBe(5);
    });
  });

  // =========================================================================
  // TEST 12 — Transaction Rollback Safety
  // =========================================================================
  describe("6. Transaction Rollback Safety", () => {
    it("TEST 12: Business transaction rollback guarantees zero outbox orphan insertion", async () => {
      const idempotencyKey = `test:outbox:tx_rollback:${Date.now()}`;

      await expect(
        prisma.$transaction(async (tx) => {
          await outboxService.createOutboxEvent(tx, {
            eventType: "incoming_job",
            aggregateType: "requirement",
            aggregateId: testRequirementId,
            recipientType: "worker",
            recipientId: testWorkerId,
            payload: { title: "Rolled Back Event" },
            idempotencyKey,
          });

          throw new Error("Simulated payment transaction failure");
        })
      ).rejects.toThrow("Simulated payment transaction failure");

      const inDb = await (prisma as any).notification_outbox.findUnique({
        where: { idempotency_key: idempotencyKey },
      });
      expect(inDb).toBeNull();
    });
  });
});
