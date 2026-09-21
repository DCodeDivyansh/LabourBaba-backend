# LabourBaba Backend — Database Backup & Restore Runbook

## Overview
This runbook defines the disaster recovery procedure, Recovery Point Objective (RPO), Recovery Time Objective (RTO), and programmatic backup/restore scripts for the PostgreSQL/PostGIS database.

---

## 1. Objectives & SLAs
- **RPO (Recovery Point Objective)**: <= 1 Hour (Continuous WAL archiving / Hourly snapshots).
- **RTO (Recovery Time Objective)**: <= 15 Minutes (Automated restoration and verification).

---

## 2. Backup Procedure

### Automated Backup Script
Run the standard backup utility:
```bash
npm run backup:db
# Or directly:
npx ts-node scripts/backup-db.ts
```

The script performs a topological JSON export of all core tables:
1. `skill_category`
2. `customer`
3. `worker`
4. `worker_device`
5. `job`
6. `job_requirement`
7. `job_dispatch`
8. `booking`
9. `payment`
10. `review`
11. `notification_outbox`
12. `audit_log`

---

## 3. Restore Procedure

### Automated Restore Script
To restore a snapshot to a target database:
```bash
npx ts-node scripts/restore-db.ts <path-to-backup-file.json>
```

### Foreign Key & Trigger Handling
To guarantee that foreign keys and audit triggers do not reject out-of-sequence rows during restore, the restore script executes:
```sql
SET session_replication_role = 'replica';
-- Bulk inserts in topological order --
SET session_replication_role = 'origin';
```

---

## 4. Post-Restore Verification Drill
1. Verify record counts match the backup manifest.
2. Confirm PostGIS extension is active: `SELECT PostGIS_Version();`
3. Run test suite: `npx jest tests/backupRestore.test.ts`
