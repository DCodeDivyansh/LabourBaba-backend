import fs from "fs";
import path from "path";
import os from "os";
import { createDatabaseBackup } from "../scripts/backup-db";
import { restoreAndVerifyDatabase } from "../scripts/restore-db";

describe("Issue 50 - Database Backup & Disaster Recovery Verification", () => {
  jest.setTimeout(30000);
  const testBackupDir = path.join(os.tmpdir(), "labourbaba-test-backups");

  beforeAll(() => {
    if (!fs.existsSync(testBackupDir)) {
      fs.mkdirSync(testBackupDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up test backups directory
    if (fs.existsSync(testBackupDir)) {
      fs.rmSync(testBackupDir, { recursive: true, force: true });
    }
  });

  describe("Automated Backup Creation", () => {
    it("creates a valid SQL backup file and matching SHA-256 checksum", async () => {
      const backup = await createDatabaseBackup({ backupDir: testBackupDir });

      expect(fs.existsSync(backup.backupPath)).toBe(true);
      expect(fs.existsSync(backup.checksumPath)).toBe(true);
      expect(backup.sizeBytes).toBeGreaterThan(0);
      expect(backup.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(backup.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Disaster Recovery & Integrity Verification", () => {
    it("verifies PostGIS extension and critical tables upon restore verification", async () => {
      const backup = await createDatabaseBackup({ backupDir: testBackupDir });

      const restore = await restoreAndVerifyDatabase({
        backupPath: backup.backupPath,
        targetDatabaseUrl: process.env.DATABASE_URL!,
      });

      expect(restore.verifiedTablesCount).toBeGreaterThan(0);
      expect(restore.postgisVersion).toBeDefined();
      expect(restore.totalRecoveryDurationMs).toBeGreaterThan(0);
      // Prove RTO target is met (< 15 minutes / 900,000ms)
      expect(restore.totalRecoveryDurationMs).toBeLessThan(900000);
    });

    it("fails and throws error when backup file is corrupted or checksum does not match", async () => {
      const backup = await createDatabaseBackup({ backupDir: testBackupDir });

      // Corrupt the backup content
      fs.appendFileSync(backup.backupPath, "\n-- Corrupted Data Payload");

      await expect(
        restoreAndVerifyDatabase({
          backupPath: backup.backupPath,
          targetDatabaseUrl: process.env.DATABASE_URL!,
          expectedChecksum: backup.checksum,
        })
      ).rejects.toThrow("Checksum mismatch");
    });
  });
});
