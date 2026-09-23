/**
 * scripts/revoke-exposed-sessions.ts
 *
 * P6 Issue 2 — Operational Credential Revocation Script
 *
 * PURPOSE:
 *   The database backup committed in commit dd6a3bc may have exposed:
 *   - refresh_session.token_hash rows (12 sessions)
 *   - worker_device.fcm_token values (5 device records)
 *   - worker.device_token values (8 records)
 *   - worker.password bcrypt hashes (61 records)
 *
 *   This script uses the EXISTING session and device revocation mechanisms
 *   (no new endpoints created) to:
 *   1. Revoke ALL refresh sessions created before the patch commit date.
 *   2. Mark potentially exposed worker_device FCM tokens as revoked.
 *   3. Clear device_token on worker records from the exposure window.
 *   4. Optionally invalidate bcrypt passwords on exposed worker accounts
 *      (forcing authentication via canonical phone OTP).
 *   5. Verify that zero active sessions/tokens remain in the exposure window.
 *
 * USAGE (requires production DATABASE_URL):
 *   DATABASE_URL=<prod-url> npx tsx scripts/revoke-exposed-sessions.ts [--dry-run] [--verify] [--invalidate-passwords]
 *
 * FLAGS:
 *   --dry-run              Audits affected record counts without modifying database
 *   --verify               Verifies that 0 active exposed records remain in the window
 *   --invalidate-passwords Invalidates exposed bcrypt password hashes for affected workers
 */

import crypto from "crypto";
import prisma from "../src/config/prisma";
import { SESSION_STATUS, REVOKE_REASON } from "../src/features/auth/session.types";
import { logger } from "../src/utils/logger";

// The backup timestamp: 2026-09-22T09:46:12.528Z
// All sessions created at or before this time may have had their token_hash exposed.
// We add a 1-hour safety margin to capture any sessions created in the window.
export const EXPOSURE_CUTOFF = new Date("2026-09-22T10:46:12.528Z");

export interface RevocationAuditCounts {
  activeRefreshSessions: number;
  unrevokedWorkerDevices: number;
  workersWithDeviceToken: number;
  workersWithPassword: number;
}

export interface RevocationExecutionResult {
  sessionsRevoked: number;
  devicesRevoked: number;
  workerDeviceTokensCleared: number;
  workerPasswordsInvalidated: number;
}

/**
 * Counts potentially exposed records created on or before the exposure cutoff.
 */
export async function auditExposedRecords(): Promise<RevocationAuditCounts> {
  const [
    activeRefreshSessions,
    unrevokedWorkerDevices,
    workersWithDeviceToken,
    workersWithPassword,
  ] = await Promise.all([
    prisma.refresh_session.count({
      where: {
        created_at: { lte: EXPOSURE_CUTOFF },
        status: { in: [SESSION_STATUS.ACTIVE, SESSION_STATUS.ROTATED] },
      },
    }),
    prisma.worker_device.count({
      where: {
        created_at: { lte: EXPOSURE_CUTOFF },
        revoked_at: null,
      },
    }),
    prisma.worker.count({
      where: {
        device_token: { not: null },
      },
    }),
    prisma.worker.count({
      where: {
        password: { not: { startsWith: "INVALIDATED_EXPOSURE_" } },
      },
    }),
  ]);

  return {
    activeRefreshSessions,
    unrevokedWorkerDevices,
    workersWithDeviceToken,
    workersWithPassword,
  };
}

/**
 * Revokes all refresh sessions created before the exposure cutoff.
 */
export async function revokeExposedRefreshSessions(): Promise<number> {
  const result = await prisma.refresh_session.updateMany({
    where: {
      created_at: { lte: EXPOSURE_CUTOFF },
      status: { in: [SESSION_STATUS.ACTIVE, SESSION_STATUS.ROTATED] },
    },
    data: {
      status: SESSION_STATUS.REVOKED,
      revoked_at: new Date(),
      revoked_reason: REVOKE_REASON.SECURITY_INCIDENT,
    },
  });
  return result.count;
}

/**
 * Revokes all worker_device FCM tokens created before the exposure cutoff.
 */
export async function revokeExposedWorkerDeviceTokens(): Promise<number> {
  const result = await prisma.worker_device.updateMany({
    where: {
      created_at: { lte: EXPOSURE_CUTOFF },
      revoked_at: null,
    },
    data: {
      revoked_at: new Date(),
      updated_at: new Date(),
    },
  });
  return result.count;
}

/**
 * Clears the denormalized device_token field on worker records.
 */
export async function clearExposedWorkerDeviceTokenFields(): Promise<number> {
  const result = await prisma.worker.updateMany({
    where: {
      device_token: { not: null },
    },
    data: {
      device_token: null,
    },
  });
  return result.count;
}

/**
 * Invalidates bcrypt password hashes for affected workers by setting
 * an unmatchable sentinel prefix, forcing authentication via phone OTP.
 */
export async function invalidateExposedWorkerPasswords(): Promise<number> {
  const sentinel = `INVALIDATED_EXPOSURE_${crypto.randomUUID()}`;
  const result = await prisma.worker.updateMany({
    where: {
      password: { not: { startsWith: "INVALIDATED_EXPOSURE_" } },
    },
    data: {
      password: sentinel,
    },
  });
  return result.count;
}

/**
 * Verifies that zero active sessions or active tokens remain in the exposure window.
 */
export async function verifyExposedRecordsRevoked(): Promise<{
  passed: boolean;
  remainingActiveSessions: number;
  remainingActiveDevices: number;
  remainingDeviceTokens: number;
}> {
  const [
    remainingActiveSessions,
    remainingActiveDevices,
    remainingDeviceTokens,
  ] = await Promise.all([
    prisma.refresh_session.count({
      where: {
        created_at: { lte: EXPOSURE_CUTOFF },
        status: { in: [SESSION_STATUS.ACTIVE, SESSION_STATUS.ROTATED] },
      },
    }),
    prisma.worker_device.count({
      where: {
        created_at: { lte: EXPOSURE_CUTOFF },
        revoked_at: null,
      },
    }),
    prisma.worker.count({
      where: {
        device_token: { not: null },
      },
    }),
  ]);

  const passed =
    remainingActiveSessions === 0 &&
    remainingActiveDevices === 0 &&
    remainingDeviceTokens === 0;

  return {
    passed,
    remainingActiveSessions,
    remainingActiveDevices,
    remainingDeviceTokens,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const isVerifyOnly = args.includes("--verify");
  const shouldInvalidatePasswords = args.includes("--invalidate-passwords");

  if (!process.env.DATABASE_URL) {
    console.error("[INCIDENT_RESPONSE] DATABASE_URL is required. Refusing to proceed without explicit configuration.");
    process.exit(1);
  }

  logger.warn("[INCIDENT_RESPONSE] === P6 Issue 2 Credential & Session Incident Response ===");
  logger.warn(`[INCIDENT_RESPONSE] Exposure cutoff: ${EXPOSURE_CUTOFF.toISOString()}`);
  logger.warn(`[INCIDENT_RESPONSE] Mode: ${isVerifyOnly ? "VERIFY_ONLY" : isDryRun ? "DRY_RUN" : "EXECUTE"}`);

  try {
    const counts = await auditExposedRecords();
    logger.warn(`[INCIDENT_RESPONSE] Audit of records in exposure window:`);
    logger.warn(`  - Active/Rotated Refresh Sessions: ${counts.activeRefreshSessions}`);
    logger.warn(`  - Active Worker Device FCM Records: ${counts.unrevokedWorkerDevices}`);
    logger.warn(`  - Workers with Denormalized device_token: ${counts.workersWithDeviceToken}`);
    logger.warn(`  - Workers with Active Passwords: ${counts.workersWithPassword}`);

    if (isVerifyOnly) {
      const verification = await verifyExposedRecordsRevoked();
      if (verification.passed) {
        logger.warn("[INCIDENT_RESPONSE] SUCCESS: All exposed sessions and device tokens are revoked.");
        process.exit(0);
      } else {
        logger.error(`[INCIDENT_RESPONSE] FAILED: Active records remain in window!`, verification);
        process.exit(1);
      }
    }

    if (isDryRun) {
      logger.warn("[INCIDENT_RESPONSE] DRY RUN completed. No database mutations performed.");
      process.exit(0);
    }

    // Execute actual revocations
    const sessionsRevoked = await revokeExposedRefreshSessions();
    const devicesRevoked = await revokeExposedWorkerDeviceTokens();
    const workerDeviceTokensCleared = await clearExposedWorkerDeviceTokenFields();
    let workerPasswordsInvalidated = 0;

    if (shouldInvalidatePasswords) {
      workerPasswordsInvalidated = await invalidateExposedWorkerPasswords();
    }

    logger.warn("[INCIDENT_RESPONSE] === Revocation Execution Completed ===");
    logger.warn(`  - Sessions revoked: ${sessionsRevoked} (reason: ${REVOKE_REASON.SECURITY_INCIDENT})`);
    logger.warn(`  - Worker device FCM records revoked: ${devicesRevoked}`);
    logger.warn(`  - Worker device_token fields cleared: ${workerDeviceTokensCleared}`);
    if (shouldInvalidatePasswords) {
      logger.warn(`  - Worker bcrypt passwords invalidated: ${workerPasswordsInvalidated}`);
    }

    // Run verification after revocation
    const verification = await verifyExposedRecordsRevoked();
    logger.warn(`[INCIDENT_RESPONSE] Post-revocation verification: ${verification.passed ? "PASSED" : "FAILED"}`);

    process.exit(verification.passed ? 0 : 1);
  } catch (err) {
    logger.error("[INCIDENT_RESPONSE] Revocation execution failed", { error: err });
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main();
}
