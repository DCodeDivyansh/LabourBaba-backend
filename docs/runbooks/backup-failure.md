# Runbook: Database Backup Failure

## Overview
- **Alert**: `BackupFailure`
- **Severity**: Critical
- **Trigger**: No verified database backup completed in over 24 hours.
- **User Impact**: RPO (Recovery Point Objective) target is violated; risk of data loss in catastrophic disaster scenarios.

---

## 1. Initial Triage
1. **Check Backup Script Logs**:
   - Inspect `/var/log/backup.log` or CI/cron execution logs for `scripts/backup-db.ts`.
2. **Check Storage Destination**:
   - Check destination S3 bucket / local backup directory permissions and free disk space.

## 2. Likely Causes
- **Disk Full**: Insufficient disk space on the backup runner host.
- **Authentication Failure**: IAM credentials expired or revoked for backup storage bucket.
- **PostgreSQL Lock Timeout**: `pg_dump` timed out waiting for access during heavy migration locks.

## 3. Mitigation & Recovery
1. **Trigger Immediate Manual Backup**:
   ```bash
   npx tsx scripts/backup-db.ts
   ```
2. **Verify Backup Integrity**: Check file size and SHA-256 checksum.
