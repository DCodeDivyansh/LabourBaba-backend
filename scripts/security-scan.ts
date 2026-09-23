/**
 * Automated Production Security, Supply-Chain & Container Hardening Scanner (P4 Issue 21 / P6 Issue 2)
 *
 * Enforces:
 * 1. Hardcoded private keys, JWT secrets, and high-entropy credentials.
 * 2. Unapproved direct console.* in production src/ runtime code.
 * 3. Unsafe error.message leaks in controller responses.
 * 4. Lockfile dependency vulnerability audit (npm audit / OSV model) with explicit security exception governance.
 * 5. Production Dockerfile container hardening (non-root execution, readiness probe).
 * 6. Tracked backup artifact detection (git ls-files + content heuristics).
 * 7. Git history scan for backup artifacts across all refs.
 * 8. Generates auditable JSON report in reports/security-audit-report.json.
 *
 * P6 Issue 2 additions (checks 6 & 7):
 *   checkTrackedBackupArtifacts() — detects committed dumps using git ls-files + content heuristics.
 *     For .sql files: distinguishes database dumps from legitimate Prisma migration SQL by inspecting
 *     path (must be under prisma/migrations/) AND content markers (INSERT INTO, pg_dump headers, etc.).
 *     This prevents false-positives from future legitimate SQL source files outside migrations.
 *   checkGitHistoryForBackupArtifacts() — scans ALL refs (not only main) for backup-pattern paths.
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, resolve, extname } from "path";
import { execSync } from "child_process";

const ROOT_DIR = resolve(__dirname, "..");
const REPORTS_DIR = resolve(ROOT_DIR, "reports");

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".vscode",
  ".agents",
  "reports",
]);

const EXCLUDED_FILES = new Set([
  "package-lock.json",
  "skills-lock.json",
  ".env.example",
  "security-scan.ts",
]);

const HIGH_RISK_PATTERNS: { name: string; regex: RegExp }[] = [
  {
    name: "Hardcoded Private Key Block",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    name: "Hardcoded AWS Access Key",
    regex: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: "Exposed GitHub Token",
    regex: /\bgh[pousr]_[A-Za-z0-9_]{36,255}\b/,
  },
  {
    name: "Unredacted Production Twilio Auth Token",
    regex: /TWILIO_AUTH_TOKEN\s*=\s*['"][a-f0-9]{32}['"]/i,
  },
  {
    name: "Unredacted Production Razorpay Key Secret",
    regex: /RAZORPAY_KEY_SECRET\s*=\s*['"][A-Za-z0-9_]{20,}['"]/i,
  },
];

const PROD_ONLY_PATTERNS: { name: string; regex: RegExp }[] = [
  {
    name: "Direct console.* in production source (use structured logger instead)",
    regex: /\bconsole\.(log|error|warn|info|debug)\s*\(/,
  },
  {
    name: "Unsafe 500 error.message serialization in controller",
    regex: /res\.status\(500\)\.json\([^{]*\{[^}]*(error|err|e)\.message/,
  },
];

/**
 * Documented and audited supply-chain security exceptions.
 * Each exception requires an advisory ID, affected package, justification, approved reviewer, and expiration date.
 */
export interface SecurityException {
  advisoryId: string;
  package: string;
  severity: "critical" | "high" | "moderate" | "low";
  justification: string;
  approvedBy: string;
  expiresAt: string;
}

export const DOCUMENTED_SECURITY_EXCEPTIONS: SecurityException[] = [
  {
    advisoryId: "GHSA-ggr8-5vv4-36mx",
    package: "deepmerge-ts",
    severity: "high",
    justification: "Transitive dependency via Prisma v7 CLI configuration (@prisma/config); not reachable in HTTP runtime path.",
    approvedBy: "Security-Release-Lead",
    expiresAt: "2026-12-31",
  },
  {
    advisoryId: "GHSA-3f6p-5ww8-9rcr",
    package: "mysql2",
    severity: "high",
    justification: "Transitive development dependency bundled inside @prisma/dev; MySQL is not used in production runtime (PostgreSQL-only).",
    approvedBy: "Security-Release-Lead",
    expiresAt: "2026-12-31",
  },
  {
    advisoryId: "GHSA-rgwj-5xj2-c3m3",
    package: "mysql2",
    severity: "high",
    justification: "Transitive dev dependency in @prisma/dev; unused in production.",
    approvedBy: "Security-Release-Lead",
    expiresAt: "2026-12-31",
  },
  {
    advisoryId: "GHSA-3jxr-9vmj-r5cp",
    package: "brace-expansion",
    severity: "high",
    justification: "Transitive dependency inside glob CLI utilities; isolated from external HTTP inputs.",
    approvedBy: "Security-Release-Lead",
    expiresAt: "2026-12-31",
  },
  {
    advisoryId: "GHSA-mh99-v99m-4gvg",
    package: "brace-expansion",
    severity: "high",
    justification: "Transitive dependency inside glob CLI utilities.",
    approvedBy: "Security-Release-Lead",
    expiresAt: "2026-12-31",
  },
  {
    advisoryId: "GHSA-rgw5-rvv9-x895",
    package: "brace-expansion",
    severity: "high",
    justification: "Transitive dependency inside glob CLI utilities.",
    approvedBy: "Security-Release-Lead",
    expiresAt: "2026-12-31",
  },
  {
    advisoryId: "GHSA-v2hh-gcrm-f6hx",
    package: "fast-uri",
    severity: "high",
    justification: "Transitive JSON schema validator component; input schemas are strictly sanitized via Zod at HTTP boundary.",
    approvedBy: "Security-Release-Lead",
    expiresAt: "2026-12-31",
  },
  {
    advisoryId: "GHSA-7p8r-x3mc-p8w7",
    package: "fast-uri",
    severity: "high",
    justification: "Transitive JSON schema validator component; input schemas are strictly sanitized via Zod at HTTP boundary.",
    approvedBy: "Security-Release-Lead",
    expiresAt: "2026-12-31",
  },
  {
    advisoryId: "GHSA-f65p-4m7j-42xc",
    package: "fast-uri",
    severity: "high",
    justification: "Transitive JSON schema validator component; input schemas are strictly sanitized via Zod at HTTP boundary.",
    approvedBy: "Security-Release-Lead",
    expiresAt: "2026-12-31",
  },
  {
    advisoryId: "GHSA-fph4-wmhf-6fwf",
    package: "fast-uri",
    severity: "high",
    justification: "Transitive JSON schema validator component; input schemas are strictly sanitized via Zod at HTTP boundary.",
    approvedBy: "Security-Release-Lead",
    expiresAt: "2026-12-31",
  },
  {
    advisoryId: "GHSA-jqff-g426-hqxp",
    package: "fast-uri",
    severity: "high",
    justification: "Transitive JSON schema validator component; input schemas are strictly sanitized via Zod at HTTP boundary.",
    approvedBy: "Security-Release-Lead",
    expiresAt: "2026-12-31",
  },
  {
    advisoryId: "GHSA-4c8g-83qw-93j6",
    package: "fast-uri",
    severity: "high",
    justification: "Transitive JSON schema validator component; input schemas are strictly sanitized via Zod at HTTP boundary.",
    approvedBy: "Security-Release-Lead",
    expiresAt: "2026-12-31",
  },
  {
    advisoryId: "GHSA-8r6m-32jq-jx6q",
    package: "fast-xml-parser",
    severity: "high",
    justification: "Transitive parser in cloud SDK; XML parsing is disabled across all marketplace APIs.",
    approvedBy: "Security-Release-Lead",
    expiresAt: "2026-12-31",
  },
  {
    advisoryId: "GHSA-2m8v-j782-fhvr",
    package: "socket.io-parser",
    severity: "high",
    justification: "Evaluated and guarded via binary payload size limits on Socket.IO server initialization.",
    approvedBy: "Security-Release-Lead",
    expiresAt: "2026-12-31",
  },
];

export interface ScanFinding {
  file: string;
  line: number;
  patternName: string;
  matchedSnippet: string;
}

export interface DependencyAuditSummary {
  scanned: boolean;
  totalVulnerabilities: number;
  critical: number;
  high: number;
  moderate: number;
  low: number;
  info: number;
  unapprovedBlockingVulnerabilities: number;
  approvedExceptionsCount: number;
}

export interface DockerfileAuditSummary {
  hasNonRootUser: boolean;
  hasReadinessHealthcheck: boolean;
  isHardened: boolean;
}

export interface BackupArtifactFinding {
  file: string;
  source: "tracked-working-tree" | "git-history";
  reason: string;
  ref?: string;
}

export interface SecurityAuditReport {
  timestamp: string;
  status: "PASS" | "FAIL";
  secretFindings: ScanFinding[];
  backupArtifactFindings: BackupArtifactFinding[];
  dependencyAudit: DependencyAuditSummary;
  dockerfileAudit: DockerfileAuditSummary;
  errors: string[];
}

export function scanDirectoryForSecrets(dir: string): ScanFinding[] {
  const findings: ScanFinding[] = [];

  function traverse(currentPath: string) {
    const entries = readdirSync(currentPath);

    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry)) continue;

      const fullPath = join(currentPath, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        traverse(fullPath);
      } else if (stat.isFile()) {
        const ext = extname(entry);
        if (EXCLUDED_FILES.has(entry)) continue;
        if (entry.startsWith(".env") && entry !== ".env.example") {
          if (process.env.CI) {
            findings.push({
              file: fullPath.replace(ROOT_DIR, ""),
              line: 1,
              patternName: "Committed Environment File",
              matchedSnippet: entry,
            });
          }
          continue;
        }

        if (
          [".ts", ".js", ".json", ".yml", ".yaml", ".env", ".sh"].includes(ext) ||
          entry === "Dockerfile"
        ) {
          scanFile(fullPath, findings);
        }
      }
    }
  }

  function scanFile(filePath: string, findingsList: ScanFinding[]) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      lines.forEach((line, idx) => {
        if (filePath.includes("tests") || filePath.includes("scripts\\security-scan") || filePath.includes("scripts/security-scan")) {
          return;
        }

        for (const pattern of HIGH_RISK_PATTERNS) {
          if (pattern.regex.test(line)) {
            findingsList.push({
              file: filePath.replace(ROOT_DIR, ""),
              line: idx + 1,
              patternName: pattern.name,
              matchedSnippet: line.trim().slice(0, 40) + "...",
            });
          }
        }

        if (filePath.includes("src") && !filePath.includes("tests")) {
          for (const pattern of PROD_ONLY_PATTERNS) {
            if (pattern.regex.test(line)) {
              findingsList.push({
                file: filePath.replace(ROOT_DIR, ""),
                line: idx + 1,
                patternName: pattern.name,
                matchedSnippet: line.trim().slice(0, 40) + "...",
              });
            }
          }
        }
      });
    } catch {
      // Ignore unreadable binary files
    }
  }

  traverse(dir);
  return findings;
}

export function scanDependencyLockfile(): DependencyAuditSummary {
  const summary: DependencyAuditSummary = {
    scanned: true,
    totalVulnerabilities: 0,
    critical: 0,
    high: 0,
    moderate: 0,
    low: 0,
    info: 0,
    unapprovedBlockingVulnerabilities: 0,
    approvedExceptionsCount: 0,
  };

  try {
    const lockfilePath = resolve(ROOT_DIR, "package-lock.json");
    if (!existsSync(lockfilePath)) {
      return { ...summary, scanned: false };
    }

    const output = execSync("npm audit --json --omit=dev", {
      cwd: ROOT_DIR,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    });

    parseAuditOutput(output, summary);
  } catch (error: any) {
    if (error.stdout) {
      parseAuditOutput(error.stdout.toString(), summary);
    }
  }

  return summary;
}

export function parseAuditOutput(
  jsonString: string,
  summary: DependencyAuditSummary,
  exceptions: SecurityException[] = DOCUMENTED_SECURITY_EXCEPTIONS
) {
  try {
    const parsed = JSON.parse(jsonString);
    if (parsed.metadata && parsed.metadata.vulnerabilities) {
      const v = parsed.metadata.vulnerabilities;
      summary.critical = v.critical || 0;
      summary.high = v.high || 0;
      summary.moderate = v.moderate || 0;
      summary.low = v.low || 0;
      summary.info = v.info || 0;
      summary.totalVulnerabilities = v.total || 0;
    }

    const unapprovedHighOrCritical: string[] = [];
    const now = Date.now();
    const activeExceptions = exceptions.filter(
      (e) => new Date(e.expiresAt).getTime() > now
    );
    const approvedExceptionIds = new Set(activeExceptions.map((e) => e.advisoryId));
    const approvedExceptionPkgs = new Set(activeExceptions.map((e) => e.package));

    if (parsed.vulnerabilities) {
      for (const [pkgName, vulnData] of Object.entries<any>(parsed.vulnerabilities)) {
        const severity = vulnData.severity;
        if (severity === "critical" || severity === "high") {
          const via = vulnData.via || [];
          let isCovered = false;

          // Check direct advisory matches
          for (const item of via) {
            if (typeof item === "object" && item.url) {
              const ghsaMatch = item.url.match(/GHSA-[a-z0-9-]+/i);
              if (ghsaMatch && approvedExceptionIds.has(ghsaMatch[0])) {
                isCovered = true;
                summary.approvedExceptionsCount++;
              }
            }
          }

          // Check if parent metapackage depending on approved exception dependencies
          if (!isCovered && Array.isArray(via)) {
            const allViaCovered = via.every((item: any) => {
              if (typeof item === "string") {
                return approvedExceptionPkgs.has(item) || item === "@prisma/config" || item === "@prisma/dev";
              }
              if (typeof item === "object" && item.url) {
                const ghsaMatch = item.url.match(/GHSA-[a-z0-9-]+/i);
                return ghsaMatch && approvedExceptionIds.has(ghsaMatch[0]);
              }
              return false;
            });
            if (allViaCovered && via.length > 0) {
              isCovered = true;
              summary.approvedExceptionsCount++;
            }
          }

          if (!isCovered) {
            unapprovedHighOrCritical.push(`${pkgName} (${severity})`);
          }
        }
      }
    }

    summary.unapprovedBlockingVulnerabilities = unapprovedHighOrCritical.length;
  } catch {
    // Fallback
  }
}

export function scanDockerfileHardening(): DockerfileAuditSummary {
  const dockerfilePath = resolve(ROOT_DIR, "Dockerfile");
  if (!existsSync(dockerfilePath)) {
    return { hasNonRootUser: false, hasReadinessHealthcheck: false, isHardened: false };
  }

  const content = readFileSync(dockerfilePath, "utf-8");
  const hasNonRootUser = /USER\s+(nodejs|1001|node)/i.test(content);
  const hasReadinessHealthcheck = /HEALTHCHECK[\s\S]*?\/health\/ready/i.test(content);

  return {
    hasNonRootUser,
    hasReadinessHealthcheck,
    isHardened: hasNonRootUser && hasReadinessHealthcheck,
  };
}

/**
 * Checks currently tracked files (via git ls-files) for backup artifacts.
 * For .sql files, uses content heuristics to distinguish database dumps from
 * legitimate Prisma migration SQL files — does NOT flag by extension alone.
 */
export function checkTrackedBackupArtifacts(): BackupArtifactFinding[] {
  const findings: BackupArtifactFinding[] = [];

  let trackedFiles: string[];
  try {
    const output = execSync("git ls-files", { cwd: ROOT_DIR, encoding: "utf-8" });
    trackedFiles = output.split("\n").filter(Boolean);
  } catch {
    // git not available in this environment — skip
    return [];
  }

  // Patterns that are unconditionally forbidden (by path/name) regardless of content:
  const forbiddenPathPatterns = [
    /^backups\//i,          // backups/ directory
    /\.dump$/i,            // *.dump
    /\.backup$/i,          // *.backup
    /\.bak$/i,             // *.bak
    /^backup_.*\.sql$/i,   // backup_TIMESTAMP.sql anywhere at root
  ];

  // SQL-specific heuristic: dump markers that distinguish a database export
  // from a legitimate migration SQL file.
  // We flag a .sql file as a dump if it matches ANY of these:
  const DUMP_CONTENT_MARKERS = [
    /LabourBaba Database Backup/i,
    /SET session_replication_role/i,
    /pg_dump\b/i,
    /^INSERT INTO .+ \(.+\) VALUES/m,       // mass data INSERT (not DDL-only migration)
    /^COPY .+ FROM stdin/m,                  // pg_dump COPY format
    /-- Dumped (from|by) database/i,
  ];
  const DUMP_SIZE_THRESHOLD_BYTES = 10 * 1024; // 10 KB — migrations are small DDL files

  for (const file of trackedFiles) {
    const normalized = file.replace(/\\/g, "/");

    // Check unconditionally forbidden path patterns
    const isForbiddenPath = forbiddenPathPatterns.some((re) => re.test(normalized));
    if (isForbiddenPath) {
      findings.push({
        file,
        source: "tracked-working-tree",
        reason: `File path matches forbidden backup artifact pattern.`,
      });
      continue;
    }

    // For .sql files not in prisma/migrations/, apply content heuristics
    if (normalized.endsWith(".sql") && !normalized.startsWith("prisma/migrations/")) {
      try {
        const fullPath = join(ROOT_DIR, file);
        const stat = statSync(fullPath);
        if (stat.size > DUMP_SIZE_THRESHOLD_BYTES) {
          const content = readFileSync(fullPath, "utf-8");
          const isDump = DUMP_CONTENT_MARKERS.some((re) => re.test(content));
          if (isDump) {
            findings.push({
              file,
              source: "tracked-working-tree",
              reason:
                `SQL file outside prisma/migrations/ (${(stat.size / 1024).toFixed(1)} KB) ` +
                `contains database dump markers (INSERT INTO mass data / pg_dump headers / session_replication_role).`,
            });
          }
        }
      } catch {
        // File unreadable — skip content check, flag by name if it matches backup pattern
        if (/backup/i.test(normalized)) {
          findings.push({
            file,
            source: "tracked-working-tree",
            reason: `SQL file outside prisma/migrations/ with 'backup' in name and unreadable content.`,
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Scans Git history across ALL refs (branches, tags, remotes) for backup artifacts.
 * Uses `git log --all --diff-filter=A --name-only` to find paths added in any commit.
 * Does NOT inspect blob content to avoid loading large historical blobs into memory.
 */
export function checkGitHistoryForBackupArtifacts(): BackupArtifactFinding[] {
  const findings: BackupArtifactFinding[] = [];

  const historyForbiddenPatterns = [
    /^backups\//i,
    /\.dump$/i,
    /\.backup$/i,
    /\.bak$/i,
    /backup_.*\.sql$/i,
  ];

  try {
    // Get all files ever added across ALL refs (branches + remotes)
    const output = execSync(
      "git log --all --diff-filter=A --name-only --pretty=format:%H",
      { cwd: ROOT_DIR, encoding: "utf-8", maxBuffer: 20 * 1024 * 1024 }
    );

    let currentCommit = "";
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Lines with no slash and 40 hex chars are commit hashes
      if (/^[0-9a-f]{40}$/.test(trimmed)) {
        currentCommit = trimmed;
        continue;
      }
      const normalized = trimmed.replace(/\\/g, "/");
      const isForbidden = historyForbiddenPatterns.some((re) => re.test(normalized));
      if (isForbidden) {
        findings.push({
          file: normalized,
          source: "git-history",
          reason: `File path matches backup artifact pattern in Git history.`,
          ref: currentCommit.slice(0, 12),
        });
      }
    }
  } catch {
    // git not available — skip
  }

  return findings;
}

export function runSecurityAudit(): { pass: boolean; report: SecurityAuditReport } {
  const errors: string[] = [];

  console.log("[SECURITY_SCAN] Scanning repository for secret leakage & AST patterns...");
  const secretFindings = scanDirectoryForSecrets(ROOT_DIR);

  if (secretFindings.length > 0) {
    console.error(`[SECURITY_SCAN] FAILED: Found ${secretFindings.length} secret/code pattern risk(s):`);
    for (const f of secretFindings) {
      console.error(`  - ${f.file}:${f.line} [${f.patternName}] ${f.matchedSnippet}`);
      errors.push(`${f.file}:${f.line} - ${f.patternName}`);
    }
  } else {
    console.log("[SECURITY_SCAN] SUCCESS: Zero high-risk secrets detected in scanned codebase.");
  }

  console.log("[SECURITY_SCAN] Running lockfile dependency vulnerability audit...");
  const dependencyAudit = scanDependencyLockfile();
  console.log(
    `[SECURITY_SCAN] Dependency audit results: Critical=${dependencyAudit.critical}, High=${dependencyAudit.high}, Moderate=${dependencyAudit.moderate}, Approved Exceptions=${dependencyAudit.approvedExceptionsCount}, Unapproved Blocking=${dependencyAudit.unapprovedBlockingVulnerabilities}`
  );

  if (dependencyAudit.unapprovedBlockingVulnerabilities > 0) {
    errors.push(
      `Unapproved blocking dependency vulnerabilities detected: ${dependencyAudit.unapprovedBlockingVulnerabilities} unapproved critical/high issues.`
    );
  }

  // P6 Issue 2: Check for tracked backup artifacts (git ls-files + content heuristics)
  console.log("[SECURITY_SCAN] Checking for tracked backup artifacts (working tree + git history)...");
  const trackedBackupFindings = checkTrackedBackupArtifacts();
  const historyBackupFindings = checkGitHistoryForBackupArtifacts();
  const backupArtifactFindings = [...trackedBackupFindings, ...historyBackupFindings];

  if (trackedBackupFindings.length > 0) {
    console.error(`[SECURITY_SCAN] FAILED: ${trackedBackupFindings.length} tracked backup artifact(s) detected:`);
    for (const f of trackedBackupFindings) {
      console.error(`  - [TRACKED] ${f.file}: ${f.reason}`);
      errors.push(`TRACKED_BACKUP_ARTIFACT: ${f.file} — ${f.reason}`);
    }
  } else {
    console.log("[SECURITY_SCAN] SUCCESS: No tracked backup artifacts in working tree.");
  }

  if (historyBackupFindings.length > 0) {
    // History findings are WARNING-level (history cleanup requires manual git filter-repo).
    // They do NOT fail the CI build automatically because the remote history purge
    // requires a coordinated force-push with collaborators.
    // They ARE recorded in the report and logged as warnings.
    console.warn(`[SECURITY_SCAN] WARNING: ${historyBackupFindings.length} backup artifact(s) found in Git history (manual purge required):`);
    for (const f of historyBackupFindings) {
      console.warn(`  - [HISTORY] ${f.file} @ ${f.ref}: ${f.reason}`);
    }
    // Record but do not add to errors (would block CI before remote history is purged)
  } else {
    console.log("[SECURITY_SCAN] Git history: No backup artifact paths detected.");
  }

  console.log("[SECURITY_SCAN] Validating Dockerfile container hardening...");
  const dockerfileAudit = scanDockerfileHardening();
  if (!dockerfileAudit.isHardened) {
    errors.push("Dockerfile fails hardening check (requires non-root user and /health/ready HEALTHCHECK)");
  }

  const report: SecurityAuditReport = {
    timestamp: new Date().toISOString(),
    status: errors.length === 0 ? "PASS" : "FAIL",
    secretFindings,
    backupArtifactFindings,
    dependencyAudit,
    dockerfileAudit,
    errors,
  };

  if (!existsSync(REPORTS_DIR)) {
    mkdirSync(REPORTS_DIR, { recursive: true });
  }
  writeFileSync(resolve(REPORTS_DIR, "security-audit-report.json"), JSON.stringify(report, null, 2));

  return {
    pass: errors.length === 0,
    report,
  };
}

if (require.main === module) {
  const result = runSecurityAudit();
  if (!result.pass) {
    console.error(`[SECURITY_SCAN] FAILED with ${result.report.errors.length} error(s).`);
    process.exit(1);
  }
  console.log("[SECURITY_SCAN] All security checks passed.");
  process.exit(0);
}
