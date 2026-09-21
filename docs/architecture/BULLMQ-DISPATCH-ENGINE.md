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
| `dispatch` | `dispatch-wave` | `{ requirementId, jobId, waveNumber, offset, operationId, correlationId? }` | 0ms | `dispatch:${requirementId}:wave-${waveNumber}` |
| `timeout` | `wave-timeout` | `{ requirementId, jobId, waveNumber, totalWorkersFound, offset, waveSize, operationId, correlationId? }` | 30,000ms (30s) | `wave-timeout:${requirementId}:wave-${waveNumber}` |

### Deterministic Job IDs
BullMQ deduplicates jobs by `jobId`. By generating deterministic IDs based on `requirementId` and `waveNumber`, identical jobs scheduled multiple times (e.g. by retries, network glitches, or startup reconciliation) are ignored by Redis as duplicates.

---

## 5. Database Backstop & Idempotency Constraints

BullMQ guarantees **at-least-once** delivery. Under network partitions or worker crashes, the same job may be executed more than once. The database enforces identity invariants:

1. `uniq_dispatch_wave_operation_id` on `dispatch_wave(operation_id)`:
   - Prevents two concurrent executions of the **same logical dispatch operation** from ever producing two wave records. This is the primary idempotency backstop added in Issue #23.
2. `uniq_dispatch_wave_req_wave` on `dispatch_wave(requirement_id, wave_number)`:
   - Prevents two workers or duplicate jobs from ever creating duplicate wave records for the same requirement.
3. `uniq_job_dispatch_req_worker` on `job_dispatch(requirement_id, worker_id)`:
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

---

## 9. Canonical Wave Algorithm (Issue #25)

`planDispatchWave()` in `src/features/dispatch/wavePlanner.ts` is the sole
wave-sizing authority. It is pure: the same demand, filled count, wave number,
candidate-page availability, and configuration always produce the same plan.

The centralized configuration is `src/config/dispatchWaveConfig.ts`:

| Variable | Default | Unit | Meaning / validation |
|---|---:|---|---|
| `DISPATCH_WAVE_WORKER_MULTIPLIER` | 2 | factor | Candidates targeted = remaining capacity × multiplier; positive integer. |
| `DISPATCH_WAVE_RADII_METERS` | `3000,5000,10000,15000` | metres | Radius by 1-based wave; final configured radius is the cap. |
| `DISPATCH_WAVE_TIMEOUT_MS` | 30000 | milliseconds | Persisted dispatch acceptance deadline; positive integer. |
| `DISPATCH_MAX_WAVES` | number of radii | count | Inclusive terminal wave; cannot exceed the supplied radius list. |

For example, a requirement needing five workers with four already assigned has
one remaining slot. With multiplier two, every permitted wave targets two
candidates, not ten. A candidate page smaller than the target is dispatched as
returned; it does **not** itself prove global exhaustion. The currently
persisted timeout payload carries the candidate set observed by its operation;
Issue #26 will replace that proxy with explicit pagination exhaustion metadata.
A zero candidate result on the final permitted wave transitions the requirement to
`NO_WORKERS_AVAILABLE`; earlier waves may advance to the next configured radius.

BullMQ dispatch, timeout escalation, decline escalation, reconciliation, and
the deprecated non-production test fixture all consume this configuration/planner.
Timeout jobs are delayed by the plan timeout, and maximum waves stop retry loops.
Queue retries use the same `(requirementId, waveNumber)` input and therefore
produce the same plan; existing operation IDs and unique database constraints
remain the idempotency backstop.

## 10. Dispatch Operation Idempotency (Issue #23)

**Added in Issue #23 (Audit #43, #75).** Every dispatch wave is uniquely identified by a deterministic **operation ID** derived from its business inputs.

### Operation ID Formula

```
operationId = "disp_op_" + sha256("req:<reqId>:wave:<waveNum>:type:<opType>")[0..31]
```

Generated by `generateDispatchOperationId()` in [`src/features/dispatch/dispatchOperation.ts`](../../src/features/dispatch/dispatchOperation.ts).

The formula is:
- **Deterministic**: identical inputs always produce the same ID
- **Collision-resistant**: SHA-256 prefix, 32 hex chars (128-bit)
- **Human-readable prefix**: `disp_op_` identifies its domain

### Processor Idempotency Protocol

The `processDispatchJob` function follows a strict protocol to guarantee safe retries:

```
1. Compute deterministic operationId from (requirementId, waveNumber, operationType)
2. CHECK EXISTING WAVE:
   SELECT * FROM dispatch_wave WHERE operation_id = ? OR (requirement_id = ? AND wave_number = ?)
   ├─ Found → return DispatchOperationResult{status: 'already_processed'} immediately
   └─ Not found → proceed
3. EXECUTE ATOMIC WRITES:
   BEGIN TRANSACTION
     INSERT dispatch_wave (operation_id, requirement_id, wave_number, ...)
     INSERT job_dispatch rows (skipDuplicates: true)
   COMMIT
   ├─ Success → proceed to timeouts and notifications
   └─ P2002 / 23505 (unique constraint race) →
       SELECT committed wave
       return DispatchOperationResult{status: 'already_processed'}
```

### Layered Deduplication

| Layer | Mechanism | Scope |
|---|---|---|
| **BullMQ** | Deterministic `jobId` on queue add | Prevents duplicate queue jobs |
| **Application** | Pre-write `findFirst` by `operation_id` | Fast-path for sequential retries |
| **Database** | `UNIQUE(operation_id)` on `dispatch_wave` | Final backstop for concurrent races |
| **Database** | `UNIQUE(requirement_id, wave_number)` | Guards against wave duplication |

### Safe Return Contract

A retry of a dispatch operation that has already been executed returns a `DispatchOperationResult` with:
- `status: 'already_processed'`
- Same `waveId`, `operationId`, and `workerIds` as the original execution
- No new database rows written
- No new notifications sent
