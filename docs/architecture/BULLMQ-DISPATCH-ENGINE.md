# BullMQ Dispatch Engine — Authoritative Architecture Specification

## 1. Overview & Core Invariant

The LabourBaba dispatch subsystem matches customer job requirements to verified, online workers within expanding geographic radii.

### The Core Invariant
```
             ONE PRODUCTION DISPATCH ENGINE = BULLMQ
             
   BUSINESS STATE  ──►  PostgreSQL (ACID, Row-Locks, Unique Constraints)
   SCHEDULING      ──►  BullMQ / Redis (Durable Delayed Jobs, At-Least-Once)
   SIDE EFFECTS    ──►  Notification Workers (FCM, Socket.IO)
```

**Under no circumstances does production dispatch timing depend on Node.js process memory (`setTimeout`, `setInterval`, in-process polling loops, or process-local arrays/maps).**

---

## 2. Why BullMQ is the Only Production Dispatch Scheduler

Previously, two competing dispatch mechanisms existed in the codebase:
1. **BullMQ Worker Dispatch (`src/workers/dispatchWorker.ts`)**: Workers processing jobs from a Redis queue.
2. **Simple In-Memory Dispatch (`src/features/dispatch/simpleDispatch.ts`)**: A monolithic loop using `sleep(ms)` (`setTimeout`), database polling (`while (Date.now() < deadline)`), and process memory.

### Failure Modes of the Legacy Approach:
- **Volatile Timers**: If the Node.js API process crashed, deployed, or restarted during an in-flight dispatch wave, the in-memory timer and `while` loop were lost immediately. The requirement became permanently stuck with pending `job_dispatch` rows that never timed out, and subsequent waves were never scheduled.
- **Inverted Notification Ordering**: In `dispatchWorker.ts`, FCM and Socket.IO notifications were dispatched to workers *before* inserting `dispatch_wave` and `job_dispatch` rows into PostgreSQL. If the process crashed or the database insert failed immediately after FCM, workers received push notifications for jobs that could not be accepted.
- **Divergent Dispatch Algorithms**: Changes made to candidate selection, wave escalation, or timeouts in one path drifted from the other.
- **Race-Prone Deduplication**: No unique constraint existed on `dispatch_wave(requirement_id, wave_number)` or `job_dispatch(requirement_id, worker_id)`.

---

## 3. The Unified Production Dispatch Pipeline

```
Requirement Becomes Dispatchable (OPEN)
             │
             ▼
[jobService / DB Commit]
  - DB Tx: Requirement status ➔ 'DISPATCHING', Job status ➔ 'SEARCHING'
  - dispatchQueue.add('dispatch-wave', { requirementId, jobId, waveNumber: 1, offset: 0 }, { jobId: 'dispatch:<reqId>:wave-1' })
             │
             ▼
[BullMQ Worker: dispatchWorker]
  1. Authoritative DB Re-Read: Validate requirement is not FILLED or CANCELLED
  2. Idempotency Check: Verify wave 1 does not already exist
  3. Spatial Candidate Selection: getEligibleDispatchCandidates (PostGIS, verified, online, skill-matched, location fresh)
  4. ATOMIC DB TRANSACTION (PERSIST FIRST):
     - INSERT dispatch_wave (UNIQUE requirement_id, wave_number)
     - INSERT job_dispatch rows (UNIQUE requirement_id, worker_id)
  5. DURABLE TIMEOUT REGISTRATION:
     - timeoutQueue.add('wave-timeout', { ... }, { delay: 30_000, jobId: 'wave-timeout:<reqId>:wave-1' })
  6. NOTIFICATION SIDE EFFECTS (SIDE EFFECTS LAST):
     - FCM Push & Socket.IO events to wave candidates
             │
      ┌──────┴────────────────────────────────┐
      ▼                                       ▼
Worker Accepts                             Wave Times Out (30s)
[dispatchServices.acceptDispatch]         [BullMQ Worker: timeoutWorker]
  - PostgreSQL Row-Lock (FOR UPDATE)        1. Re-read requirement status (if FILLED: safely no-op)
  - Slot reserved & Booking created         2. Mark remaining pending dispatches as 'timeout'
  - Remaining dispatches cancelled          3. Mark dispatch_wave as 'exhausted'
  - Job transitions to 'BOOKED'             4. If more workers exist:
                                               dispatchQueue.add('dispatch-wave', wave + 1, { jobId: 'dispatch:<reqId>:wave-<n>' })
                                            5. If candidates exhausted:
                                               Requirement transitions to 'NO_WORKERS_AVAILABLE'
```

---

## 4. BullMQ Queue & Job Types

| Queue Name | Job Name | Payload | Delay | Job ID Scheme (Deduplication) |
|---|---|---|---|---|
| `dispatch` | `dispatch-wave` | `{ requirementId, jobId, waveNumber, offset, correlationId? }` | 0ms | `dispatch:${requirementId}:wave-${waveNumber}` |
| `timeout` | `wave-timeout` | `{ requirementId, jobId, waveNumber, totalWorkersFound, offset, waveSize, correlationId? }` | 30,000ms (30s) | `wave-timeout:${requirementId}:wave-${waveNumber}` |

### Deterministic Job IDs
BullMQ deduplicates jobs by `jobId`. By generating deterministic IDs based on `requirementId` and `waveNumber`, identical jobs scheduled multiple times (e.g. by retries, network glitches, or startup reconciliation) are ignored by Redis as duplicates.

---

## 5. Database Backstop & Idempotency Constraints

BullMQ guarantees **at-least-once** delivery. Under network partitions or worker crashes, the same job may be executed more than once. The database enforces identity invariants:

1. `uniq_dispatch_wave_req_wave` on `dispatch_wave(requirement_id, wave_number)`:
   - Prevents two workers or duplicate jobs from ever creating duplicate wave records for the same requirement.
2. `uniq_job_dispatch_req_worker` on `job_dispatch(requirement_id, worker_id)`:
   - Prevents the same worker from ever being dispatched more than once for a requirement across all waves.

---

## 6. Startup Reconciliation (`dispatchReconciliationService.ts`)

Startup reconciliation runs automatically during application bootstrap (after PostgreSQL and Redis connections are established, before serving HTTP/Socket traffic).

### Orphaned State Detection & Recovery Matrix

| Detected State | Condition | Recovery Action |
|---|---|---|
| **Expired Active Wave** | `dispatch_wave.status = 'active'` AND `notified_at + 30s <= NOW()` | Marks pending dispatches as `timeout`, marks wave as `exhausted`, and enqueues next wave to `dispatchQueue`. |
| **Active In-Flight Wave** | `dispatch_wave.status = 'active'` AND `notified_at + 30s > NOW()` | Re-enqueues `wave-timeout` in `timeoutQueue` with remaining delay (`expiresAt - NOW()`), restoring lost timers across process restarts. |
| **Orphaned Requirement** | `job_requirement.status = 'DISPATCHING'` with zero waves | Enqueues initial wave 1 into `dispatchQueue` with deterministic `jobId`. |
| **Terminal Requirement** | Status is `FILLED`, `CANCELLED`, or `NO_WORKERS_AVAILABLE` | No action required; safely skipped. |

Reconciliation is completely idempotent and safe for multi-instance deployments.

---

## 7. Status of `simpleDispatch.ts`

`src/features/dispatch/simpleDispatch.ts` is **completely removed from production execution paths**:
- Zero files in `src/` import `simpleDispatch`.
- Guarded by a fatal runtime assertion: if loaded in `NODE_ENV === 'production'`, it throws `[FATAL_ARCHITECTURE_VIOLATION]`.
- Enforced by automated architecture tests (`tests/dispatchArchitectureGuards.test.ts`).

---

## 8. Operational Failure Policy (No Volatile Fallback)

If Redis or BullMQ becomes unavailable:
1. Application boot fails fast via `assertBullMQConfig()`.
2. Job creation surfaces an operational error (`DispatchQueueUnavailableError`).
3. **The system NEVER falls back to `setTimeout`, `setInterval`, or in-memory dispatch.**
4. Database state remains clean; startup reconciliation will automatically recover all dispatchable requirements once Redis connectivity is restored.
