# Runbook: PostgreSQL Database Failure

## Overview
- **Alert**: `DatabaseUnavailable`
- **Severity**: Critical
- **Trigger**: Readiness probe reports database health check failure (`status: 503 Service Unavailable`).
- **User Impact**: Complete marketplace outage. HTTP and WebSocket traffic cannot read or write data.

---

## 1. Initial Triage
1. **Verify Connectivity**:
   ```bash
   npx tsx scratch/verifyPostgis.ts
   ```
2. **Check Cloud / Managed DB Metrics (Supabase / RDS / Aurora)**:
   - CPU utilization, Memory, Disk IOPS, Connection pool exhaustion.

## 2. Likely Causes
- **Connection Pool Saturation**: Too many direct connections without PgBouncer.
- **Database Restart / Maintenance**: Cloud provider maintenance event.
- **Disk Full**: Database storage exceeded volume quota.

## 3. Mitigation & Recovery
1. **Verify PgBouncer / Pooler URL**: Ensure `DATABASE_URL` uses transaction pooler mode.
2. **Restart Unresponsive Connections**: Terminate idle connections if connection pool is stuck.
3. **Failover**: If primary instance is dead, initiate replica promotion via provider console.
