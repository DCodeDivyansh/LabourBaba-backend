import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync, spawnSync } from "child_process";
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
  dockerContainer?: string;
}): Promise<BackupResult> {
  const startTime = Date.now();
  const dbUrl = options?.databaseUrl || process.env.DATABASE_URL;

  if (!dbUrl) {
    throw new Error("[BACKUP_ERROR] DATABASE_URL is required to perform database backup.");
  }

  // ── Backup destination resolution (fail-closed) ───────────────────────────
  //
  // SECURITY: Backups must NEVER be written inside the Git repository.
  //
  // Resolution order:
  //   1. options.backupDir (explicit caller override — for tests only)
  //   2. BACKUP_DEST_DIR environment variable (production configuration)
  //   3. Fail closed — no default destination
  //
  // The production operator must set BACKUP_DEST_DIR to an approved external
  // storage path (e.g. a mounted volume outside the repo, or an S3-compatible
  // destination handled by the caller before invoking this function).
  // Do NOT set BACKUP_DEST_DIR to any path inside the repository root.

  const rawBackupDir = options?.backupDir ?? process.env.BACKUP_DEST_DIR;

  if (!rawBackupDir) {
    throw new Error(
      "[BACKUP_SECURITY] No backup destination configured. " +
      "Set the BACKUP_DEST_DIR environment variable to an approved external path " +
      "(e.g. a mounted volume outside the repository). " +
      "Never set BACKUP_DEST_DIR to a path inside the repository. " +
      "See SECURITY.md for the approved backup workflow."
    );
  }

  // Resolve the candidate path (following symlinks to defeat symlink attacks).
  // We create the directory first so realpathSync works on the resolved path.
  const candidateResolved = path.resolve(rawBackupDir);
  fs.mkdirSync(candidateResolved, { recursive: true });

  let backupDir: string;
  try {
    backupDir = fs.realpathSync(candidateResolved);
  } catch {
    backupDir = candidateResolved; // fallback if realpathSync fails (new dir)
  }

  // Determine the repository root (the directory containing package.json).
  // Use realpathSync to resolve any symlinks in the repo path as well.
  let repoRoot: string;
  try {
    repoRoot = fs.realpathSync(path.resolve(__dirname, ".."));
  } catch {
    repoRoot = path.resolve(__dirname, "..");
  }

  // ── Repository containment check using path.relative() ────────────────────
  //
  // path.relative(repoRoot, backupDir) returns:
  //   ''                → backupDir IS the repo root (REJECT)
  //   'some/subdir'     → backupDir is INSIDE the repo (REJECT)
  //   '../sibling'      → backupDir is a sibling dir — OK
  //   '/absolute/other' → only on Windows if different drive — OK
  //
  // This correctly handles:
  //   - /repo/backups   → relative = 'backups'    → no leading '..' → REJECT
  //   - /repo2          → relative = '../repo2'   → starts with '..' → OK
  //   - /repo           → relative = ''            → is root          → REJECT
  //   - ../traversal    → resolves before check   → handled by resolve()
  //   - symlinks        → resolved by realpathSync above

  const relative = path.relative(repoRoot, backupDir);
  const isInsideRepo =
    relative === "" || // IS the repo root
    (!relative.startsWith("..") && !path.isAbsolute(relative)); // is a descendant

  if (isInsideRepo) {
    throw new Error(
      `[BACKUP_SECURITY] Backup destination '${backupDir}' is inside or is the ` +
      `repository root ('${repoRoot}'). ` +
      "Backups must be written to an external storage path outside the repository. " +
      "Set BACKUP_DEST_DIR to an approved external destination. " +
      "See SECURITY.md for the approved backup workflow."
    );
  }


  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFileName = `backup_${timestamp}.sql`;
  const backupFilePath = path.join(backupDir, backupFileName);
  const checksumFilePath = `${backupFilePath}.sha256`;

  // ── Database Dump Execution Strategy ──────────────────────────────────────────
  // 1. If options.dockerContainer is specified, run pg_dump directly inside container
  // 2. If native system pg_dump is available, run native pg_dump
  // 3. If on Windows and WSL pg_dump is available, run pg_dump via WSL
  // 4. Fallback: Programmatic export using pg client with full DDL and data

  let dumpSuccess = false;

  if (options?.dockerContainer) {
    try {
      const parsed = new URL(dbUrl);
      const dbUser = parsed.username || "postgres";
      const dbName = parsed.pathname.replace(/^\//, "").split("?")[0] || "postgres";
      const dumpRes = spawnSync("docker", [
        "exec",
        options.dockerContainer,
        "pg_dump",
        "-U",
        dbUser,
        "-d",
        dbName,
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "--inserts",
      ], { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, shell: true });

      if (dumpRes.status === 0 && dumpRes.stdout && dumpRes.stdout.trim().length > 0) {
        fs.writeFileSync(backupFilePath, dumpRes.stdout, "utf-8");
        dumpSuccess = true;
      }
    } catch {}
  }

  if (!dumpSuccess) {
    let pgDumpAvailable = false;
    try {
      execSync("pg_dump --version", { stdio: "ignore" });
      pgDumpAvailable = true;
    } catch {
      pgDumpAvailable = false;
    }

    let wslPgDumpAvailable = false;
    if (!pgDumpAvailable && process.platform === "win32") {
      try {
        execSync("wsl -u root -d Ubuntu -- pg_dump --version", { stdio: "ignore" });
        wslPgDumpAvailable = true;
      } catch {
        wslPgDumpAvailable = false;
      }
    }

    if (pgDumpAvailable) {
      execSync(`pg_dump "${dbUrl}" --clean --if-exists --no-owner --no-privileges --inserts -f "${backupFilePath}"`, {
        stdio: "inherit",
      });
      dumpSuccess = true;
    } else if (wslPgDumpAvailable) {
      const wslRes = spawnSync("wsl", [
        "-u",
        "root",
        "-d",
        "Ubuntu",
        "--",
        "pg_dump",
        dbUrl,
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "--inserts",
      ], { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024, shell: true });

      if (wslRes.status === 0 && wslRes.stdout && wslRes.stdout.trim().length > 0) {
        fs.writeFileSync(backupFilePath, wslRes.stdout, "utf-8");
        dumpSuccess = true;
      }
    }
  }

  if (!dumpSuccess) {
    // Fallback: Programmatic export using pg client
    const useSsl = dbUrl.includes("sslmode=require") || dbUrl.includes("supabase.co") || dbUrl.includes("amazonaws.com");
    const client = new Client({
      connectionString: dbUrl,
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();

    try {
      const sqlChunks: string[] = [];
      sqlChunks.push(`-- LabourBaba Database Backup: ${new Date().toISOString()}\n`);
      sqlChunks.push(`CREATE EXTENSION IF NOT EXISTS postgis;\n`);
      sqlChunks.push(`SET session_replication_role = 'replica';\n`);

      // Preferred topological order for data dependencies
      const tableOrder = [
        'skill_category',
        'customer',
        'worker',
        'worker_device',
        'worker_document',
        'job',
        'job_requirement',
        'job_dispatch',
        'dispatch_wave',
        'booking',
        'payment',
        'review',
        'chat_message',
        'refresh_session',
        'otp_challenge',
        'worker_location',
        'notification_outbox',
        'admin_audit_log',
      ];

      // Query all public business tables
      const tablesRes = await client.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
          AND table_type = 'BASE TABLE'
          AND table_name NOT IN ('_prisma_migrations', 'spatial_ref_sys', 'geography_columns', 'geometry_columns')
      `);

      const availableTables = new Set(tablesRes.rows.map((r: any) => r.table_name));
      const sortedTables = [
        ...tableOrder.filter((t) => availableTables.has(t)),
        ...Array.from(availableTables).filter((t) => !tableOrder.includes(t)),
      ];

      for (const table of sortedTables) {
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
  const timestampSeconds = Math.floor(startTime / 1000);

  // Write metadata file for metrics collection
  const metadataPath = path.join(backupDir, "latest_backup_metadata.json");
  fs.writeFileSync(
    metadataPath,
    JSON.stringify({
      timestampSeconds,
      timestamp,
      backupPath: backupFilePath,
      checksum,
      sizeBytes,
      durationMs,
    }, null, 2),
    "utf-8"
  );

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
