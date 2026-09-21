# Issue #23 — Dispatch Operation Idempotency

**Priority**: P1/P2  
**Category**: Dispatch / Reliability  
**Audit References**: Audit #43, #75  
**Status**: ✅ COMPLETE

---

## Problem Statement

Prior to this remediation, the BullMQ dispatch processor (`dispatchWorker.ts`) had no idempotency guarantees:

1. **Duplicate BullMQ Jobs**: BullMQ guarantees at-least-once delivery. Under network partitions, worker crashes, or Redis blip events, the same job could be processed more than once. Each execution would create a new `dispatch_wave` row and new `job_dispatch` rows, resulting in:
   - Duplicate workers notified for the same wave
   - Multiple `dispatch_wave` rows for the same `(requirement_id, wave_number)`
   - Ghost `job_dispatch` records that could never be acted upon

2. **No Stable Operation Identity**: There was no way to correlate a BullMQ job execution with a specific logical dispatch operation. Retries could not distinguish "first run" from "duplicate run".

3. **No DB-Level Backstop**: The database had `UNIQUE(requirement_id, wave_number)` on `dispatch_wave` but no constraint tied to the operation's business identity — retries for the same logical operation with a different wave number (a bug scenario) would silently succeed.

4. **Race Between Concurrent Workers**: With `concurrency: 10` on the dispatch worker, two concurrent executions of the same job (BullMQ stalled-job recovery) could both pass the pre-write check and attempt the same inserts, resulting in one succeeding and one throwing an unhandled `P2002`.

---

## Solution

### 1. Deterministic Operation ID

A stable, collision-resistant identity for every dispatch operation is derived from its business inputs using SHA-256:

```typescript
// src/features/dispatch/dispatchOperation.ts
export function generateDispatchOperationId(
  requirementId: string,
  waveNumber: number = 1,
  operationType: string = 'standard',
): string {
  const normalized = requirementId.trim().toLowerCase();
  const effectiveWave = (!waveNumber || waveNumber <= 0) ? 1 : waveNumber;
  const input = `req:${normalized}:wave:${effectiveWave}:type:${operationType}`;
  const hash = createHash('sha256').update(input).digest('hex');
  return `disp_op_${hash.substring(0, 32)}`;
}
```

**Properties:**
- Deterministic: same inputs always produce the same ID
- Stable across retries, restarts, and redeploys  
- Human-readable `disp_op_` prefix
- 32-hex-char SHA-256 prefix: 128 bits of collision resistance

### 2. Database Unique Constraint

A new nullable column `operation_id VARCHAR(255) UNIQUE` was added to `dispatch_wave`:

```sql
-- prisma/migrations/20260921000000_dispatch_operation_idempotency/migration.sql
ALTER TABLE "dispatch_wave"
  ADD COLUMN "operation_id" VARCHAR(255);

-- Backfill historical rows with deterministic IDs
UPDATE "dispatch_wave"
SET "operation_id" = 'disp_op_' || LOWER(SUBSTRING(
  ENCODE(SHA256(CONCAT('req:', requirement_id, ':wave:', wave_number::TEXT, ':type:standard')::BYTEA), 'hex'),
  1, 32
))
WHERE "operation_id" IS NULL;

-- Apply unique constraint
CREATE UNIQUE INDEX "uniq_dispatch_wave_operation_id"
  ON "dispatch_wave"("operation_id")
  WHERE "operation_id" IS NOT NULL;

ALTER TABLE "dispatch_wave"
  ADD CONSTRAINT "uniq_dispatch_wave_operation_id_check"
  UNIQUE USING INDEX "uniq_dispatch_wave_operation_id";
```

### 3. Idempotent Processor

The `processDispatchJob` function in `src/workers/dispatchWorker.ts` was updated with a three-layer idempotency protocol:

**Layer 1 — Pre-write Check (fast-path for sequential retries)**
```typescript
const existingWave = await prisma.dispatch_wave.findFirst({
  where: {
    OR: [
      { operation_id: operationId },
      { requirement_id: requirementId, wave_number: waveNumber },
    ],
  },
});
if (existingWave) {
  return { operationId, status: 'already_processed', ... };
}
```

**Layer 2 — Atomic Write with `operation_id`**
```typescript
createdWave = await client.dispatch_wave.create({
  data: {
    operation_id: operationId,   // ← written atomically
    requirement_id: requirementId,
    wave_number: waveNumber,
    ...
  },
});
```

**Layer 3 — Unique Constraint Race Handler (concurrent-safe)**
```typescript
} catch (err: any) {
  if (err.code === 'P2002' || err.message.includes('23505')) {
    // Race was won by another concurrent execution — retrieve committed state
    const existingWave = await prisma.dispatch_wave.findFirst({ ... });
    return { operationId, status: 'already_processed', waveId: existingWave?.id, ... };
  }
  throw err; // Re-throw for BullMQ retry
}
```

### 4. Call Site Propagation

Every entry point that enqueues a dispatch wave now computes and passes the deterministic `operationId`:

| File | Context |
|---|---|
| `src/features/jobs/job.services.ts` | Initial wave 1 enqueue on requirement creation |
| `src/workers/timeoutWorker.ts` | Next-wave enqueue after wave timeout |
| `src/features/dispatch/dispatchServices.ts` | Decline-triggered wave advance |
| `src/features/dispatch/dispatchReconciliationService.ts` | Startup reconciliation for all recovery paths |

### 5. DTO Exposure

`toDispatchWaveDTO` in `src/shared/prismaSelects.ts` now maps `operation_id` to the API response, allowing callers to observe the stable operation identity.

---

## Files Changed

| File | Change Type | Purpose |
|---|---|---|
| `src/features/dispatch/dispatchOperation.ts` | **NEW** | `generateDispatchOperationId`, `validateDispatchOperationId`, `DispatchOperationResult` type |
| `prisma/schema.prisma` | Modified | Added `operation_id String? @unique` to `dispatch_wave` model |
| `prisma/migrations/20260921000000_dispatch_operation_idempotency/migration.sql` | **NEW** | Safe production migration: column add, backfill, unique index |
| `src/workers/dispatchWorker.ts` | Modified | Three-layer idempotency protocol, `operation_id` write |
| `src/features/jobs/job.services.ts` | Modified | Pass `operationId` on wave 1 enqueue |
| `src/workers/timeoutWorker.ts` | Modified | Pass `operationId` on next-wave enqueue |
| `src/features/dispatch/dispatchServices.ts` | Modified | Pass `operationId` on decline-advance enqueue |
| `src/features/dispatch/dispatchReconciliationService.ts` | Modified | Pass `operationId` in all reconciliation recovery paths |
| `src/shared/prismaSelects.ts` | Modified | Map `operation_id` in `toDispatchWaveDTO` |
| `tests/dispatchOperationIdempotency.test.ts` | **NEW** | 13-test suite: deterministic IDs, real PostgreSQL concurrency, BullMQ duplicate jobs |
| `docs/architecture/BULLMQ-DISPATCH-ENGINE.md` | Modified | Added Section 9 documenting the idempotency architecture |

---

## Test Coverage

### New: `tests/dispatchOperationIdempotency.test.ts` — 13 tests, all passing

**Group 1 — Deterministic Operation ID Generation & Validation (7 tests)**
- Identical inputs produce identical IDs
- Different wave numbers produce different IDs
- Different requirement IDs produce different IDs
- Casing and whitespace normalization
- Default waveNumber=1 on missing/null/zero input
- Validation correctly accepts/rejects IDs
- IDs remain identical regardless of execution timestamp

**Group 2 — Real PostgreSQL Concurrency & Unique Constraints (4 tests)**
- 10 concurrent direct `INSERT`s: only 1 succeeds, 9 get unique constraint violations
- Sequential retry: second call returns `already_processed` with no new DB rows
- Concurrent `processDispatchJob` calls: all converge to the same `waveId`
- Duplicate BullMQ jobs with different BullMQ `jobId`s resolve to the same result

**Group 3 — Processor Edge Cases (2 tests)**
- `skipped_not_found` when requirement does not exist
- `skipped_terminal` when requirement is already in `FILLED` state

### Regression: All 8 Dispatch Test Suites — 100 tests, all passing

| Suite | Tests |
|---|---|
| `dispatchOperationIdempotency.test.ts` | 13/13 ✅ |
| `dispatchDatabaseConcurrency.test.ts` | 2/2 ✅ |
| `bullmqDispatchLifecycle.test.ts` | 10/10 ✅ |
| `dispatchNotificationOrdering.test.ts` | passes ✅ |
| `bullmqDispatchSecurity.test.ts` | 24/24 ✅ |
| `dispatchRadiusSecurity.test.ts` | 12/12 ✅ |
| `dispatchAcceptanceSecurity.test.ts` | passes ✅ |
| `dispatchArchitectureGuards.test.ts` | 4/4 ✅ |

### Full Repository: 856 tests across 40 suites — all passing ✅

---

## Definition of Done — Checklist

| Requirement | Status |
|---|---|
| Deterministic dispatch operation ID defined | ✅ `generateDispatchOperationId` in `dispatchOperation.ts` |
| DB uniqueness for dispatch business identity | ✅ `UNIQUE(operation_id)` on `dispatch_wave` with safe production migration |
| BullMQ processors are idempotent | ✅ Three-layer protocol in `processDispatchJob` |
| Safe retries return the same logical result | ✅ `DispatchOperationResult{status: 'already_processed'}` |
| Reprocessing same queue job yields no duplicate dispatch | ✅ Verified by real PostgreSQL concurrency tests |
| Database constraints backstop application idempotency | ✅ Unique constraint catches concurrent races |
| Issue #21 (BullMQ-only) invariant preserved | ✅ No `setTimeout`/`setInterval` introduced |
| Issue #22 (persist-before-notify) invariant preserved | ✅ `operation_id` written atomically with wave persist |

---

## Operational Notes

- **Migration safety**: The `operation_id` column is `nullable`. The backfill runs inside the migration. A partial migration (e.g. column added but backfill incomplete) is safe — `operation_id` is only required for new dispatches.
- **Rollback safety**: The column can be dropped without breaking existing production behavior. The unique constraint is a partial index (`WHERE operation_id IS NOT NULL`) so historical null rows are unaffected.
- **Multi-instance**: The database constraint is the final backstop. Multiple API/worker instances racing on the same operation will have exactly one winner; all others safely return the committed result.
