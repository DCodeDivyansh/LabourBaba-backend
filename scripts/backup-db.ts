import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import dotenv from "dotenv";
import { Client } from "pg";

dotenv.config();

export interface BackupResult {
  backupPath: string;
  checksumPath: string;
  checksum: string;
  sizeBytes: number;
  durationMs: number;
  timestamp: string;
}

export async function createDatabaseBackup(options?: {
  backupDir?: string;
  databaseUrl?: string;
}): Promise<BackupResult> {
  const startTime = Date.now();
  const dbUrl = options?.databaseUrl || process.env.DATABASE_URL;

  if (!dbUrl) {
    throw new Error("[BACKUP_ERROR] DATABASE_URL is required to perform database backup.");
  }

  const backupDir = options?.backupDir || path.resolve(process.cwd(), "backups");
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFileName = `backup_${timestamp}.sql`;
  const backupFilePath = path.join(backupDir, backupFileName);
  const checksumFilePath = `${backupFilePath}.sha256`;

  // Check if pg_dump is available locally in system path
  let pgDumpAvailable = false;
  try {
    execSync("pg_dump --version", { stdio: "ignore" });
    pgDumpAvailable = true;
  } catch {
    pgDumpAvailable = false;
  }

  if (pgDumpAvailable) {
    // Execute native pg_dump
    execSync(`pg_dump "${dbUrl}" --clean --if-exists --no-owner --no-privileges -f "${backupFilePath}"`, {
      stdio: "inherit",
    });
  } else {
    // Fallback: Programmatic export using pg client
    const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    try {
      const sqlChunks: string[] = [];
      sqlChunks.push(`-- LabourBaba Database Backup: ${new Date().toISOString()}\n`);
      sqlChunks.push(`CREATE EXTENSION IF NOT EXISTS postgis;\n`);

      // Query all public business tables (excluding PostGIS system tables and internal migration table)
      const tablesRes = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_type = 'BASE TABLE'
          AND table_name NOT IN ('_prisma_migrations', 'spatial_ref_sys', 'geography_columns', 'geometry_columns')
        ORDER BY table_name;
      `);

      for (const row of tablesRes.rows) {
        const table = row.table_name;
        const dataRes = await client.query(`SELECT * FROM "${table}"`);
        if (dataRes.rows.length > 0) {
          for (const item of dataRes.rows) {
            const columns = Object.keys(item).map((c) => `"${c}"`).join(", ");
            const values = Object.values(item).map((val) => {
              if (val === null || val === undefined) return "NULL";
              if (typeof val === "boolean" || typeof val === "number") return val;
              if (val instanceof Date) return `'${val.toISOString()}'`;
              if (typeof val === "object") return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
              return `'${String(val).replace(/'/g, "''")}'`;
            }).join(", ");
            sqlChunks.push(`INSERT INTO "${table}" (${columns}) VALUES (${values}) ON CONFLICT DO NOTHING;\n`);
          }
        }
      }

      fs.writeFileSync(backupFilePath, sqlChunks.join(""), "utf-8");
    } finally {
      await client.end();
    }
  }

  // Calculate SHA-256 Checksum
  const fileBuffer = fs.readFileSync(backupFilePath);
  const checksum = crypto.createHash("sha256").update(fileBuffer).digest("hex");
  fs.writeFileSync(checksumFilePath, checksum, "utf-8");

  const sizeBytes = fs.statSync(backupFilePath).size;
  const durationMs = Date.now() - startTime;

  return {
    backupPath: backupFilePath,
    checksumPath: checksumFilePath,
    checksum,
    sizeBytes,
    durationMs,
    timestamp,
  };
}

if (require.main === module) {
  createDatabaseBackup()
    .then((result) => {
      console.log(`[BACKUP_SUCCESS] Backup created at: ${result.backupPath} (${result.sizeBytes} bytes, ${result.durationMs}ms, SHA256: ${result.checksum.slice(0, 16)}...)`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("[BACKUP_FAILED]", err);
      process.exit(1);
    });
}
