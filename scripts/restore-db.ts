import fs from "fs";
import crypto from "crypto";
import dotenv from "dotenv";
import { Client } from "pg";
import { assertSafeRestoreTarget } from "../src/utils/databaseSafety";

dotenv.config();

export interface RestoreResult {
  backupPath: string;
  targetDatabase: string;
  databaseName: string;
  restoreDurationMs: number;
  verificationDurationMs: number;
  totalRecoveryDurationMs: number;
  postgisVersion: string;
  spatialQueryOk: boolean;
  spatialDistanceMeters: number;
  verifiedTablesCount: number;
  verifiedIndexesCount: number;
  verifiedConstraintsCount: number;
  verifiedForeignKeysCount: number;
  verifiedSequencesCount: number;
  tableNames: string[];
}

export async function restoreAndVerifyDatabase(options: {
  backupPath: string;
  targetDatabaseUrl: string;
  expectedChecksum?: string;
  bypassPrimaryMatchCheck?: boolean;
}): Promise<RestoreResult> {
  const overallStartTime = Date.now();
  const { backupPath, targetDatabaseUrl } = options;

  // 1. Safety Guard — Prohibit restoring into production, staging, or active primary DB
  const safety = assertSafeRestoreTarget(targetDatabaseUrl, {
    bypassPrimaryMatchCheck: options.bypassPrimaryMatchCheck,
  });

  if (!fs.existsSync(backupPath)) {
    throw new Error(`[RESTORE_ERROR] Backup file not found at path: ${backupPath}`);
  }

  // 2. Cryptographic Checksum Verification (Tamper / Corruption Detection)
  const checksumPath = `${backupPath}.sha256`;
  let expectedChecksum = options.expectedChecksum;
  if (!expectedChecksum && fs.existsSync(checksumPath)) {
    expectedChecksum = fs.readFileSync(checksumPath, "utf-8").trim();
  }

  if (expectedChecksum) {
    const fileBuffer = fs.readFileSync(backupPath);
    const actualChecksum = crypto.createHash("sha256").update(fileBuffer).digest("hex");
    if (actualChecksum !== expectedChecksum) {
      throw new Error(
        `[RESTORE_ERROR] Checksum mismatch! Expected: ${expectedChecksum}, Actual: ${actualChecksum}`
      );
    }
  }

  // 3. Connect to Target Database & Execute Restore
  const restoreStartTime = Date.now();
  const client = new Client({
    connectionString: targetDatabaseUrl,
    ssl: targetDatabaseUrl.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  let postgisVersion = "unknown";
  let verifiedTablesCount = 0;
  let verifiedIndexesCount = 0;
  let verifiedConstraintsCount = 0;
  let verifiedForeignKeysCount = 0;
  let verifiedSequencesCount = 0;
  let spatialQueryOk = false;
  let spatialDistanceMeters = 0;
  let tableNames: string[] = [];
  let restoreDurationMs = 0;
  let verificationDurationMs = 0;

  try {
    const sqlContent = fs.readFileSync(backupPath, "utf-8");

    // Execute restore script with disabled trigger cascading for clean restore
    await client.query("SET session_replication_role = 'replica';").catch(() => {});
    await client.query(sqlContent);
    await client.query("SET session_replication_role = 'origin';").catch(() => {});
    restoreDurationMs = Date.now() - restoreStartTime;

    // 4. Comprehensive Post-Restore Verification
    const verifyStartTime = Date.now();

    // Verify PostGIS extension
    const postgisRes = await client.query("SELECT PostGIS_Version();");
    postgisVersion = postgisRes.rows[0]?.postgis_version || "enabled";

    // Verify Real Spatial PostGIS Function Execution (ST_Distance)
    const spatialRes = await client.query(`
      SELECT ST_Distance(
        ST_SetSRID(ST_MakePoint(77.2090, 28.6139), 4326)::geography,
        ST_SetSRID(ST_MakePoint(77.2100, 28.6140), 4326)::geography
      ) AS dist_meters;
    `);
    if (spatialRes.rows.length > 0 && spatialRes.rows[0].dist_meters !== null) {
      spatialQueryOk = true;
      spatialDistanceMeters = parseFloat(spatialRes.rows[0].dist_meters);
    }

    // Verify Public Business Tables
    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
        AND table_name NOT IN ('spatial_ref_sys', 'geography_columns', 'geometry_columns')
      ORDER BY table_name;
    `);
    tableNames = tablesRes.rows.map((r: any) => r.table_name);
    verifiedTablesCount = tableNames.length;

    // Verify Constraints
    const constraintsRes = await client.query(`
      SELECT count(*) AS total_constraints
      FROM information_schema.table_constraints
      WHERE table_schema = 'public';
    `);
    verifiedConstraintsCount = parseInt(constraintsRes.rows[0]?.total_constraints || "0", 10);

    // Verify Foreign Keys
    const fkRes = await client.query(`
      SELECT count(*) AS total_fks
      FROM information_schema.referential_constraints;
    `);
    verifiedForeignKeysCount = parseInt(fkRes.rows[0]?.total_fks || "0", 10);

    // Verify Indexes
    const idxRes = await client.query(`
      SELECT count(*) AS total_indexes
      FROM pg_indexes
      WHERE schemaname = 'public';
    `);
    verifiedIndexesCount = parseInt(idxRes.rows[0]?.total_indexes || "0", 10);

    // Verify Sequences
    const seqRes = await client.query(`
      SELECT count(*) AS total_sequences
      FROM information_schema.sequences
      WHERE sequence_schema IN ('public', 'tiger', 'topology');
    `);
    verifiedSequencesCount = parseInt(seqRes.rows[0]?.total_sequences || "0", 10);

    verificationDurationMs = Date.now() - verifyStartTime;
  } finally {
    await client.end();
  }

  const totalRecoveryDurationMs = Date.now() - overallStartTime;

  return {
    backupPath,
    targetDatabase: safety.redactedUrl,
    databaseName: safety.databaseName,
    restoreDurationMs,
    verificationDurationMs,
    totalRecoveryDurationMs,
    postgisVersion,
    spatialQueryOk,
    spatialDistanceMeters,
    verifiedTablesCount,
    verifiedIndexesCount,
    verifiedConstraintsCount,
    verifiedForeignKeysCount,
    verifiedSequencesCount,
    tableNames,
  };
}

if (require.main === module) {
  const backupFile = process.argv[2];
  const targetDb = process.env.RESTORE_TARGET_DATABASE_URL || process.argv[3];

  if (!backupFile) {
    console.error("[RESTORE_USAGE_ERROR] Usage: npx tsx scripts/restore-db.ts <backup_file.sql> [target_database_url]");
    console.error("                       Or set RESTORE_TARGET_DATABASE_URL environment variable.");
    process.exit(1);
  }

  if (!targetDb) {
    console.error("[RESTORE_SECURITY_ERROR] No target database URL provided.");
    console.error("  Set RESTORE_TARGET_DATABASE_URL to an approved disposable test/DR database.");
    console.error("  Implicit fallback to application DATABASE_URL is strictly forbidden.");
    process.exit(1);
  }

  restoreAndVerifyDatabase({
    backupPath: backupFile,
    targetDatabaseUrl: targetDb,
  })
    .then((result) => {
      console.log(
        `[RESTORE_SUCCESS] Restored into ${result.targetDatabase} in ${result.totalRecoveryDurationMs}ms.\n` +
        `  - PostGIS: ${result.postgisVersion} (Spatial Query OK: ${result.spatialQueryOk}, Distance: ${result.spatialDistanceMeters.toFixed(2)}m)\n` +
        `  - Tables: ${result.verifiedTablesCount}\n` +
        `  - Indexes: ${result.verifiedIndexesCount}\n` +
        `  - Constraints: ${result.verifiedConstraintsCount}\n` +
        `  - Foreign Keys: ${result.verifiedForeignKeysCount}\n` +
        `  - Sequences: ${result.verifiedSequencesCount}`
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error("[RESTORE_FAILED]", err.message || err);
      process.exit(1);
    });
}
