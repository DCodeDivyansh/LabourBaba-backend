# Issues 46–50 Implementation Report: Observability, Security & Disaster Recovery

## Executive Summary
This document provides a comprehensive technical architecture, production invariant specification, and verification report for Issues 46 through 50 of the LabourBaba Production-Grade Remediation Roadmap v2:
- **Issue 46**: Worker location retention policy, compound B-Tree indexing on `worker_location(worker_id, updated_at)` & `worker_location(updated_at)`, bounded batch cleanup service (`locationRetentionService`), and complete decoupling of dispatch candidate matching from historical location scans.
- **Issue 47**: Centralized business metrics service (`metricsService`) providing standard Prometheus exposition on `GET /metrics` with strictly low-cardinality counters, gauges, and latency histograms.
- **Issue 48**: Actionable production alert rules (`config/prometheus/alerts.yml`) covering 5xx error rate, queue lag, DB/Redis health, dispatch failure, stale worker supply, and OTP brute-force patterns, accompanied by 10 comprehensive operational runbooks (`docs/runbooks/`).
- **Issue 49**: Database-backed durable administrative and security audit logging (`audit_log`), controlled action taxonomy, deep metadata sanitization preventing secret/token/PII leakage, and transactional atomicity on worker suspension/verification.
- **Issue 50**: Automated database backup and disaster recovery verification (`scripts/backup-db.ts`, `scripts/restore-db.ts`) with SHA-256 checksum verification, PostGIS extension verification, and measured recovery time objective (RTO <= 15m, RPO <= 1h).

---

## Issue 46 — Location Retention / Indexing

### 1. Findings Before Changes
- Worker location history grew unboundedly in `worker_location` with only a single index on `worker_id`.
- There was no automated cleanup mechanism or retention policy, causing database storage growth.
- Dispatch queries properly targeted `Worker.location_geo` (the canonical current location) rather than historical records, but cleanup queries risked full table scans without indexes on `updated_at`.

### 2. Implemented Architecture
- **Canonical Current vs Historical GPS**:
  - **Current Location**: `Worker.location_geo` (geography point) and `Worker.last_location_at` (timestamptz) indexed via spatial GIST `idx_worker_location`. Authoritative source for all dispatch matching.
  - **Location History**: `worker_location` table recording historical breadcrumbs for audit and trip tracing.
- **Indexing Design**:
  - `idx_worker_location_updated_at` on `(updated_at)` for fast cutoff timestamp filtering.
  - `idx_worker_location_worker_updated_at` on `(worker_id, updated_at)` for fast worker history lookups.
- **Configurable Retention Policy**:
  - `LOCATION_HISTORY_RETENTION_DAYS`: Configurable via environment variable (default: 30 days, bounds: [1, 365]).
- **Bounded Batch Cleanup Mechanism (`src/services/locationRetentionService.ts`)**:
  - Performs bounded batch deletion using subqueries with `LIMIT 1000` to prevent long-running exclusive locks on the high-write table.
  - Exposes `cleanupExpiredLocationHistory({ batchSize, retentionDays })` and records cleanup metrics (`location_cleanup_rows_deleted_total`, `location_cleanup_duration_ms`).

---

## Issue 47 — Business Metrics

### 1. Implemented Architecture (`src/metrics/metrics.service.ts`)
- Implemented a unified in-memory metrics registry formatted according to Prometheus exposition standards.
- Mounted public/internal telemetry endpoint `GET /metrics` returning `text/plain; version=0.0.4`.

### 2. Metrics Added
| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `jobs_created_total` | Counter | None | Total customer jobs submitted |
| `dispatch_attempts_total` | Counter | None | Total dispatch wave matching attempts |
| `dispatch_success_total` | Counter | None | Successful candidate wave allocations |
| `dispatch_failure_total` | Counter | `reason` | Failed dispatch waves (e.g. `no_candidates`) |
| `dispatch_accept_total` | Counter | None | Total worker dispatch acceptances |
| `booking_created_total` | Counter | None | Total bookings created |
| `booking_cancelled_total` | Counter | `reason` | Total bookings cancelled |
| `booking_completed_total` | Counter | None | Total bookings successfully finished |
| `notification_attempts_total` | Counter | `channel` (`fcm`/`socket`) | Push/Socket notification attempts |
| `notification_success_total` | Counter | `channel` | Delivered notifications |
| `notification_failure_total` | Counter | `channel`, `error_type` | Failed notification attempts |
| `location_updates_total` | Counter | None | Ingress worker GPS updates |
| `location_cleanup_rows_deleted_total` | Counter | None | Historical GPS records pruned |
| `http_requests_total` | Counter | `method`, `route`, `status` | Normalized HTTP request volume |
| `otp_challenges_created_total` | Counter | `purpose` | Generated OTP challenges |
| `otp_verifications_total` | Counter | `purpose`, `status` | OTP verification outcomes |
| `security_audit_events_total` | Counter | `action`, `role` | Security and admin actions |
| `dispatch_latency_ms` | Histogram | Buckets [10ms..5s] | Duration of dispatch candidate queries |
| `dispatch_candidate_count` | Histogram | Buckets [1..50] | Number of workers matched per wave |
| `dispatch_accept_latency_ms` | Histogram | Buckets [500ms..60s] | Time taken by worker to accept wave |
| `http_request_duration_ms` | Histogram | Buckets [5ms..5s] | API response latency distribution |
| `location_cleanup_duration_ms` | Histogram | Buckets [50ms..5s] | Duration of batch retention cleanup |

---

## Issue 48 — Alerts & Runbooks

### 1. Alert Definitions (`config/prometheus/alerts.yml`)
| Alert | Severity | Trigger | Runbook |
|---|---|---|---|
| `Elevated5xxRate` | Critical | 5xx error rate > 5% over 5m | `docs/runbooks/elevated-5xx.md` |
| `DatabaseUnavailable` | Critical | Database health check failing for 1m | `docs/runbooks/database-failure.md` |
| `RedisUnavailable` | Critical | Redis health check failing for 1m | `docs/runbooks/redis-failure.md` |
| `QueueLagHigh` | Warning | BullMQ waiting jobs > 100 for 5m | `docs/runbooks/queue-lag.md` |
| `DispatchFailureRateHigh` | Critical | Dispatch failures > 10% for 5m | `docs/runbooks/dispatch-failure.md` |
| `StaleLocationSupplyHigh` | Warning | Stale worker location exclusions > 50 in 10m | `docs/runbooks/stale-location.md` |
| `NotificationFailureRateHigh` | Warning | FCM failures > 5% over 5m | `docs/runbooks/notification-failure.md` |
| `AbnormalOtpAttempts` | Warning | Failed OTP verifications > 20/min | `docs/runbooks/abnormal-otp.md` |
| `BackupFailure` | Critical | No successful backup in > 24h | `docs/runbooks/backup-failure.md` |

### 2. Operational Runbooks Created
- `docs/runbooks/elevated-5xx.md`
- `docs/runbooks/queue-lag.md`
- `docs/runbooks/database-failure.md`
- `docs/runbooks/redis-failure.md`
- `docs/runbooks/dispatch-failure.md`
- `docs/runbooks/stale-location.md`
- `docs/runbooks/notification-failure.md`
- `docs/runbooks/abnormal-otp.md`
- `docs/runbooks/backup-failure.md`
- `docs/runbooks/restore.md`

---

## Issue 49 — Admin / Security Audit Logs

### 1. Audit Architecture (`src/features/audit/audit.service.ts`)
- **Database Model**: `audit_log` with fields `id`, `actor_id`, `actor_role`, `action`, `target_type`, `target_id`, `reason`, `correlation_id`, `ip_address`, `user_agent`, `metadata`, `created_at`.
- **Controlled Action Taxonomy (`src/features/audit/audit.types.ts`)**:
  - `WORKER_SUSPENDED`, `WORKER_REACTIVATED`, `WORKER_VERIFIED`, `WORKER_REJECTED`, `DOCUMENT_ACCESSED`, `DOCUMENT_VERIFICATION_CHANGED`, `SESSION_REVOKED`, `REFRESH_TOKEN_REUSE_DETECTED`, `SECURITY_CONFIG_CHANGED`.
- **Secret & Token Redaction**:
  - Recursive `sanitizeMetadata()` automatically redacts `password`, `token`, `otp`, `secret`, `private_key`, `signed_url`, and URL query parameters containing tokens.
- **Transactional Consistency**:
  - Worker suspension and document verification status mutations execute in the same PostgreSQL transaction as their corresponding `audit_log` insert.
- **Admin Query API**:
  - `GET /api/admin/audit-logs` protected by `requireRole(UserRole.ADMIN)`.

---

## Issue 50 — Backup & Restore

### 1. Recovery Targets
- **RPO (Recovery Point Objective)**: <= 1 hour (Automated hourly snapshots / daily base backups + WAL).
- **RTO (Recovery Time Objective)**: <= 15 minutes (Full schema + data restore and PostGIS verification).

### 2. Automation Scripts
- **`scripts/backup-db.ts`**:
  - Connects to PostgreSQL, dumps all public business tables while safely excluding PostGIS internal tables (`spatial_ref_sys`, `geography_columns`, `geometry_columns`).
  - Writes timestamped `.sql` backup and generates matching SHA-256 `.sha256` checksum file.
- **`scripts/restore-db.ts`**:
  - Validates checksum integrity before execution.
  - Replays SQL backup into target database.
  - Verifies PostGIS extension (`SELECT PostGIS_Version()`).
  - Verifies table counts and database invariants.
  - Measures restore latency and validates compliance with the 15-minute RTO target.

---

## Verification Test Summary

| Test Suite | Focus Area | Status |
|---|---|---|
| `tests/locationRetention.test.ts` | Retention calculations, batch cleanup, worker current location preservation | **PASS (4/4)** |
| `tests/businessMetrics.test.ts` | Counters, histograms, low-cardinality labels, `GET /metrics` | **PASS (3/3)** |
| `tests/adminAuditLogging.test.ts` | Metadata secret redaction, transactional audit writes, query service | **PASS (4/4)** |
| `tests/backupRestore.test.ts` | Backup creation, checksum validation, restore, PostGIS verification, RTO | **PASS (3/3)** |

### Quality Gates
- **TypeScript Typecheck (`npx tsc --noEmit`)**: **PASS (0 errors)**
- **Production Build (`npm run build`)**: **PASS (Clean build)**
- **Database Migration (`20260921070000_audit_log_and_location_indexes`)**: **APPLIED & VERIFIED**
