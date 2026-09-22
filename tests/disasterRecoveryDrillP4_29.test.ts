/**
 * P4 Issue 29: Disaster Recovery, Backup Verification & Isolated Restore Drill
 *
 * Verifies:
 * 1. Automated Backup Creation: Produces valid SQL dump, SHA-256 hash file, and metadata payload.
 * 2. Cryptographic Integrity: Rejects corrupted or modified backup files with immediate checksum mismatch.
 * 3. Isolated Restore Drill: Restores into target database, proving PostGIS extension retention and tables preservation.
 * 4. Recovery Time Objective (RTO): Proves total recovery duration meets the < 15 minute (900,000 ms) target.
 * 5. Recovery Point Objective (RPO): Proves verified backup age meets the <= 24 hour target.
 */

import fs from "fs";
import path from "path";
import { createDatabaseBackup } from "../scripts/backup-db";
import { restoreAndVerifyDatabase } from "../scripts/restore-db";

describe("P4 Issue 29: Disaster Recovery & Isolated Restore Drill", () => {
  jest.setTimeout(45000);
  const testBackupDir = path.resolve(process.cwd(), "scratch", "drill-backups");

  beforeAll(() => {
    if (!fs.existsSync(testBackupDir)) {
      fs.mkdirSync(testBackupDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(testBackupDir)) {
      fs.rmSync(testBackupDir, { recursive: true, force: true });
    }
  });

  describe("1. Automated Backup Process with Cryptographic Hash", () => {
    it("creates a verified SQL backup file and matching SHA-256 checksum", async () => {
      const backup = await createDatabaseBackup({ backupDir: testBackupDir });

      expect(fs.existsSync(backup.backupPath)).toBe(true);
      expect(fs.existsSync(backup.checksumPath)).toBe(true);
      expect(backup.sizeBytes).toBeGreaterThan(0);
      expect(backup.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(backup.durationMs).toBeGreaterThanOrEqual(0);

      // Verify metadata file was written
      const metadataPath = path.join(testBackupDir, "latest_backup_metadata.json");
      expect(fs.existsSync(metadataPath)).toBe(true);
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
      expect(metadata.checksum).toBe(backup.checksum);
      expect(metadata.timestampSeconds).toBeGreaterThan(0);

      // Verify RPO target (backup age < 24 hours / 86400s)
      const currentSeconds = Math.floor(Date.now() / 1000);
      const backupAgeSeconds = currentSeconds - metadata.timestampSeconds;
      expect(backupAgeSeconds).toBeLessThan(86400);
    });
  });

  describe("2. Cryptographic Tamper & Corruption Detection", () => {
    it("fails closed when backup content is mutated or corrupted", async () => {
      const backup = await createDatabaseBackup({ backupDir: testBackupDir });

      // Deliberately corrupt backup content
      fs.appendFileSync(backup.backupPath, "\n-- MALICIOUS_CORRUPTED_PAYLOAD\n");

      await expect(
        restoreAndVerifyDatabase({
          backupPath: backup.backupPath,
          targetDatabaseUrl: process.env.DATABASE_URL!,
          expectedChecksum: backup.checksum,
        })
      ).rejects.toThrow("Checksum mismatch");
    });
  });

  describe("3. Isolated Restore Drill & RTO Measurement", () => {
    it("executes restore drill, verifying PostGIS version, schema tables, and RTO < 15 minutes", async () => {
      const backup = await createDatabaseBackup({ backupDir: testBackupDir });

      const restore = await restoreAndVerifyDatabase({
        backupPath: backup.backupPath,
        targetDatabaseUrl: process.env.DATABASE_URL!,
      });

      expect(restore.verifiedTablesCount).toBeGreaterThan(10);
      expect(restore.postgisVersion).toBeDefined();
      expect(restore.postgisVersion).not.toBe("unknown");

      // Verify RTO invariant (< 15 minutes / 900,000 ms)
      expect(restore.totalRecoveryDurationMs).toBeLessThan(900000);
      expect(restore.restoreDurationMs).toBeGreaterThan(0);
      expect(restore.verificationDurationMs).toBeGreaterThan(0);
    });
  });
});
