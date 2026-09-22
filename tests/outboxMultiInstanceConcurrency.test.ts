import prisma from "../src/config/prisma";
import { outboxService, OutboxRecord } from "../src/services/outboxService";
import { Prisma } from "@prisma/client";

describe("P4 Issue 11 & 12: Outbox Multi-Instance Concurrency & Transactional Atomicity", () => {
  const createdOutboxIds: string[] = [];
  const testAggregateId = "11111111-1111-1111-1111-111111111111";
  const testWorkerId = "22222222-2222-2222-2222-222222222222";

  beforeAll(async () => {
    // Clean up any existing test records
    await prisma.$executeRawUnsafe(
      `DELETE FROM "notification_outbox" WHERE aggregate_id = '${testAggregateId}' OR recipient_id = '${testWorkerId}'`
    );
  });

  afterAll(async () => {
    if (createdOutboxIds.length > 0) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM "notification_outbox" WHERE id IN (${createdOutboxIds.map((id) => `'${id}'`).join(",")})`
      );
    }
  });

  describe("Issue 11: Multi-Worker Concurrent Claiming", () => {
    it("Test A & B: 4 concurrent workers claiming 50 pending events results in exactly 1 owner per event", async () => {
      const TOTAL_EVENTS = 50;
      const NUM_WORKERS = 4;
      const seedIds: string[] = [];

      // Seed 50 PENDING outbox events
      for (let i = 0; i < TOTAL_EVENTS; i++) {
        const id = `a0000000-0000-0000-0000-${String(i).padStart(12, "0")}`;
        seedIds.push(id);
        createdOutboxIds.push(id);
      }

      await prisma.$executeRawUnsafe(
        `INSERT INTO "notification_outbox" (id, event_type, aggregate_type, aggregate_id, recipient_type, recipient_id, payload, status, available_at, created_at, updated_at)
         VALUES ${seedIds
           .map(
             (id, idx) =>
               `('${id}', 'TEST_CONCURRENCY', 'test', '${testAggregateId}', 'worker', '${testWorkerId}', '{"index": ${idx}}'::jsonb, 'PENDING', NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 minute')`
           )
           .join(",")}`
      );

      // Launch 4 concurrent workers simultaneously claiming batches
      const workerClaims: OutboxRecord[][] = await Promise.all(
        Array.from({ length: NUM_WORKERS }, async (_, workerIdx) => {
          // Each worker attempts to claim batches until none left
          const claimed: OutboxRecord[] = [];
          for (let attempt = 0; attempt < 10; attempt++) {
            const batch = await outboxService.claimPendingEvents(15, 5);
            if (batch.length === 0) break;
            claimed.push(...batch.filter((r) => seedIds.includes(r.id)));
          }
          return claimed;
        })
      );

      // Track how many times each event was claimed across all workers
      const claimCounts: Record<string, number> = {};
      let totalClaimed = 0;

      for (const records of workerClaims) {
        for (const record of records) {
          claimCounts[record.id] = (claimCounts[record.id] || 0) + 1;
          totalClaimed++;
        }
      }

      // Invariant: Exactly one worker owned each event
      expect(totalClaimed).toBe(TOTAL_EVENTS);
      for (const id of seedIds) {
        expect(claimCounts[id]).toBe(1);
      }

      // Verify database state: all 50 rows must now be in PROCESSING status
      const dbRows: any[] = await prisma.$queryRawUnsafe(
        `SELECT id, status FROM "notification_outbox" WHERE id IN (${seedIds.map((id) => `'${id}'`).join(",")})`
      );
      expect(dbRows.length).toBe(TOTAL_EVENTS);
      for (const row of dbRows) {
        expect(row.status).toBe("PROCESSING");
      }
    });

    it("Test C & D: Expired lease allows crash recovery while active lease prevents premature theft", async () => {
      const activeId = "b0000000-0000-0000-0000-000000000001";
      const expiredId = "b0000000-0000-0000-0000-000000000002";
      createdOutboxIds.push(activeId, expiredId);

      // Active lease: claimed 1 minute ago (stale threshold = 5 mins)
      // Expired lease: claimed 10 minutes ago (stale threshold = 5 mins)
      await prisma.$executeRawUnsafe(
        `INSERT INTO "notification_outbox" (id, event_type, aggregate_type, aggregate_id, recipient_type, recipient_id, payload, status, available_at, updated_at, created_at)
         VALUES 
          ('${activeId}', 'ACTIVE_LEASE', 'test', '${testAggregateId}', 'worker', '${testWorkerId}', '{}'::jsonb, 'PROCESSING', NOW(), NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 minute'),
          ('${expiredId}', 'EXPIRED_LEASE', 'test', '${testAggregateId}', 'worker', '${testWorkerId}', '{}'::jsonb, 'PROCESSING', NOW(), NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes')`
      );

      // Claim batch with 5-minute stale threshold
      const claimed = await outboxService.claimPendingEvents(10, 5);
      const claimedIds = claimed.map((r) => r.id);

      // Expired lease should be recovered; active lease must NOT be stolen
      expect(claimedIds).toContain(expiredId);
      expect(claimedIds).not.toContain(activeId);
    });

    it("Test E: Stale worker fence: A crashed/delayed worker whose lease expired and was reclaimed cannot overwrite a newer worker's state", async () => {
      const fenceId = "b0000000-0000-0000-0000-000000000003";
      createdOutboxIds.push(fenceId);

      // Event was in PROCESSING 10 mins ago (stale)
      await prisma.$executeRawUnsafe(
        `INSERT INTO "notification_outbox" (id, event_type, aggregate_type, aggregate_id, recipient_type, recipient_id, payload, status, available_at, updated_at, created_at)
         VALUES ('${fenceId}', 'STALE_FENCE', 'test', '${testAggregateId}', 'worker', '${testWorkerId}', '{}'::jsonb, 'PROCESSING', NOW(), NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes')`
      );

      // Worker B reclaims the stale event (re-marking it PROCESSING with new updated_at)
      const reclaimed = await outboxService.claimPendingEvents(10, 5);
      expect(reclaimed.some((r) => r.id === fenceId)).toBe(true);

      // Worker B finishes delivery and marks success
      const successB = await outboxService.markEventSuccess(fenceId);
      expect(successB).toBe(true);

      // Now stale Worker A wakes up and attempts to mark failure
      const staleFailureA = await outboxService.markEventFailure(fenceId, "Late network timeout from worker A", false);
      // Fencing check ensures stale worker's action is safely ignored
      expect(staleFailureA).toBe(false);

      // Database state remains SENT by Worker B
    });

    it("Test F: Deterministic delivery identity prevents duplicate logical events on retry", async () => {
      const idempotencyKey = `idempotent_test:${Date.now()}`;
      
      // Step 1: Create event inside transaction
      let event1: any;
      await prisma.$transaction(async (tx) => {
        event1 = await outboxService.createOutboxEvent(tx, {
          eventType: "JOB_NOTIFICATION",
          aggregateType: "test",
          aggregateId: testAggregateId,
          recipientType: "worker",
          recipientId: testWorkerId,
          payload: { step: 1 },
          idempotencyKey,
        });
      });
      expect(event1).toBeDefined();
      createdOutboxIds.push(event1.id);

      // Step 2: Retry with identical idempotencyKey inside a new transaction
      let event2: any;
      await prisma.$transaction(async (tx) => {
        event2 = await outboxService.createOutboxEvent(tx, {
          eventType: "JOB_NOTIFICATION",
          aggregateType: "test",
          aggregateId: testAggregateId,
          recipientType: "worker",
          recipientId: testWorkerId,
          payload: { step: 1 },
          idempotencyKey,
        });
      });

      // Assert event2 returned existing record without creating duplicate row
      expect(event2).toBeDefined();
      expect(event2.id).toBe(event1.id);

      const countResult: any[] = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int as count FROM "notification_outbox" WHERE idempotency_key = '${idempotencyKey}'`
      );
      expect(countResult[0].count).toBe(1);
    });
  });

  describe("Issue 12: Mandatory Outbox Invariant & Failure Injection", () => {
    it("Failure injection: Mandatory outbox insert failure rolls back business transaction", async () => {
      const testPhone = `+91999${String(Date.now()).slice(-7)}`;
      let testCustomerId: string | null = null;

      try {
        // Attempt transaction where business row (customer) is created, but outbox insert fails
        await expect(
          prisma.$transaction(async (tx) => {
            // 1. Business mutation: create customer
            const cust = await tx.customer.create({
              data: {
                phone: testPhone,
                name: "Rollback Test Customer",
                password: "hashed_password",
              },
            });
            testCustomerId = cust.id;

            // 2. Failure injection on mandatory outbox: simulate invalid outbox insert (e.g. non-null constraint violation)
            await (tx as any).notification_outbox.create({
              data: {
                event_type: "MANDATORY_EVENT",
                aggregate_type: "customer",
                aggregate_id: "invalid-uuid-format-to-trigger-db-error", // Deliberately invalid UUID to trigger PostgreSQL error
                recipient_type: "customer",
                recipient_id: cust.id,
                payload: {},
              },
            });
          })
        ).rejects.toThrow();

        // 3. Verify business row was NOT committed (rolled back)
        const checkCust = await prisma.customer.findFirst({
          where: { phone: testPhone },
        });
        expect(checkCust).toBeNull();
      } finally {
        if (testCustomerId) {
          await prisma.customer.deleteMany({ where: { id: testCustomerId } });
        }
      }
    });

    it("Success case: Business mutation and mandatory outbox commit atomically", async () => {
      const testPhone = `+91998${String(Date.now()).slice(-7)}`;
      let createdCustId: string | null = null;
      let createdOutboxId: string | null = null;

      try {
        await prisma.$transaction(async (tx) => {
          // 1. Business mutation
          const cust = await tx.customer.create({
            data: {
              phone: testPhone,
              name: "Atomic Test Customer",
              password: "hashed_password",
            },
          });
          createdCustId = cust.id;

          // 2. Mandatory outbox
          const outbox = await outboxService.createOutboxEvent(tx, {
            eventType: "CUSTOMER_REGISTERED",
            aggregateType: "customer",
            aggregateId: cust.id,
            recipientType: "customer",
            recipientId: cust.id,
            payload: { name: cust.name },
          });
          if (outbox) createdOutboxId = outbox.id;
        });

        // 3. Verify both business row and outbox row are committed
        expect(createdCustId).toBeDefined();
        expect(createdOutboxId).toBeDefined();
        createdOutboxIds.push(createdOutboxId!);

        const committedCust = await prisma.customer.findUnique({
          where: { id: createdCustId! },
        });
        expect(committedCust).not.toBeNull();

        const committedOutbox = await (prisma as any).notification_outbox.findUnique({
          where: { id: createdOutboxId! },
        });
        expect(committedOutbox).not.toBeNull();
        expect(committedOutbox.status).toBe("PENDING");
      } finally {
        if (createdCustId) {
          await prisma.customer.deleteMany({ where: { id: createdCustId } });
        }
      }
    });

    it("Asynchronous notification delivery failure does not roll back committed business state", async () => {
      const testPhone = `+91997${String(Date.now()).slice(-7)}`;
      let createdCustId: string | null = null;
      let outboxId: string | null = null;

      try {
        // Business transaction commits
        await prisma.$transaction(async (tx) => {
          const cust = await tx.customer.create({
            data: {
              phone: testPhone,
              name: "Delivery Failure Customer",
              password: "hashed_password",
            },
          });
          createdCustId = cust.id;

          const outbox = await outboxService.createOutboxEvent(tx, {
            eventType: "CUSTOMER_WELCOME",
            aggregateType: "customer",
            aggregateId: cust.id,
            recipientType: "customer",
            recipientId: cust.id,
            payload: { phone: testPhone },
          });
          if (outbox) outboxId = outbox.id;
        });

        createdOutboxIds.push(outboxId!);

        // Worker claims event into PROCESSING
        await (prisma as any).notification_outbox.update({
          where: { id: outboxId! },
          data: { status: "PROCESSING", updated_at: new Date() },
        });

        // Asynchronous delivery worker encounters delivery failure
        await outboxService.markEventFailure(outboxId!, "Push notification gateway timeout", false);

        // Verify business row remains safely COMMITTED
        const custAfterWorkerFailure = await prisma.customer.findUnique({
          where: { id: createdCustId! },
        });
        expect(custAfterWorkerFailure).not.toBeNull();

        // Verify outbox row transitioned to retryable PENDING state with backoff
        const outboxRow = await (prisma as any).notification_outbox.findUnique({
          where: { id: outboxId! },
        });
        expect(outboxRow.status).toBe("PENDING");
        expect(outboxRow.attempts).toBe(1);
        expect(outboxRow.last_error).toContain("Push notification gateway timeout");
      } finally {
        if (createdCustId) {
          await prisma.customer.deleteMany({ where: { id: createdCustId } });
        }
      }
    });
  });
});
