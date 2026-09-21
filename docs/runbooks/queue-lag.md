# Runbook: High Queue Lag & Worker Backlog

## Overview
- **Alert**: `QueueLagHigh`
- **Severity**: Warning
- **Trigger**: BullMQ waiting queue length exceeds 100 jobs for over 5 minutes.
- **User Impact**: Delayed wave notifications, slow dispatch matching, delayed background processing.

---

## 1. Initial Triage
1. **Check Bull Board Dashboard**:
   - Navigate to `/admin/queues` (authenticated admin session).
   - Inspect job counts for `dispatchQueue` and `outboxQueue`.
2. **Inspect Worker Status**:
   - Check worker process logs for stuck execution loops or database deadlocks.

## 2. Likely Causes
- **Worker Process Crash**: Worker crashed or ran out of memory, leaving jobs unacknowledged.
- **Provider Rate Limiting / Latency**: Outbound FCM or Socket.IO emissions experiencing network latency.
- **Spike in Job Creation**: Sudden massive surge in customer requirements creating thousands of wave jobs.

## 3. Mitigation & Recovery
1. **Restart Worker Pods / Instances**:
   - Scale worker instances horizontally to absorb high queue volume.
2. **Clean Stale Stuck Jobs**:
   - Stale `PROCESSING` outbox events will be automatically reconciled by `outboxService.reconcileStaleEvents()`.
