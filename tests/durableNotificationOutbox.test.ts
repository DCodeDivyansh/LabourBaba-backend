import { outboxService } from "../src/services/outboxService";
import { OutboxWorker } from "../src/workers/outboxWorker";
import prisma from "../src/config/prisma";

describe("Issue 44 - Durable Notification Outbox", () => {
  const testWorkerId = "00000000-0000-4000-a000-000000000001";
  const testRequirementId = "00000000-0000-4000-a000-000000000002";

  afterAll(async () => {
    // Clean up test outbox records
    await (prisma as any).notification_outbox.deleteMany({
      where: {
        recipient_id: testWorkerId,
      },
    }).catch(() => {});
    await prisma.$disconnect();
  });

  describe("Transactional Atomicity", () => {
    it("persists outbox record atomically within a successful transaction", async () => {
      const idempotencyKey = `test:outbox:atomic:${Date.now()}`;

      const created = await prisma.$transaction(async (tx) => {
        return await outboxService.createOutboxEvent(tx, {
          eventType: "incoming_job",
          aggregateType: "requirement",
          aggregateId: testRequirementId,
          recipientType: "worker",
          recipientId: testWorkerId,
          payload: { title: "Test Job", rate: 500 },
          idempotencyKey,
        });
      });

      expect(created).toBeDefined();
      expect(created?.status).toBe("PENDING");
      expect(created?.idempotency_key).toBe(idempotencyKey);

      // Verify record exists in DB
      const recordInDb = await (prisma as any).notification_outbox.findUnique({
        where: { id: created?.id },
      });
      expect(recordInDb).toBeDefined();
      expect(recordInDb.status).toBe("PENDING");
    });

    it("does not persist outbox record if the surrounding transaction rolls back", async () => {
      const idempotencyKey = `test:outbox:rollback:${Date.now()}`;

      await expect(
        prisma.$transaction(async (tx) => {
          await outboxService.createOutboxEvent(tx, {
            eventType: "incoming_job",
            aggregateType: "requirement",
            aggregateId: testRequirementId,
            recipientType: "worker",
            recipientId: testWorkerId,
            payload: { title: "Rollback Job" },
            idempotencyKey,
          });

          // Simulate intentional error causing rollback
          throw new Error("Intentional transaction failure");
        })
      ).rejects.toThrow("Intentional transaction failure");

      // Verify that no outbox record was written
      const found = await (prisma as any).notification_outbox.findUnique({
        where: { idempotency_key: idempotencyKey },
      });
      expect(found).toBeNull();
    });
  });

  describe("Outbox Lifecycle State Machine & Retries", () => {
    it("claims pending events and transitions status to PROCESSING", async () => {
      const idempotencyKey = `test:outbox:claim:${Date.now()}`;

      const event = await prisma.$transaction(async (tx) => {
        return await outboxService.createOutboxEvent(tx, {
          eventType: "job_cancelled",
          aggregateType: "requirement",
          aggregateId: testRequirementId,
          recipientType: "worker",
          recipientId: testWorkerId,
          payload: { reason: "Customer cancelled" },
          idempotencyKey,
        });
      });

      const claimed = await outboxService.claimPendingEvents(50);
      const isOurEventClaimed = claimed.some((e) => e.id === event?.id);
      expect(isOurEventClaimed).toBe(true);

      const inDb = await (prisma as any).notification_outbox.findUnique({
        where: { id: event?.id },
      });
      expect(inDb.status).toBe("PROCESSING");
    });

    it("marks successfully delivered events as SENT", async () => {
      const event = await prisma.$transaction(async (tx) => {
        return await outboxService.createOutboxEvent(tx, {
          eventType: "booking_confirmed",
          aggregateType: "requirement",
          aggregateId: testRequirementId,
          recipientType: "worker",
          recipientId: testWorkerId,
          payload: { bookingId: "b-1" },
          idempotencyKey: `test:outbox:sent:${Date.now()}`,
        });
      });

      await outboxService.markEventSuccess(event!.id);

      const inDb = await (prisma as any).notification_outbox.findUnique({
        where: { id: event?.id },
      });
      expect(inDb.status).toBe("SENT");
      expect(inDb.processed_at).toBeDefined();
    });

    it("handles transient failure with exponential backoff and retry scheduling", async () => {
      const event = await prisma.$transaction(async (tx) => {
        return await outboxService.createOutboxEvent(tx, {
          eventType: "incoming_job",
          aggregateType: "requirement",
          aggregateId: testRequirementId,
          recipientType: "worker",
          recipientId: testWorkerId,
          payload: { test: true },
          idempotencyKey: `test:outbox:retry:${Date.now()}`,
        });
      });

      await outboxService.markEventFailure(event!.id, "Transient network timeout", false);

      const inDb = await (prisma as any).notification_outbox.findUnique({
        where: { id: event?.id },
      });
      expect(inDb.status).toBe("PENDING");
      expect(inDb.attempts).toBe(1);
      expect(inDb.last_error).toBe("Transient network timeout");
      expect(new Date(inDb.available_at).getTime()).toBeGreaterThan(Date.now());
    });

    it("marks permanent failure as FAILED without infinite retries", async () => {
      const event = await prisma.$transaction(async (tx) => {
        return await outboxService.createOutboxEvent(tx, {
          eventType: "incoming_job",
          aggregateType: "requirement",
          aggregateId: testRequirementId,
          recipientType: "worker",
          recipientId: testWorkerId,
          payload: { test: true },
          idempotencyKey: `test:outbox:failed:${Date.now()}`,
        });
      });

      await outboxService.markEventFailure(event!.id, "Invalid recipient token", true);

      const inDb = await (prisma as any).notification_outbox.findUnique({
        where: { id: event?.id },
      });
      expect(inDb.status).toBe("FAILED");
      expect(inDb.failed_at).toBeDefined();
      expect(inDb.last_error).toBe("Invalid recipient token");
    });
  });

  describe("Startup Crash Recovery", () => {
    it("reconciles stale PROCESSING events back to PENDING", async () => {
      const event = await prisma.$transaction(async (tx) => {
        return await outboxService.createOutboxEvent(tx, {
          eventType: "incoming_job",
          aggregateType: "requirement",
          aggregateId: testRequirementId,
          recipientType: "worker",
          recipientId: testWorkerId,
          payload: { test: true },
          idempotencyKey: `test:outbox:stale:${Date.now()}`,
        });
      });

      // Manually set status to PROCESSING with an old updated_at
      await (prisma as any).notification_outbox.update({
        where: { id: event!.id },
        data: {
          status: "PROCESSING",
          updated_at: new Date(Date.now() - 10 * 60 * 1000), // 10 mins ago
        },
      });

      const recoveredCount = await outboxService.reconcileStaleEvents(5);
      expect(recoveredCount).toBeGreaterThanOrEqual(1);

      const inDb = await (prisma as any).notification_outbox.findUnique({
        where: { id: event?.id },
      });
      expect(inDb.status).toBe("PENDING");
    });
  });
});
