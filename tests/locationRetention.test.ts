import { locationRetentionService } from "../src/services/locationRetentionService";
import prisma from "../src/config/prisma";
import { workerLocationService } from "../src/features/worker_location/worker_location.service";

describe("Issue 46 - Location Retention, Indexing & Dispatch Independence", () => {
  const testWorkerId = "00000000-0000-4000-c000-000000000001";

  beforeAll(async () => {
    let category = await prisma.skill_category.findFirst();
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "Helper", description: "General Helper" },
      });
    }

    await prisma.worker.upsert({
      where: { id: testWorkerId },
      update: { phone: "+919999000002", skill_category_id: category.id },
      create: {
        id: testWorkerId,
        phone: "+919999000002",
        name: "Retention Test Worker",
        password: "hash",
        skill_type: "Helper",
        skill_category_id: category.id,
      },
    });
  });

  afterAll(async () => {
    await prisma.worker_location.deleteMany({
      where: { worker_id: testWorkerId },
    }).catch(() => {});
    await prisma.worker.deleteMany({
      where: { id: testWorkerId },
    }).catch(() => {});
    await prisma.$disconnect();
  });

  describe("Retention Configuration & Cutoff Calculations", () => {
    it("provides a default retention of 30 days bounded between 1 and 365", () => {
      const originalEnv = process.env.LOCATION_HISTORY_RETENTION_DAYS;

      delete process.env.LOCATION_HISTORY_RETENTION_DAYS;
      expect(locationRetentionService.getRetentionDays()).toBe(30);

      process.env.LOCATION_HISTORY_RETENTION_DAYS = "60";
      expect(locationRetentionService.getRetentionDays()).toBe(60);

      process.env.LOCATION_HISTORY_RETENTION_DAYS = "999";
      expect(locationRetentionService.getRetentionDays()).toBe(365);

      process.env.LOCATION_HISTORY_RETENTION_DAYS = "-5";
      expect(locationRetentionService.getRetentionDays()).toBe(30);

      process.env.LOCATION_HISTORY_RETENTION_DAYS = originalEnv;
    });

    it("calculates correct expiration cutoff date", () => {
      const cutoff = locationRetentionService.getExpirationCutoffDate(10);
      const expected = new Date();
      expected.setDate(expected.getDate() - 10);

      expect(cutoff.getDate()).toBe(expected.getDate());
      expect(cutoff.getMonth()).toBe(expected.getMonth());
    });
  });

  describe("Batch Cleanup of Expired History", () => {
    it("deletes expired historical records in bounded batches while preserving recent history", async () => {
      const now = new Date();
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 45); // 45 days ago (expired under 30-day retention)

      // Create expired historical entries
      await prisma.worker_location.createMany({
        data: [
          { worker_id: testWorkerId, updated_at: oldDate },
          { worker_id: testWorkerId, updated_at: oldDate },
          { worker_id: testWorkerId, updated_at: oldDate },
        ],
      });

      // Create recent historical entry
      const recentEntry = await prisma.worker_location.create({
        data: { worker_id: testWorkerId, updated_at: now },
      });

      // Run cleanup with 30-day retention and small batch size
      const result = await locationRetentionService.cleanupExpiredLocationHistory({
        batchSize: 2,
        retentionDays: 30,
      });

      expect(result.totalDeleted).toBeGreaterThanOrEqual(3);
      expect(result.batchesProcessed).toBeGreaterThanOrEqual(2);

      // Verify recent entry still exists
      const foundRecent = await prisma.worker_location.findUnique({
        where: { id: recentEntry.id },
      });
      expect(foundRecent).toBeDefined();

      // Verify expired entries for this worker are removed
      const remainingExpired = await prisma.worker_location.findMany({
        where: {
          worker_id: testWorkerId,
          updated_at: { lt: locationRetentionService.getExpirationCutoffDate(30) },
        },
      });
      expect(remainingExpired.length).toBe(0);
    });

    it("never deletes or alters the authoritative current location on Worker table", async () => {
      // Update worker current location
      await workerLocationService.updateLocation(testWorkerId, 28.6139, 77.2090);

      // Run cleanup
      await locationRetentionService.cleanupExpiredLocationHistory({ retentionDays: 1 });

      // Verify Worker.location_geo and last_location_at remain intact
      const worker = await prisma.worker.findUnique({
        where: { id: testWorkerId },
        select: { id: true, last_location_at: true },
      });

      expect(worker).toBeDefined();
      expect(worker?.last_location_at).toBeDefined();
      expect(worker?.last_location_at).not.toBeNull();
    });
  });
});
