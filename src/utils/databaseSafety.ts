import { URL } from "url";

/**
 * databaseSafety.ts
 *
 * LabourBaba Backend — Disaster Recovery & Database Safety Guard
 *
 * Strictly prevents accidental destructive restoration or execution
 * against production, staging, shared cloud, or developer databases.
 */

export interface SafeTargetVerification {
  isSafe: boolean;
  host: string;
  port: string;
  databaseName: string;
  redactedUrl: string;
}

// Prohibited production or cloud database host patterns
const PROHIBITED_HOST_PATTERNS = [
  /supabase\.co$/i,
  /pooler\.supabase\.com$/i,
  /\.amazonaws\.com$/i,
  /\.rds\.amazonaws\.com$/i,
  /\.neon\.tech$/i,
  /\.render\.com$/i,
  /\.cockroachlabs\.cloud$/i,
  /\.aivencloud\.com$/i,
  /(^|\.)prod(uction)?(\.|$)/i,
  /(^|\.)live(\.|$)/i,
];

// Prohibited database names (even on localhost)
const PROHIBITED_DB_NAMES = new Set([
  "postgres",
  "production",
  "prod",
  "main",
  "master",
  "live",
  "defaultdb",
]);

// Required disposable/test markers in database name
const APPROVED_DISPOSABLE_MARKERS = [
  "test",
  "disposable",
  "drill",
  "dr",
  "temp",
  "ci",
  "scratch",
  "sandbox",
];

/**
 * Redacts username and password from a PostgreSQL connection string for safe logging.
 */
export function redactDatabaseUrl(dbUrl: string): string {
  if (!dbUrl) return "<empty_url>";
  try {
    const parsed = new URL(dbUrl);
    if (parsed.password) {
      parsed.password = "***";
    }
    if (parsed.username) {
      parsed.username = "***";
    }
    return parsed.toString();
  } catch {
    return dbUrl.replace(/:\/\/([^:@]+):?[^@]*@/, "://***:***@");
  }
}

/**
 * Validates that a target database URL is an approved, isolated, disposable target.
 *
 * FAILS CLOSED (throws error) if:
 * 1. Target URL is empty.
 * 2. Target URL matches the application's primary DATABASE_URL or DIRECT_URL.
 * 3. Target URL points to known cloud or production host patterns.
 * 4. Target database name is a reserved production/default database name.
 * 5. Target database name lacks an approved disposable marker.
 */
export function assertSafeRestoreTarget(
  targetDatabaseUrl: string,
  options?: {
    bypassPrimaryMatchCheck?: boolean; // For explicit testing of target safety
  }
): SafeTargetVerification {
  if (!targetDatabaseUrl || typeof targetDatabaseUrl !== "string" || targetDatabaseUrl.trim().length === 0) {
    throw new Error(
      "[RESTORE_SECURITY_VIOLATION] No target database URL provided. Refusing to proceed with disaster recovery restore."
    );
  }

  const trimmedUrl = targetDatabaseUrl.trim();
  const redacted = redactDatabaseUrl(trimmedUrl);

  // 1. Prevent implicit or accidental reuse of application primary DATABASE_URL / DIRECT_URL
  if (!options?.bypassPrimaryMatchCheck) {
    const primaryDbUrl = process.env.DATABASE_URL?.trim();
    const directDbUrl = process.env.DIRECT_URL?.trim();

    if (primaryDbUrl && trimmedUrl === primaryDbUrl) {
      throw new Error(
        `[RESTORE_SECURITY_VIOLATION] Target database matches primary application DATABASE_URL (${redacted}). ` +
        "Disaster recovery restore MUST target an isolated disposable database, NEVER the active application database!"
      );
    }

    if (directDbUrl && trimmedUrl === directDbUrl) {
      throw new Error(
        `[RESTORE_SECURITY_VIOLATION] Target database matches direct migration DIRECT_URL (${redacted}). ` +
        "Disaster recovery restore MUST target an isolated disposable database, NEVER the direct application database!"
      );
    }
  }

  // 2. Parse connection URL
  let parsed: URL;
  try {
    parsed = new URL(trimmedUrl);
  } catch (err: any) {
    throw new Error(
      `[RESTORE_SECURITY_VIOLATION] Invalid database URL format: ${redacted}. Error: ${err.message}`
    );
  }

  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || "5432";
  const rawDbName = parsed.pathname.replace(/^\//, "").split("?")[0].trim().toLowerCase();

  // 3. Prohibit known production/cloud hosts
  for (const pattern of PROHIBITED_HOST_PATTERNS) {
    if (pattern.test(host)) {
      throw new Error(
        `[RESTORE_SECURITY_VIOLATION] Target host '${host}' matches prohibited production/cloud pattern (${pattern}). ` +
        "Disaster recovery restoration is strictly prohibited against cloud and production databases!"
      );
    }
  }

  // 4. Prohibit default or non-disposable database names
  if (!rawDbName || PROHIBITED_DB_NAMES.has(rawDbName)) {
    throw new Error(
      `[RESTORE_SECURITY_VIOLATION] Database name '${rawDbName || "<empty>"}' is a reserved/prohibited name. ` +
      "Disaster recovery restore requires a dedicated disposable database name (e.g. 'labourbaba_dr_disposable')."
    );
  }

  // 5. Enforce approved disposable/test naming convention
  const hasDisposableMarker = APPROVED_DISPOSABLE_MARKERS.some((marker) =>
    rawDbName.includes(marker)
  );

  if (!hasDisposableMarker) {
    throw new Error(
      `[RESTORE_SECURITY_VIOLATION] Target database name '${rawDbName}' does not contain an approved disposable marker ` +
      `(${APPROVED_DISPOSABLE_MARKERS.join(", ")}). Refusing to restore into potentially persistent database!`
    );
  }

  return {
    isSafe: true,
    host,
    port,
    databaseName: rawDbName,
    redactedUrl: redacted,
  };
}
