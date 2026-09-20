# Issue #22 — Persist Dispatch Before Notifications

**Priority**: P1  
**Category**: Dispatch / Reliability  
**Phase**: C — Dispatch & Location  
**Status**: ✅ REMEDIATED  
**Depends on**: Issue #21 (BullMQ-only dispatch engine)

---

## Problem Statement

The original `dispatchWorker.ts` (BullMQ dispatch worker) sent FCM push notifications and Socket.IO real-time events to workers **before** creating the `dispatch_wave` and `job_dispatch` rows in PostgreSQL. This violated the fundamental ordering invariant required for durable, reliable dispatch:

```
❌ BEFORE:   FCM/Socket.IO → INSERT dispatch_wave → INSERT job_dispatch
✅ REQUIRED: INSERT dispatch_wave → INSERT job_dispatch → COMMIT → FCM/Socket.IO
```

Additionally, notification side-effects were fire-and-forget inline calls (`Promise.allSettled()`). If the process crashed after DB commit but before all notifications were delivered, some workers would be silently unnotified with no retry mechanism.

---

## Root Cause

1. **Inverted ordering in `dispatchWorker.ts`**: FCM and Socket.IO delivery occurred before the `$transaction` block that created `dispatch_wave` and `job_dispatch` rows.
2. **No notification durability**: Inline `Promise.allSettled` provided no retry semantics. A BullMQ worker process crash between DB commit and notification delivery would silently drop notifications.

---

## Solution

### Architecture

The dispatch pipeline now enforces strict ordering through two BullMQ workers:

```
[dispatchWorker]
  1. Re-read requirement state (idempotency guard)
  2. Fetch candidates via dispatchCandidate.service
  3. ATOMIC DB TX:
     - INSERT dispatch_wave (UNIQUE requirement_id, wave_number)
     - INSERT job_dispatch rows (UNIQUE requirement_id, worker_id)
  4. COMMIT
  5. timeoutQueue.add('wave-timeout', delay: 30s)   ← durable BullMQ job
  6. notificationQueue.add('dispatch-notify', ...)  ← durable BullMQ job (NEW)

[notificationWorker]  ← NEW WORKER
  - Reads worker list and delivery payload from job data
  - Sends FCM push to each worker (independently caught per-worker)
  - Emits Socket.IO 'job:incoming' to each worker (independently caught)
  - BullMQ retries the notification job on failure (up to 5 attempts)
  - FCM/socket failures are NEVER propagated to DB state
```

### Key Invariants

| Invariant | How it's enforced |
|---|---|
| DB commit before notification enqueue | `notificationQueue.add` is called only in step 6, after `$transaction` resolves and `timeoutQueue.add` succeeds |
| DB failure → no notification | If `$transaction` throws, the function throws before reaching `notificationQueue.add` |
| Notification failure → no DB rollback | `notificationWorker` catches FCM/socket errors per-worker; failures never affect the committed DB state |
| Process crash safety | BullMQ persists both timeout and notification jobs in Redis; re-delivered on restart |
| No double-notification | Deterministic job ID `notify:<reqId>:wave-<n>` means BullMQ deduplicates on retry |
| Per-worker failure isolation | `Promise.allSettled` ensures one worker's FCM failure does not abort others |

---

## Files Changed

### `src/config/bullmq.ts`
- Added `NOTIFICATION_QUEUE_NAME = 'notification'` constant.
- Added `DISPATCH_JOB_NAMES.DISPATCH_NOTIFY = 'dispatch-notify'`.
- Added `notificationQueue` BullMQ Queue export (5 retries, exponential backoff).

### `src/workers/notificationWorker.ts` ✨ NEW
- `DispatchNotifyJobData` interface defining the job payload shape.
- `processNotificationJob(data)`: processes FCM and Socket.IO delivery per worker.
- Per-worker try/catch isolation: one failed FCM does not abort delivery to others.
- `getNotificationWorker()`: lazy singleton factory.
- Graceful shutdown on `SIGTERM`/`SIGINT`.

### `src/workers/dispatchWorker.ts`
- **Removed** inline `Promise.allSettled(waveWorkers.map(...sendFCMToWorker/io.to))` block.
- **Removed** now-unused `sendFCMToWorker` and `io` imports.
- **Added** `notificationQueue.add('dispatch-notify', ...)` call after the DB commit and timeout enqueue.
- Deterministic `jobId: notify:<reqId>:wave-<n>` on the notification job.
- On `notificationQueue.add` failure: rethrows so BullMQ retries the dispatch job (which hits the idempotency guard for the DB write and re-attempts the enqueue).

### `src/server.ts`
- Added side-effect `import "./workers/notificationWorker"` so the BullMQ notification consumer starts on bootstrap alongside dispatch and timeout workers.

---

## Tests Added

### `tests/dispatchNotificationOrdering.test.ts` ✨ NEW
17 tests across 8 failure scenarios:

| Scenario | Description | Result |
|---|---|---|
| E | Happy path: DB commit → notification enqueue; not FCM inline | ✅ PASS |
| E | Deterministic jobId passed to `notificationQueue.add` | ✅ PASS |
| E | All dispatched workers in the notification payload | ✅ PASS |
| E | `sendFCMToWorker` and `io.to` NOT called inline in dispatchWorker | ✅ PASS |
| A | DB write throws → `notificationQueue.add` not called | ✅ PASS |
| A | DB createMany throws → `notificationQueue.add` not called | ✅ PASS |
| A | Terminal state (filled) → `notificationQueue.add` not called | ✅ PASS |
| A | No eligible workers → `notificationQueue.add` not called | ✅ PASS |
| B | `notificationQueue.add` throws → dispatchWorker rethrows | ✅ PASS |
| B | DB transaction invoked before notification enqueue fails | ✅ PASS |
| D | Deterministic jobId deduplicates notifications on retry | ✅ PASS |
| C | FCM failure in notificationWorker → resolves without throwing | ✅ PASS |
| C | Socket.IO failure in notificationWorker → resolves without throwing | ✅ PASS |
| F | One worker's FCM failure does not abort others | ✅ PASS |
| G | One worker's Socket.IO failure does not abort others | ✅ PASS |
| H | sendFCMToWorker called with correct payload shape | ✅ PASS |
| H | io.to called with correct worker room and job:incoming event | ✅ PASS |

---

## Notification Paths Audit

All dispatch notification paths were audited and confirmed to have correct persistence-before-notification ordering:

| Location | Notification | Ordering | Status |
|---|---|---|---|
| `dispatchWorker.ts` | FCM + Socket `job:incoming` to workers | Via durable `notificationQueue` after DB commit | ✅ Fixed by this issue |
| `dispatchServices.ts:acceptDispatch` | Socket `job:closed` to workers | After `$transaction` commit | ✅ Already correct |
| `dispatchServices.ts:acceptDispatch` | Socket `worker:accepted` to customer | After `$transaction` commit | ✅ Already correct |
| `dispatchServices.ts:acceptDispatch` | Socket `job:fully_booked` to customer | After `$transaction` commit | ✅ Already correct |
| `timeoutWorker.ts` | Socket `job:no_workers` to customer | After DB updates | ✅ Already correct |
| `chatController.ts` | Socket `chat:message` | After DB chat message persist | ✅ Out of dispatch scope |
| `socketHandlers.ts` | Socket `worker:location` | Location event, not dispatch | ✅ Out of dispatch scope |
