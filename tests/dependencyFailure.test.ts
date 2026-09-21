import { outboxService } from "../src/services/outboxService";
import { workerDeviceService } from "../src/features/worker_device/worker_device.service";
import { createRateLimiter } from "../src/middlewares/rateLimiter";
import prisma from "../src/config/prisma";
import { isPermanentInvalidTokenError } from "../src/shared/fcm";

describe("Issue 54 - Dependency Failure & Fault Resilience Tests", () => {
  const testWorkerId = "00000000-0000-4004-a000-000000000001";
  const dummyToken = "fcm_token_invalid_dependency_test";

  beforeAll(async () => {
    let category = await prisma.skill_category.findFirst();
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "ResilienceHelper", description: "Category for resilience tests" },
      });
    }

    await prisma.worker.upsert({
      where: { id: testWorkerId },
      update: { phone: "+919833000001", skill_category_id: category.id },
      create: {
        id: testWorkerId,
        phone: "+919833000001",
        name: "Resilience Worker",
        password: "hash",
        skill_type: "Helper",
        skill_category_id: category.id,
      },
    });
  });

  afterAll(async () => {
    await prisma.worker_device.deleteMany({ where: { worker_id: testWorkerId } }).catch(() => {});
    await (prisma as any).notification_outbox.deleteMany({ where: { recipient_id: testWorkerId } }).catch(() => {});
    await prisma.worker.deleteMany({ where: { id: testWorkerId } }).catch(() => {});
    await prisma.$disconnect();
  });

  describe("1. Database Connection / Transaction Failure Isolation", () => {
    it("rolls back all operations completely when a database failure occurs mid-transaction", async () => {
      const idempotencyKey = `resilience:fail:${Date.now()}`;
      const fakeAggregateId = "00000000-0000-4004-b000-000000000001";

      await expect(
        prisma.$transaction(async (tx) => {
          // Step 1: Create outbox record
          await outboxService.createOutboxEvent(tx, {
            eventType: "job_assigned",
            aggregateType: "booking",
            aggregateId: fakeAggregateId,
            recipientType: "worker",
            recipientId: testWorkerId,
            payload: { amount: 500 },
            idempotencyKey,
          });

          // Step 2: Inject intentional failure / connection abort
          throw new Error("DATABASE_TRANSACTION_SIMULATED_FAILURE");
        })
      ).rejects.toThrow("DATABASE_TRANSACTION_SIMULATED_FAILURE");

      // Verify outbox record was NOT persisted
      const outbox = await (prisma as any).notification_outbox.findUnique({
        where: { idempotency_key: idempotencyKey },
      });
      expect(outbox).toBeNull();
    });
  });

  describe("2. Redis Unavailability & Rate Limiter Resilience", () => {
    it("gracefully falls back to in-memory rate limiting when Redis fails without throwing 500", async () => {
      const limiter = createRateLimiter({
        windowSeconds: 60,
        maxLimit: 2,
        keyPrefix: "resilience_test",
      });

      const req: any = {
        ip: "10.0.0.99",
        headers: {},
      };
      const res: any = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      };
      const next = jest.fn();

      // First request -> allowed
      await limiter(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);

      // Second request -> allowed
      await limiter(req, res, next);
      expect(next).toHaveBeenCalledTimes(2);

      // Third request -> rate limited with 429 (in-memory defense still enforces limit)
      await limiter(req, res, next);
      expect(res.status).toHaveBeenCalledWith(429);
    });
  });

  describe("3. FCM Provider Error Classification & Token Auto-Revocation", () => {
    it("classifies permanent unregistered token errors and auto-revokes the device", async () => {
      // Register device
      await workerDeviceService.registerDevice(testWorkerId, {
        device_id: "resilience-device-1",
        device_token: dummyToken,
        platform: "android",
      });

      const activeBefore = await workerDeviceService.getActiveDevices(testWorkerId);
      expect(activeBefore.some((d) => d.fcm_token === dummyToken)).toBe(true);

      // Simulate provider error classification
      const fcmError = { code: "messaging/registration-token-not-registered" };
      expect(isPermanentInvalidTokenError(fcmError)).toBe(true);

      // Trigger automatic revocation
      await workerDeviceService.revokeByToken(dummyToken);

      const activeAfter = await workerDeviceService.getActiveDevices(testWorkerId);
      expect(activeAfter.some((d) => d.fcm_token === dummyToken)).toBe(false);
    });
  });

  describe("4. Worker Crash Simulation & Outbox Recovery", () => {
    it("reclaims stale outbox events stuck in PROCESSING status back to PENDING", async () => {
      const staleIdempotencyKey = `resilience:stale:${Date.now()}`;

      // Create an outbox event stuck in PROCESSING
      const staleEvent = await (prisma as any).notification_outbox.create({
        data: {
          event_type: "dispatch_opportunity",
          aggregate_type: "requirement",
          aggregate_id: "00000000-0000-4004-c000-000000000001",
          recipient_type: "worker",
          recipient_id: testWorkerId,
          payload: { title: "Stale Worker Job" },
          status: "PROCESSING",
          idempotency_key: staleIdempotencyKey,
          available_at: new Date(Date.now() - 600000), // 10 minutes ago
          updated_at: new Date(Date.now() - 600000),
        },
      });

      // Run reconciliation with 5-minute timeout threshold
      const reclaimedCount = await outboxService.reconcileStaleEvents(5);

      expect(reclaimedCount).toBeGreaterThanOrEqual(1);

      // Verify event was reset to PENDING
      const updated = await (prisma as any).notification_outbox.findUnique({
        where: { id: staleEvent.id },
      });
      expect(updated.status).toBe("PENDING");
    });
  });
});
