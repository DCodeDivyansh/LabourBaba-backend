# Runbook: Database Disaster Recovery & Restore Procedure

## Overview
- **Objective**: Full database restoration into an isolated recovery environment or newly provisioned primary instance.
- **Targets**:
  - **RPO (Recovery Point Objective)**: <= 1 hour (Automated hourly snapshots / daily base backups + WAL).
  - **RTO (Recovery Time Objective)**: <= 15 minutes (Full schema + data restore and PostGIS verification).

---

## 1. Prerequisites
1. Verified backup file (`.sql` or `.dump` with matching `.sha256` checksum).
2. Clean PostgreSQL instance with PostGIS extension capability.
3. Node.js environment with `DATABASE_URL` configured to the target recovery database.

---

## 2. Automated Restore Execution
Run the automated disaster recovery and verification script:
```bash
npx tsx scripts/restore-db.ts --backup-file=backups/latest.dump --target-db-url=$RESTORE_TARGET_DATABASE_URL
```

---

## 3. Post-Restore Verification Checklist
1. **PostGIS Functionality**:
   - `SELECT PostGIS_Version();`
   - `SELECT ST_AsText(ST_MakePoint(77.2090, 28.6139));`
2. **Schema & Constraint Integrity**:
   - Confirm all tables exist: `worker`, `customer`, `job`, `booking`, `job_dispatch`, `worker_location`, `audit_log`, `notification_outbox`.
   - Confirm foreign key and unique constraints.
3. **Application Smoke Test**:
   - Run health check endpoint against restored database: `GET /health/ready`.
