import fs from "fs";
import crypto from "crypto";
import dotenv from "dotenv";
import { Client } from "pg";

dotenv.config();

export interface RestoreResult {
  backupPath: string;
  targetDatabase: string;
  restoreDurationMs: number;
  verificationDurationMs: number;
  totalRecoveryDurationMs: number;
  postgisVersion: string;
  verifiedTablesCount: number;
}

export async function restoreAndVerifyDatabase(options: {
  backupPath: string;
  targetDatabaseUrl: string;
  expectedChecksum?: string;
}): Promise<RestoreResult> {
  const overallStartTime = Date.now();
  const { backupPath, targetDatabaseUrl } = options;

  if (!fs.existsSync(backupPath)) {
    throw new Error(`[RESTORE_ERROR] Backup file not found at path: ${backupPath}`);
  }

  // 1. Verify Checksum if present
  const checksumPath = `${backupPath}.sha256`;
  let expectedChecksum = options.expectedChecksum;
  if (!expectedChecksum && fs.existsSync(checksumPath)) {
    expectedChecksum = fs.readFileSync(checksumPath, "utf-8").trim();
  }

  if (expectedChecksum) {
    const fileBuffer = fs.readFileSync(backupPath);
    const actualChecksum = crypto.createHash("sha256").update(fileBuffer).digest("hex");
    if (actualChecksum !== expectedChecksum) {
      throw new Error(`[RESTORE_ERROR] Checksum mismatch! Expected: ${expectedChecksum}, Actual: ${actualChecksum}`);
    }
  }

  // 2. Connect to target database and execute restore
  const restoreStartTime = Date.now();
  const client = new Client({ connectionString: targetDatabaseUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  let postgisVersion = "unknown";
  let verifiedTablesCount = 0;
  let restoreDurationMs = 0;
  let verificationDurationMs = 0;

  try {
    const sqlContent = fs.readFileSync(backupPath, "utf-8");

    // Execute restore statements with disabled trigger cascade if supported
    await client.query("SET session_replication_role = 'replica';").catch(() => {});
    await client.query(sqlContent);
    await client.query("SET session_replication_role = 'origin';").catch(() => {});
    restoreDurationMs = Date.now() - restoreStartTime;

    // 3. Post-Restore Verification
    const verifyStartTime = Date.now();

    // Verify PostGIS extension
    const postgisRes = await client.query("SELECT PostGIS_Version();");
    postgisVersion = postgisRes.rows[0]?.postgis_version || "enabled";

    // Verify critical tables exist
    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `);

    verifiedTablesCount = tablesRes.rows.length;
    verificationDurationMs = Date.now() - verifyStartTime;

  } finally {
    await client.end();
  }

  const totalRecoveryDurationMs = Date.now() - overallStartTime;

  return {
    backupPath,
    targetDatabase: targetDatabaseUrl.replace(/:\/\/.*@/, "://***@"),
    restoreDurationMs,
    verificationDurationMs,
    totalRecoveryDurationMs,
    postgisVersion,
    verifiedTablesCount,
  };
}

if (require.main === module) {
  const backupFile = process.argv[2] || "backups/latest.sql";
  const targetDb = process.env.RESTORE_TARGET_DATABASE_URL || process.env.DATABASE_URL!;

  restoreAndVerifyDatabase({
    backupPath: backupFile,
    targetDatabaseUrl: targetDb,
  })
    .then((result) => {
      console.log(`[RESTORE_SUCCESS] Restored into ${result.targetDatabase} in ${result.totalRecoveryDurationMs}ms. PostGIS: ${result.postgisVersion}, Verified Tables: ${result.verifiedTablesCount}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[RESTORE_FAILED]", err);
      process.exit(1);
    });
}
