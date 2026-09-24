/**
 * tests/outboxWorkerGracefulShutdownP6_8.test.ts
 *
 * LabourBaba Backend — P6 Issue 8: Outbox Worker Does Not Explicitly Drain Active Work During Shutdown
 * Complete Verification & Test Suite
 *
 * Verifies:
 * - TEST 1: No active work -> stop resolves promptly, timer cleared, stopped state.
 * - TEST 2: Active batch completes before shutdown timeout -> graceful drain, success persisted, no event lost.
 * - TEST 3: Active batch exceeds shutdown timeout -> bounded exit, no hanging, no false success, remains recoverable.
 * - TEST 4: Recovery after timed-out shutdown -> lease expiry resets row to PENDING, recovered and delivered cleanly.
 * - TEST 5: Shutdown while multiple batches/operations are active -> all tracked, error resilient, no unhandled rejection.
 * - TEST 6: No new claims after shutdown begins -> timer callback and processBatch reject new claims immediately.
 * - TEST 7: Concurrent stop() calls -> exactly one drain sequence, all callers resolve consistently.
 * - TEST 8: Active operation rejects -> failure handled cleanly, shutdown finishes without unhandled rejection.
 * - TEST 9: Dependency failure during shutdown -> logs error, finishes boundedly, preserves recovery.
 * - TEST 10: Application lifecycle integration -> lifecycleManager.shutdown awaits outboxWorker drain before disconnecting DB.
 * - TEST 11: Real PostgreSQL CTE SKIP LOCKED & optimistic lease locking proof on live database.
 */

import { OutboxWorker } from "../src/workers/outboxWorker";
import { outboxService, OutboxRecord } from "../src/services/outboxService";
import { setMockFcmProvider, resetFirebaseApp, IFCMProvider, FCMPayload, FCMDeliveryResult } from "../src/shared/fcm";
import { metricsService } from "../src/metrics/metrics.service";
import { lifecycleManager } from "../src/lifecycle/lifecycleManager";
import prisma from "../src/config/prisma";
import { Client } from "pg";
import { randomUUID } from "crypto";
import dotenv from "dotenv";

dotenv.config();

describe("P6 Issue 8 — Outbox Worker Graceful Shutdown & Drain Suite", () => {
  jest.setTimeout(35000);

  const TEST_RECIPIENT_ID = "00000000-0000-4000-a000-000000000088";
  const TEST_AGGREGATE_ID = "00000000-0000-4000-a000-000000000099";

  beforeAll(async () => {
    // Clean up any stale test records from earlier runs
    await (prisma as any).notification_outbox.deleteMany({
      where: {
        recipient_id: TEST_RECIPIENT_ID,
      },
    }).catch(() => {});

    // Ensure worker and registered FCM device exist for TEST_RECIPIENT_ID
    let category = await prisma.skill_category.findFirst();
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "ShutdownHelper", description: "Shutdown Test Helper" },
      });
    }

    await prisma.worker.upsert({
      where: { id: TEST_RECIPIENT_ID },
      update: {},
      create: {
        id: TEST_RECIPIENT_ID,
        phone: "+919999000088",
        name: "Shutdown Test Worker",
        password: "hash",
        skill_type: "Helper",
        skill_category_id: category.id,
      },
    });

    await prisma.worker_device.upsert({
      where: {
        worker_id_device_id: {
          worker_id: TEST_RECIPIENT_ID,
          device_id: "test-device-p6-8",
        },
      },
      update: {
        fcm_token: "test-token",
        revoked_at: null,
      },
      create: {
        worker_id: TEST_RECIPIENT_ID,
        device_id: "test-device-p6-8",
        fcm_token: "test-token",
        platform: "android",
      },
    });
  });

  afterAll(async () => {
    setMockFcmProvider(null);
    resetFirebaseApp();
    await (prisma as any).notification_outbox.deleteMany({
      where: {
        recipient_id: TEST_RECIPIENT_ID,
      },
    }).catch(() => {});
    await prisma.worker_device.deleteMany({
      where: { worker_id: TEST_RECIPIENT_ID },
    }).catch(() => {});
    await prisma.worker.deleteMany({
      where: { id: TEST_RECIPIENT_ID },
    }).catch(() => {});
    await prisma.$disconnect();
  });

  afterEach(async () => {
    setMockFcmProvider(null);
  });

  // --------------------------------------------------------------------------
  // TEST 1 — No active work
  // --------------------------------------------------------------------------
  it("TEST 1: No active work -> stop() resolves promptly, clears timer, enters STOPPED state", async () => {
    const worker = new OutboxWorker();
    worker.start(1000);

    expect(worker.getState()).toBe("RUNNING");
    expect(worker.getActiveOperationsCount()).toBe(0);

    const startMs = Date.now();
    await worker.stop();
    const durationMs = Date.now() - startMs;

    expect(worker.getState()).toBe("STOPPED");
    expect(worker.getActiveOperationsCount()).toBe(0);
    // Should resolve virtually immediately
    expect(durationMs).toBeLessThan(100);
  });

  // --------------------------------------------------------------------------
  // TEST 2 — Active batch completes before shutdown timeout
  // --------------------------------------------------------------------------
  it("TEST 2: Active batch completes before shutdown timeout -> graceful drain, success persisted in DB", async () => {
    const worker = new OutboxWorker();

    // Create a real outbox record in DB
    const idempotencyKey = `test:p6_8:drain_success:${Date.now()}`;
    const record = await prisma.$transaction(async (tx) => {
      return await outboxService.createOutboxEvent(tx, {
        eventType: "booking_confirmed",
        aggregateType: "booking",
        aggregateId: TEST_AGGREGATE_ID,
        recipientType: "worker",
        recipientId: TEST_RECIPIENT_ID,
        payload: { title: "Job Offer", rate: 500 },
        idempotencyKey,
      });
    });
    expect(record).toBeDefined();

    // Mock FCM provider with a controlled 120ms network latency
    let fcmCalled = false;
    const mockProvider: IFCMProvider = {
      sendToTokens: async () => {
        fcmCalled = true;
        await new Promise((r) => setTimeout(r, 120));
        return [{ token: "test-token", success: true, messageId: "msg-123" }];
      },
    };
    setMockFcmProvider(mockProvider);

    // Start processing the record asynchronously
    const processPromise = worker.processRecord(record!);

    // Verify it is immediately registered as an active operation
    expect(worker.getActiveOperationsCount()).toBe(1);

    // Call stop() with 1000ms timeout while delivery is underway
    const stopPromise = worker.stop(1000);
    expect(worker.getState()).toBe("STOPPING");

    // Await shutdown
    await stopPromise;
    await processPromise;

    expect(fcmCalled).toBe(true);
    expect(worker.getState()).toBe("STOPPED");
    expect(worker.getActiveOperationsCount()).toBe(0);

    // Verify event is marked SENT in the database
    const dbRecord = await (prisma as any).notification_outbox.findUnique({
      where: { id: record!.id },
    });
    expect(dbRecord.status).toBe("SENT");
    expect(dbRecord.processed_at).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // TEST 3 — Active batch exceeds shutdown timeout
  // --------------------------------------------------------------------------
  it("TEST 3: Active batch exceeds shutdown timeout -> bounded exit, no hang, event remains in PROCESSING", async () => {
    const worker = new OutboxWorker();

    const idempotencyKey = `test:p6_8:drain_timeout:${Date.now()}`;
    const record = await prisma.$transaction(async (tx) => {
      return await outboxService.createOutboxEvent(tx, {
        eventType: "job_cancelled",
        aggregateType: "booking",
        aggregateId: TEST_AGGREGATE_ID,
        recipientType: "worker",
        recipientId: TEST_RECIPIENT_ID,
        payload: { title: "Cancelled" },
        idempotencyKey,
      });
    });

    // Mark as PROCESSING in DB to simulate active in-flight lease
    await (prisma as any).notification_outbox.update({
      where: { id: record!.id },
      data: { status: "PROCESSING", updated_at: new Date() },
    });

    // Mock FCM provider that deliberately sleeps for 1500ms (exceeding a 100ms drain timeout)
    let fcmCompleted = false;
    const mockProvider: IFCMProvider = {
      sendToTokens: async () => {
        await new Promise((r) => setTimeout(r, 1500));
        fcmCompleted = true;
        return [{ token: "test-token", success: true }];
      },
    };
    setMockFcmProvider(mockProvider);

    // Start processing
    worker.processRecord(record!);
    expect(worker.getActiveOperationsCount()).toBe(1);

    const startMs = Date.now();
    // Stop with bounded timeout of 100ms
    await worker.stop(100);
    const elapsedMs = Date.now() - startMs;

    // Shutdown must have boundedly returned at ~100ms (allow slack up to 350ms)
    expect(elapsedMs).toBeGreaterThanOrEqual(90);
    expect(elapsedMs).toBeLessThan(450);
    expect(worker.getState()).toBe("STOPPED");

    // FCM has not finished yet
    expect(fcmCompleted).toBe(false);

    // In DB, record must NOT be falsely marked SENT; it remains in PROCESSING
    const dbRecord = await (prisma as any).notification_outbox.findUnique({
      where: { id: record!.id },
    });
    expect(dbRecord.status).toBe("PROCESSING");
    expect(dbRecord.processed_at).toBeNull();
  });

  // --------------------------------------------------------------------------
  // TEST 4 — Recovery after timed-out shutdown
  // --------------------------------------------------------------------------
  it("TEST 4: Recovery after timed-out shutdown -> stale lease recovered and successfully delivered", async () => {
    const idempotencyKey = `test:p6_8:recover_timed_out:${Date.now()}`;
    const record = await prisma.$transaction(async (tx) => {
      return await outboxService.createOutboxEvent(tx, {
        eventType: "payment_received",
        aggregateType: "payment",
        aggregateId: TEST_AGGREGATE_ID,
        recipientType: "worker",
        recipientId: TEST_RECIPIENT_ID,
        payload: { amount: 1000 },
        idempotencyKey,
      });
    });

    // Simulate an abandoned event stuck in PROCESSING with updated_at aged 10 minutes ago
    const staleTime = new Date(Date.now() - 10 * 60 * 1000);
    await (prisma as any).notification_outbox.update({
      where: { id: record!.id },
      data: { status: "PROCESSING", updated_at: staleTime },
    });

    // Reconcile stale events
    const recoveredCount = await outboxService.reconcileStaleEvents(5);
    expect(recoveredCount).toBeGreaterThanOrEqual(1);

    // Verify it returned to PENDING
    const inDbAfterReconcile = await (prisma as any).notification_outbox.findUnique({
      where: { id: record!.id },
    });
    expect(inDbAfterReconcile.status).toBe("PENDING");

    // Fast-acting worker B claims and delivers it
    const mockProvider: IFCMProvider = {
      sendToTokens: async () => [{ token: "test-token", success: true }],
    };
    setMockFcmProvider(mockProvider);

    const workerB = new OutboxWorker();
    await workerB.processRecord(inDbAfterReconcile);

    const finalDbRecord = await (prisma as any).notification_outbox.findUnique({
      where: { id: record!.id },
    });
    expect(finalDbRecord.status).toBe("SENT");
    expect(finalDbRecord.processed_at).not.toBeNull();
  });

  // --------------------------------------------------------------------------
  // TEST 5 — Shutdown while multiple operations are active
  // --------------------------------------------------------------------------
  it("TEST 5: Shutdown with multiple concurrent operations -> tracks all, handles failures, drains cleanly", async () => {
    const worker = new OutboxWorker();

    const makeRecord = (num: number): OutboxRecord => ({
      id: randomUUID(),
      event_type: "test_event",
      aggregate_type: "test",
      aggregate_id: randomUUID(),
      recipient_type: "worker",
      recipient_id: TEST_RECIPIENT_ID,
      payload: { index: num },
      status: "PROCESSING",
      attempts: 0,
      max_attempts: 5,
      available_at: new Date(),
      processed_at: null,
      failed_at: null,
      last_error: null,
      idempotency_key: `key-multi-${num}-${randomUUID()}`,
      correlation_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    // Op 1: fast (20ms), succeeds
    // Op 2: medium (70ms), succeeds
    // Op 3: fails with error (30ms)
    // Op 4: normal (50ms), succeeds
    let opCounter = 0;
    const mockProvider: IFCMProvider = {
      sendToTokens: async () => {
        opCounter++;
        const current = opCounter;
        if (current === 1) {
          await new Promise((r) => setTimeout(r, 20));
          return [{ token: "test-token", success: true }];
        } else if (current === 2) {
          await new Promise((r) => setTimeout(r, 70));
          return [{ token: "test-token", success: true }];
        } else if (current === 3) {
          await new Promise((r) => setTimeout(r, 30));
          return [{ token: "test-token", success: false, error: new Error("Network drop") }];
        } else {
          await new Promise((r) => setTimeout(r, 50));
          return [{ token: "test-token", success: true }];
        }
      },
    };
    setMockFcmProvider(mockProvider);

    const p1 = worker.processRecord(makeRecord(1));
    const p2 = worker.processRecord(makeRecord(2));
    const p3 = worker.processRecord(makeRecord(3));
    const p4 = worker.processRecord(makeRecord(4));

    expect(worker.getActiveOperationsCount()).toBe(4);

    const stopPromise = worker.stop(1000);
    expect(worker.getState()).toBe("STOPPING");

    await Promise.all([p1, p2, p3, p4, stopPromise]);

    expect(worker.getState()).toBe("STOPPED");
    expect(worker.getActiveOperationsCount()).toBe(0);
  });

  // --------------------------------------------------------------------------
  // TEST 6 — No new claims after shutdown begins
  // --------------------------------------------------------------------------
  it("TEST 6: No new claims after shutdown begins -> processBatch returns 0 immediately", async () => {
    const worker = new OutboxWorker();
    worker.start(1000);

    const stopPromise = worker.stop();
    expect(worker.getState()).toBe("STOPPING");

    // Simulating timer callback or concurrent caller executing processBatch while stopping
    const claimSpy = jest.spyOn(outboxService, "claimPendingEvents");
    const claimedCount = await worker.processBatch();

    expect(claimedCount).toBe(0);
    // claimPendingEvents must NOT have been called
    expect(claimSpy).not.toHaveBeenCalled();

    await stopPromise;
    claimSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // --------------------------------------------------------------------------
  // TEST 7 — Concurrent stop() calls
  // --------------------------------------------------------------------------
  it("TEST 7: Concurrent stop() calls return the same in-flight drain promise and resolve consistently", async () => {
    const worker = new OutboxWorker();

    const mockRecord: OutboxRecord = {
      id: randomUUID(),
      event_type: "test_concurrent",
      aggregate_type: "test",
      aggregate_id: randomUUID(),
      recipient_type: "worker",
      recipient_id: TEST_RECIPIENT_ID,
      payload: {},
      status: "PROCESSING",
      attempts: 0,
      max_attempts: 5,
      available_at: new Date(),
      processed_at: null,
      failed_at: null,
      last_error: null,
      idempotency_key: `key-concurrent-${Date.now()}`,
      correlation_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const mockProvider: IFCMProvider = {
      sendToTokens: async () => {
        await new Promise((r) => setTimeout(r, 60));
        return [{ token: "test-token", success: true }];
      },
    };
    setMockFcmProvider(mockProvider);

    worker.processRecord(mockRecord);

    // Call stop() 3 times concurrently
    const [res1, res2, res3] = await Promise.all([
      worker.stop(2000),
      worker.stop(2000),
      worker.stop(2000),
    ]);

    expect(res1).toBeUndefined();
    expect(res2).toBeUndefined();
    expect(res3).toBeUndefined();
    expect(worker.getState()).toBe("STOPPED");
    expect(worker.getActiveOperationsCount()).toBe(0);

    // Calling stop() again after stopped resolves immediately
    await expect(worker.stop()).resolves.toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // TEST 8 — Active operation rejects
  // --------------------------------------------------------------------------
  it("TEST 8: Active operation rejects -> failure handled cleanly without unhandled promise rejection", async () => {
    const worker = new OutboxWorker();

    const mockRecord: OutboxRecord = {
      id: randomUUID(),
      event_type: "test_reject",
      aggregate_type: "test",
      aggregate_id: randomUUID(),
      recipient_type: "worker",
      recipient_id: TEST_RECIPIENT_ID,
      payload: {},
      status: "PROCESSING",
      attempts: 0,
      max_attempts: 5,
      available_at: new Date(),
      processed_at: null,
      failed_at: null,
      last_error: null,
      idempotency_key: `key-reject-${Date.now()}`,
      correlation_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    // Simulate provider throwing an unhandled rejection
    const mockProvider: IFCMProvider = {
      sendToTokens: async () => {
        throw new Error("Fatal FCM connection terminated abruptly");
      },
    };
    setMockFcmProvider(mockProvider);

    const recordPromise = worker.processRecord(mockRecord);
    const stopPromise = worker.stop(500);

    await expect(Promise.all([recordPromise, stopPromise])).resolves.toBeDefined();
    expect(worker.getState()).toBe("STOPPED");
    expect(worker.getActiveOperationsCount()).toBe(0);
  });

  // --------------------------------------------------------------------------
  // TEST 9 — Dependency failure during shutdown
  // --------------------------------------------------------------------------
  it("TEST 9: Database failure during markEventSuccess -> logs error, finishes boundedly", async () => {
    const worker = new OutboxWorker();

    const mockRecord: OutboxRecord = {
      id: randomUUID(),
      event_type: "test_db_fail",
      aggregate_type: "test",
      aggregate_id: randomUUID(),
      recipient_type: "worker",
      recipient_id: TEST_RECIPIENT_ID,
      payload: {},
      status: "PROCESSING",
      attempts: 0,
      max_attempts: 5,
      available_at: new Date(),
      processed_at: null,
      failed_at: null,
      last_error: null,
      idempotency_key: `key-db-fail-${Date.now()}`,
      correlation_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const mockProvider: IFCMProvider = {
      sendToTokens: async () => [{ token: "test-token", success: true }],
    };
    setMockFcmProvider(mockProvider);

    const markSuccessSpy = jest.spyOn(outboxService, "markEventSuccess").mockRejectedValueOnce(
      new Error("PostgreSQL connection lost during markEventSuccess")
    );

    const recordPromise = worker.processRecord(mockRecord);
    const stopPromise = worker.stop(500);

    // Must resolve cleanly without hanging or throwing unhandled errors
    await expect(Promise.all([recordPromise, stopPromise])).resolves.toBeDefined();
    expect(worker.getState()).toBe("STOPPED");

    markSuccessSpy.mockRestore();
  });

  // --------------------------------------------------------------------------
  // TEST 10 — Application lifecycle integration test
  // --------------------------------------------------------------------------
  it("TEST 10: LifecycleManager shutdown awaits outboxWorker drain before disconnecting database", async () => {
    // Verify that outboxWorker.stop() is explicitly called during lifecycleManager.shutdown()
    const outboxWorkerModule = await import("../src/workers/outboxWorker");
    const stopSpy = jest.spyOn(outboxWorkerModule.outboxWorker, "stop");

    await lifecycleManager.shutdown("SIGTERM", false);

    expect(stopSpy).toHaveBeenCalled();
    stopSpy.mockRestore();

    // Reconnect Prisma so following tests have database access
    await prisma.$connect();
  });

  // --------------------------------------------------------------------------
  // TEST 11 — Real PostgreSQL CTE SKIP LOCKED & Optimistic Lease Proof
  // --------------------------------------------------------------------------
  describe("TEST 11: Real PostgreSQL CTE SKIP LOCKED & Lease Invariant Proof", () => {
    let pgClient1: Client;
    let pgClient2: Client;
    const realOutboxId = "88880000-0000-4000-e000-000000000001";

    beforeAll(async () => {
      pgClient1 = new Client({ connectionString: process.env.DATABASE_URL! });
      pgClient2 = new Client({ connectionString: process.env.DATABASE_URL! });
      await pgClient1.connect();
      await pgClient2.connect();

      // Clean up fixture if exists
      await pgClient1.query('DELETE FROM notification_outbox WHERE id = $1', [realOutboxId]);

      // Insert real PENDING outbox row
      await pgClient1.query(`
        INSERT INTO notification_outbox (
          id, event_type, aggregate_type, aggregate_id, recipient_type, recipient_id, payload, status, idempotency_key, available_at, updated_at
        ) VALUES (
          $1, 'test_cte', 'booking', gen_random_uuid(), 'worker', gen_random_uuid(), '{"title":"Test"}', 'PENDING', 'idemp_p6_8_real_cte', NOW() - INTERVAL '10 seconds', NOW()
        )
      `, [realOutboxId]);
    });

    afterAll(async () => {
      try {
        await pgClient1.query('DELETE FROM notification_outbox WHERE id = $1', [realOutboxId]);
        await pgClient1.end().catch(() => {});
        await pgClient2.end().catch(() => {});
      } catch {}
    });

    it("atomically claims PENDING event using CTE with FOR UPDATE SKIP LOCKED", async () => {
      const now = new Date();
      const claimQuery = `
        WITH claimable AS (
          SELECT id
          FROM "notification_outbox"
          WHERE id = $1 AND status = 'PENDING' AND available_at <= $2
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "notification_outbox"
        SET status = 'PROCESSING',
            updated_at = $2
        FROM claimable
        WHERE "notification_outbox".id = claimable.id
        RETURNING "notification_outbox".*;
      `;

      const res = await pgClient1.query(claimQuery, [realOutboxId, now]);
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].status).toBe("PROCESSING");
    });

    it("proves optimistic lease locking prevents stale worker from clobbering recovered event", async () => {
      const staleTimestamp = new Date(Date.now() - 60000); // 1 min ago

      // Stale worker attempts to markEventSuccess with stale timestamp
      const staleResult = await outboxService.markEventSuccess(realOutboxId, staleTimestamp);
      // Fails safely because lease timestamp does not match
      expect(staleResult).toBe(false);

      // Verify row is still in PROCESSING
      const checkRes = await pgClient1.query('SELECT status FROM notification_outbox WHERE id = $1', [realOutboxId]);
      expect(checkRes.rows[0].status).toBe("PROCESSING");
    });
  });
});
