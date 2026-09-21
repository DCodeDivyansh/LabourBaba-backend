# Issues 20–24 Production Remediation

## Executive Summary

This document details the production-grade remediation, verification, and hardening for **Roadmap Issues 20–24** of the LabourBaba Backend platform:
- **Issue 20**: Enforce One Review Per Booking (Unique constraint, error mapping, PostgreSQL concurrency)
- **Issue 21**: Make BullMQ the Only Production Dispatch Engine (Eliminate volatile timers/polling, startup reconciliation)
- **Issue 22**: Persist Dispatch Before Notifications (Transactional DB commit before notification queue enqueue)
- **Issue 23**: Dispatch Operation Idempotency (Deterministic `operation_id` via SHA-256, unique constraint on `dispatch_wave`)
- **Issue 24**: Reserve Booking Capacity Atomically (`SELECT ... FOR UPDATE` row locking, atomic capacity ledger)

All remediations enforce zero-trust authorization policies, PostgreSQL database invariants, strict DTO boundaries, atomic concurrency controls, and comprehensive regression protection ensuring Issues 1–19 remain completely unbroken.

---

## Repository Baseline & Progress

- **Issues 1–19 Baseline**: 21 test suites, 435 tests passing.
- **Post-Remediation (Issues 1–24)**: 32 test suites, **555 tests passing**, zero regressions, clean TypeScript build (`npm run typecheck`).
- **Postgres Database Concurrency**: Verified under 25–50 simultaneous concurrent race conditions without overbooking, duplicate reviews, or dispatch corruption.

---

## Issue 20: Enforce One Review Per Booking

### Problem & Root Cause
1. `review` table in PostgreSQL lacked a database-level `UNIQUE` constraint on `booking_id`.
2. Under concurrent requests or rapid mobile retries, application-level checks (`findFirst` followed by `create`) suffered from race conditions, allowing multiple reviews for the same booking.

### Implementation
- Database unique constraint and index applied: `uniq_review_booking` on `review(booking_id)`.
- Implemented `isReviewUniqueConstraintError` in [reviewServices.ts](file:///e:/LabourBaba/LabourBaba-backend/src/features/review/reviewServices.ts) to detect Prisma `P2002` and SQLSTATE `23505`.
- Mapped duplicate review submissions to HTTP 409 `REVIEW_ALREADY_EXISTS`.
- Handled completion inline reviews idempotently to prevent transaction rollbacks.

### Tests & Evidence
- [reviewPostgresConcurrency.test.ts](file:///e:/LabourBaba/LabourBaba-backend/tests/reviewPostgresConcurrency.test.ts): 7 unmocked tests against live PostgreSQL proving 2, 10, and 25 concurrent review requests create exactly 1 review row.
- [reviewSecurity.test.ts](file:///e:/LabourBaba/LabourBaba-backend/tests/reviewSecurity.test.ts): 26 unit and authorization tests.

---

## Issue 21: Make BullMQ the Only Production Dispatch Engine

### Problem & Root Cause
1. In-process `setTimeout`, `sleep()`, and `while (Date.now() < deadline)` in `simpleDispatch.ts` died on server restart or crash, leaving requirements permanently orphaned.
2. Multiple competing dispatch paths existed in the codebase.

### Implementation
- Fully decommissioned `simpleDispatch.ts` and added runtime fatal production guards throwing `[FATAL_ARCHITECTURE_VIOLATION]` if loaded in production.
- Established BullMQ as the single production dispatch and timeout engine.
- Implemented automated startup reconciliation in [dispatchReconciliationService.ts](file:///e:/LabourBaba/LabourBaba-backend/src/features/dispatch/dispatchReconciliationService.ts) to recover expired downtime waves and unexpired in-flight timeouts on bootstrap.
- Applied unique constraints `uniq_dispatch_wave_req_wave` on `dispatch_wave(requirement_id, wave_number)` and `uniq_job_dispatch_req_worker` on `job_dispatch(requirement_id, worker_id)`.

### Tests & Evidence
- [dispatchArchitectureGuards.test.ts](file:///e:/LabourBaba/LabourBaba-backend/tests/dispatchArchitectureGuards.test.ts): Enforces zero `simpleDispatch` imports and zero volatile timers.
- [bullmqDispatchLifecycle.test.ts](file:///e:/LabourBaba/LabourBaba-backend/tests/bullmqDispatchLifecycle.test.ts): Validates delayed timeout scheduling, candidate exhaustion, and startup reconciliation.
- [dispatchDatabaseConcurrency.test.ts](file:///e:/LabourBaba/LabourBaba-backend/tests/dispatchDatabaseConcurrency.test.ts): Proves database unique constraints under concurrent inserts.

---

## Issue 22: Persist Dispatch Before Notifications

### Problem & Root Cause
`dispatchWorker.ts` sent FCM push notifications and Socket.IO events *before* persisting `dispatch_wave` and `job_dispatch` rows. A crash after notifications meant workers received phantom alerts. Furthermore, inline notifications lacked retry durability.

### Implementation
- Enforced strict ordering: DB transaction commits `dispatch_wave` and `job_dispatch` rows $\to$ enqueues delayed timeout in `timeoutQueue` $\to$ enqueues durable notification job in `notificationQueue`.
- Created dedicated [notificationWorker.ts](file:///e:/LabourBaba/LabourBaba-backend/src/workers/notificationWorker.ts) with per-worker failure isolation (`Promise.allSettled`), ensuring failed FCM delivery to one worker does not affect others or roll back DB state.
- Used deterministic notification job IDs (`notify:<reqId>:wave-<n>`) to eliminate duplicate notifications upon job retry.

### Tests & Evidence
- [dispatchNotificationOrdering.test.ts](file:///e:/LabourBaba/LabourBaba-backend/tests/dispatchNotificationOrdering.test.ts): 17 tests across 8 failure scenarios proving DB persistence precedes notification enqueuing and verifying per-worker failure isolation.

---

## Issue 23: Dispatch Operation Idempotency

### Problem & Root Cause
BullMQ provides at-least-once delivery. On worker crashes or network hiccups, re-processed dispatch jobs created duplicate waves and ghost dispatch rows without correlation to a business operation.

### Implementation
- Derived deterministic SHA-256 operation IDs:
  $$\text{operationId} = \text{"disp\_op\_"} + \text{SHA256}(\text{"req:"} + \text{reqId} + \text{":wave:"} + \text{waveNumber} + \text{":type:standard"})[0..32]$$
- Added `operation_id VARCHAR(255) UNIQUE` column and index on `dispatch_wave`.
- Implemented three-layer idempotency protocol in [dispatchWorker.ts](file:///e:/LabourBaba/LabourBaba-backend/src/workers/dispatchWorker.ts):
  1. Pre-write check returning `already_processed`.
  2. Atomic write with `operation_id`.
  3. Unique constraint race handler (catching `P2002`/`23505` and retrieving committed state).

### Tests & Evidence
- [dispatchOperationIdempotency.test.ts](file:///e:/LabourBaba/LabourBaba-backend/tests/dispatchOperationIdempotency.test.ts): 13 tests proving deterministic ID generation, real PostgreSQL concurrency rejection, and safe BullMQ retries.

---

## Issue 24: Reserve Booking Capacity Atomically

### Problem & Root Cause
`job_requirement.worker_count_needed` could be overfilled when multiple workers concurrently accepted dispatches. Application-only reads permitted race conditions on the last available slot.

### Implementation
- `acceptDispatch` acquires a PostgreSQL row-level lock on the `job_requirement` row using `SELECT ... FOR UPDATE`.
- The requirement row serves as the authoritative cross-process capacity ledger:
  $$\text{Invariant: } 0 \le \text{worker\_count\_filled} \le \text{worker\_count\_needed}$$
- Increments `worker_count_filled` and verifies limits inside the transaction *before* creating the booking.
- Maps unique constraint violations (`uniq_booking_requirement_worker`) and lock race conflicts to safe HTTP 409 (`SLOTS_FULL` / `BOOKING_ALREADY_EXISTS`).
- Automatically expires remaining pending dispatches upon reaching filled capacity and emits real-time `job:closed` socket events post-commit.

### Tests & Evidence
- [bookingCapacityPostgresConcurrency.test.ts](file:///e:/LabourBaba/LabourBaba-backend/tests/bookingCapacityPostgresConcurrency.test.ts): Unmocked PostgreSQL suite with 50 simultaneous worker accepts across 1, 2, and 10 slot requirements proving 0 overbookings.
- [dispatchAcceptanceSecurity.test.ts](file:///e:/LabourBaba/LabourBaba-backend/tests/dispatchAcceptanceSecurity.test.ts): 17 security regression tests.
- [duplicateBookingSecurity.test.ts](file:///e:/LabourBaba/LabourBaba-backend/tests/duplicateBookingSecurity.test.ts): 10 concurrency & transaction rollback tests.

---

## Full Regression & Gate Evidence

```bash
npx jest tests/reviewSecurity.test.ts tests/jobSecurity.test.ts tests/authorizationMatrix.test.ts tests/dtoBoundarySecurity.test.ts tests/jobDetailRequirementSecurity.test.ts tests/dtoAllowlist.test.ts tests/chatSecurity.test.ts tests/socketSecurity.test.ts tests/workerDocumentSecurity.test.ts tests/workerDeviceLifecycle.test.ts tests/refreshSessionSecurity.test.ts tests/suspensionRevocationSecurity.test.ts tests/phoneNormalization.test.ts tests/otpSecurity.test.ts tests/jobStateMachine.test.ts tests/requirementStateMachine.test.ts tests/bookingStateMachine.test.ts tests/bookingRaceTransitions.test.ts tests/bookingOtpSecurity.test.ts tests/bookingCustomerConfirmation.test.ts tests/bookingCancellationSecurity.test.ts tests/reviewPostgresConcurrency.test.ts tests/dispatchArchitectureGuards.test.ts tests/bullmqDispatchLifecycle.test.ts tests/dispatchDatabaseConcurrency.test.ts tests/bullmqDispatchSecurity.test.ts tests/dispatchRadiusSecurity.test.ts tests/dispatchNotificationOrdering.test.ts tests/dispatchOperationIdempotency.test.ts tests/dispatchAcceptanceSecurity.test.ts tests/duplicateBookingSecurity.test.ts tests/bookingCapacityPostgresConcurrency.test.ts --runInBand
# Result: 32 test suites, 555 passed, 0 failed

npm run typecheck
# Result: 0 errors
```
