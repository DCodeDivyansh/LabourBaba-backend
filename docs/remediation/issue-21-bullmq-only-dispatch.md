# Issue #21 — Implementation Report: Make BullMQ the Only Production Dispatch Engine

## 1. Root Cause
The previous dispatch architecture was inherently unsafe for production:
1. **Volatile Timers**: `simpleDispatch.ts` utilized `setTimeout`, `sleep()`, and in-process database polling (`while (Date.now() < deadline)`). An API or worker crash immediately killed all in-flight wave timers, leaving requirements permanently stuck.
2. **Inverted Ordering**: `dispatchWorker.ts` emitted FCM and Socket.IO notifications before committing `dispatch_wave` and `job_dispatch` rows. If the process crashed after notification, workers were notified for phantom dispatches.
3. **Competing Engines**: `job.services.ts` called `dispatchJobSimple`, while `dispatchWorker.ts` and `timeoutWorker.ts` existed in parallel with commented-out queue additions in `dispatchServices.ts`.
4. **Missing Database Backstops**: `dispatch_wave` and `job_dispatch` lacked database-level unique constraints, allowing duplicate waves and worker double-dispatches under concurrent execution or BullMQ redeliveries.

---

## 2. Repository Findings
- `src/features/jobs/job.services.ts`: Line 81 directly invoked `dispatchJobSimple`.
- `src/features/dispatch/dispatchServices.ts`: Multi-wave BullMQ queuing lines 402–416 were commented out.
- `src/workers/dispatchWorker.ts`: Inverted notification vs. persistence ordering.
- `src/workers/timeoutWorker.ts`: Existed but was uncoordinated with the rest of the application bootstrap.
- `src/server.ts`: Did not validate BullMQ configuration or perform startup reconciliation.

---

## 3. Architecture Before
- **BullMQ Path**: Inactive in production (`job.services.ts` bypassed it; `dispatchServices.ts` commented it out).
- **simpleDispatch Path**: Monolithic sequential loop with in-memory `sleep` and polling loops.
- **Timers/Polling**: Volatile `setTimeout` and `while` polling loops.
- **Restart Behavior**: All in-flight timers died on restart; pending dispatches were orphaned.

---

## 4. Architecture After
- **One Production Engine**: BullMQ backed by Redis is the only scheduler.
- **Durable Business State**: PostgreSQL transactions govern all state transitions (`DISPATCHING`, `SEARCHING`, `FILLED`, `NO_WORKERS_AVAILABLE`).
- **Durable Scheduling**: All timing (initial wave, 30s timeout, wave escalation) is managed via BullMQ delayed/standard jobs.
- **Strict Ordering**: Persistence precedes all side effects (FCM, Socket.IO).
- **Startup Reconciliation**: Detects orphaned requirements and unexpired/expired waves, deterministically restoring queue state without duplicates.

---

## 5. Files Changed

| File | Action | Rationale |
|---|---|---|
| `prisma/migrations/20260920090000_dispatch_idempotency_constraints/migration.sql` | NEW | Unique constraints for `(requirement_id, wave_number)` and `(requirement_id, worker_id)`. |
| `prisma/schema.prisma` | MODIFY | Added `@@unique` constraints to `dispatch_wave` and `job_dispatch`. |
| `src/config/bullmq.ts` | MODIFY | Added `assertBullMQConfig()`, standardized queue constants, and safe connection parsing. |
| `src/workers/dispatchWorker.ts` | MODIFY | Reordered persistence before notification, added idempotency checks, and durable BullMQ timeout scheduling. |
| `src/workers/timeoutWorker.ts` | MODIFY | Added authoritative DB re-read, safe destructuring, and deterministic wave escalation. |
| `src/features/jobs/job.services.ts` | MODIFY | Replaced `dispatchJobSimple` with BullMQ `dispatchQueue.add`. |
| `src/features/dispatch/dispatchServices.ts` | MODIFY | Re-enabled BullMQ `dispatchQueue.add` on wave decline. |
| `src/features/dispatch/simpleDispatch.ts` | MODIFY | Deprecated and added fatal production execution guard. |
| `src/features/dispatch/dispatchReconciliationService.ts` | NEW | Automated, idempotent startup reconciliation for orphaned dispatch states. |
| `src/server.ts` | MODIFY | Wired `assertBullMQConfig()` and `reconcileDispatchState()` into bootstrap sequence. |
| `tests/dispatchArchitectureGuards.test.ts` | NEW | Enforces zero `simpleDispatch` imports and zero volatile timers in production code. |
| `tests/bullmqDispatchLifecycle.test.ts` | NEW | Proves persistence-before-notification, durable timeouts, progressive escalation, and reconciliation. |
| `tests/dispatchDatabaseConcurrency.test.ts` | NEW | Proves database constraints reject duplicate waves and duplicate worker dispatches on real PostgreSQL. |
| `docs/architecture/BULLMQ-DISPATCH-ENGINE.md` | NEW | Architectural specification and operational runbook. |

---

## 6. Database Changes
Migration `20260920090000_dispatch_idempotency_constraints`:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_dispatch_wave_req_wave" ON "dispatch_wave"("requirement_id", "wave_number");
ALTER TABLE "dispatch_wave" ADD CONSTRAINT "uniq_dispatch_wave_req_wave" UNIQUE USING INDEX "uniq_dispatch_wave_req_wave";

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_job_dispatch_req_worker" ON "job_dispatch"("requirement_id", "worker_id");
ALTER TABLE "job_dispatch" ADD CONSTRAINT "uniq_job_dispatch_req_worker" UNIQUE USING INDEX "uniq_job_dispatch_req_worker";
```

---

## 7. Queue Changes
- **Queues**: `dispatch` (wave processing), `timeout` (delayed 30s acceptance timeout).
- **Job Types**:
  - `dispatch-wave`: `{ requirementId, jobId, waveNumber, offset, correlationId? }`
  - `wave-timeout`: `{ requirementId, jobId, waveNumber, totalWorkersFound, offset, waveSize, correlationId? }`
- **Delays**: 30,000ms for `wave-timeout`.
- **Retry Behavior**: Exponential backoff (1000ms base, 3 attempts).
- **Idempotency Strategy**: Deterministic BullMQ job IDs (`dispatch:${reqId}:wave-${n}`, `wave-timeout:${reqId}:wave-${n}`).

---

## 8. Startup Reconciliation
- **Orphaned State Definition**:
  - Wave with `status = 'active'` and `notified_at + 30s <= NOW()` ➔ Expired downtime wave: closes wave and schedules next wave.
  - Wave with `status = 'active'` and `notified_at + 30s > NOW()` ➔ In-flight wave: restores timeout in `timeoutQueue` with remaining delay.
  - Requirement in `DISPATCHING` or `OPEN` with no waves ➔ Enqueues initial wave 1.
- **Idempotency**: Deterministic job IDs prevent duplicate jobs in Redis; database constraints prevent duplicate waves.

---

## 9. Legacy Dispatcher
- `simpleDispatch.ts` is completely removed from all production paths.
- It contains an explicit production guard throwing `[FATAL_ARCHITECTURE_VIOLATION]` if loaded with `NODE_ENV === 'production'`.
- Verified by automated architecture tests (`tests/dispatchArchitectureGuards.test.ts`).

---

## 10. Restart Guarantees
- **API Crashes**: In-flight waves survive in BullMQ/Redis; workers continue processing without interruption.
- **Worker Crashes**: BullMQ stalled job detection reassigns stalled jobs to active workers.
- **Redis Temporarily Fails**: Safe operational error; startup reconciliation recovers all active states once Redis is restored. No volatile fallback is ever activated.
- **PostgreSQL Temporarily Fails**: BullMQ job retries with exponential backoff.

---

## 11. Tests Added
1. `tests/dispatchArchitectureGuards.test.ts`:
   - Proves zero imports of `simpleDispatch` in production code.
   - Proves no `setTimeout` or `setInterval` in dispatch paths.
   - Proves no in-process polling loops.
   - Proves runtime production load assertion.
2. `tests/bullmqDispatchLifecycle.test.ts`:
   - Proves persistence precedes FCM notifications.
   - Proves delayed BullMQ timeout creation.
   - Proves safe terminal state no-op.
   - Proves startup reconciliation across all 3 orphaned state categories.
   - Proves reconciliation idempotency.
3. `tests/dispatchDatabaseConcurrency.test.ts`:
   - Proves PostgreSQL unique constraint on `dispatch_wave(requirement_id, wave_number)` under 10 concurrent requests.
   - Proves PostgreSQL unique constraint on `job_dispatch(requirement_id, worker_id)` under 10 concurrent requests.

---

## 12. Verification Commands & Results
- `npx jest tests/dispatchArchitectureGuards.test.ts`: **PASS (4/4)**
- `npx jest tests/bullmqDispatchLifecycle.test.ts`: **PASS (10/10)**
- `npx jest tests/dispatchDatabaseConcurrency.test.ts`: **PASS (2/2)**
- `npx jest tests/bullmqDispatchSecurity.test.ts`: **PASS (24/24)**
- `npx jest tests/dispatchRadiusSecurity.test.ts`: **PASS (14/14)**
- `npm test`: **PASS (38 test suites, 826 tests passed)**
- `npx tsc --noEmit`: **PASS (0 errors)**
- `npm run build`: **PASS (Build successful)**

---

## 13. Remaining Risks / Follow-up
- **Issue #22 (Persist dispatch before notifications)**: Fully aligned and foundational invariants established in `dispatchWorker.ts`. Outbox pattern formalization remains for Issue #22.
- **Issue #23 (Dispatch operation idempotency)**: Database unique constraints established; full request-level idempotency keys can build directly on top of this.
- **Issues #25–28**: Wave algorithm tuning, pagination, and location freshness remain decoupled and unaffected.
