# LabourBaba Backend — Incident Response & Triage Runbook

## 1. High Priority Alerts & Triage Steps

### 1.1 `DatabaseConnectionPoolExhausted`
- **Symptom**: HTTP 500 errors; logs show `Timed out waiting for connection from pool`.
- **Immediate Action**:
  1. Check PostgreSQL active connections: `SELECT count(*), state FROM pg_stat_activity GROUP BY state;`
  2. Terminate idle connections if necessary: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state = 'idle' AND state_change < NOW() - INTERVAL '5 minutes';`
  3. Verify application pool settings (`PRISMA_POOL_MAX=50`).

### 1.2 `PaymentReconciliationDiscrepancy`
- **Symptom**: Payments marked `QUARANTINED` in `payment` table.
- **Immediate Action**:
  1. Query quarantined payments: `SELECT * FROM payment WHERE status = 'QUARANTINED';`
  2. Inspect audit logs for captured amount vs order expected amount.
  3. Contact customer support or initiate manual Razorpay dashboard review.

### 1.3 `NotificationOutboxBacklogSpike`
- **Symptom**: `notification_outbox_queue_depth{status="PENDING"} > 500`.
- **Immediate Action**:
  1. Check BullMQ worker logs for Redis connection failures or FCM quota limits.
  2. Check stuck processing rows: `SELECT count(*) FROM notification_outbox WHERE status = 'PROCESSING' AND locked_until < NOW();`
  3. Restart worker pods if necessary.
