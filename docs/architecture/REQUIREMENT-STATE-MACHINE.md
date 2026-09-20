# Requirement State Machine & Authoritative Worker Capacity Model

## 1. Executive Summary & Purpose

A `Requirement` (persisted in table `job_requirement`) represents the customer's demand for a specific worker skill on a Job.

Prior to Issue #15 remediation, requirement worker counts and statuses had multiple competing representations across the codebase, with mutable counters, missing database constraints, and potential configuration defaults obscuring true business demand.

Issue #15 establishes:
1. **Authoritative Demand**: `worker_count_needed` is persisted as a strict, non-null positive integer ($\ge 1$) backed by PostgreSQL CHECK constraints.
2. **Authoritative Capacity Model**: `filled_capacity` is derived directly from active bookings, and `remaining_capacity = worker_count_needed - filled_capacity`.
3. **Formal Requirement State Machine**: Explicit lifecycle states (`OPEN`, `DISPATCHING`, `PARTIALLY_FILLED`, `FILLED`, `NO_WORKERS_AVAILABLE`, `CANCELLED`) enforced through a centralized domain service.
4. **Concurrency Safety**: Worker acceptance uses PostgreSQL row-level locks (`SELECT ... FOR UPDATE`) to prevent race conditions and overbooking.
5. **Durable Slot Release**: Booking cancellation transactionally reconciles requirement capacity and transitions status back from `FILLED` to `PARTIALLY_FILLED` or `OPEN`.

---

## 2. Requirement Lifecycle States

| State | Meaning | Capacity Invariant |
|---|---|---|
| `OPEN` | Requirement created, ready for dispatch. | `filled_capacity = 0`, `remaining_capacity = worker_count_needed` |
| `DISPATCHING` | Active wave search / notifications in flight. | `filled_capacity < worker_count_needed` |
| `PARTIALLY_FILLED` | At least one worker booked, but more needed. | `0 < filled_capacity < worker_count_needed` |
| `FILLED` | All required worker slots booked. | `filled_capacity = worker_count_needed`, `remaining = 0` |
| `NO_WORKERS_AVAILABLE` | Dispatch waves exhausted without filling remaining slots. | `filled_capacity < worker_count_needed` |
| `CANCELLED` | Terminal cancellation (explicit or cascaded from Job). | Terminal |

---

## 3. Authoritative Transition Table

```
                  ┌───────────────┐
                  │     OPEN      │
                  └───────┬───────┘
                          │ START_DISPATCH
                          ▼
                  ┌───────────────┐
                  │  DISPATCHING  │
                  └───────┬───────┘
                          │
              ┌───────────┴───────────┐
              │ RECORD_ACCEPTANCE     │ RECORD_ACCEPTANCE (last slot)
              ▼                       ▼
     ┌─────────────────┐     ┌─────────────────┐
     │PARTIALLY_FILLED │     │     FILLED      │
     └────────┬────────┘     └────────┬────────┘
              │                       │
              │ START_DISPATCH        │ RELEASE_SLOT (booking cancel)
              ▼                       ▼
       ┌───────────────┐     ┌─────────────────┐
       │  DISPATCHING  │     │PARTIALLY_FILLED │
       └───────┬───────┘     └─────────────────┘
               │ EXHAUST_DISPATCH
               ▼
        ┌──────────────────────┐
        │ NO_WORKERS_AVAILABLE │
        └──────────────────────┘
```

| Source State | Action | Target State | Permitted Roles | Guards & Side Effects |
|---|---|---|---|---|
| `OPEN` | `START_DISPATCH` | `DISPATCHING` | ADMIN, SYSTEM, DISPATCH_WORKER | Coordinates validated. |
| `OPEN` | `RECORD_ACCEPTANCE` | `PARTIALLY_FILLED` / `FILLED` | ADMIN, SYSTEM, WORKER | Slot allocated, atomic CAS check. |
| `OPEN` | `CANCEL` | `CANCELLED` | CUSTOMER (owner), ADMIN, SYSTEM | Cancels open requirement. |
| `DISPATCHING` | `RECORD_ACCEPTANCE` | `PARTIALLY_FILLED` / `FILLED` | ADMIN, SYSTEM, WORKER | If last slot filled, expires remaining dispatches. |
| `DISPATCHING` | `EXHAUST_DISPATCH` | `NO_WORKERS_AVAILABLE` / `PARTIALLY_FILLED` | ADMIN, SYSTEM, DISPATCH_WORKER | Sets NO_WORKERS_AVAILABLE if filled=0, else PARTIALLY_FILLED. |
| `DISPATCHING` | `CANCEL` | `CANCELLED` | CUSTOMER (owner), ADMIN, SYSTEM | Cascades cancellation to pending dispatches. |
| `PARTIALLY_FILLED` | `START_DISPATCH` | `DISPATCHING` | ADMIN, SYSTEM, DISPATCH_WORKER | Re-triggers dispatch for remaining slots. |
| `PARTIALLY_FILLED` | `RECORD_ACCEPTANCE` | `PARTIALLY_FILLED` / `FILLED` | ADMIN, SYSTEM, WORKER | Allocates next available slot. |
| `PARTIALLY_FILLED` | `RELEASE_SLOT` | `OPEN` / `PARTIALLY_FILLED` | CUSTOMER, ADMIN, SYSTEM, WORKER | Triggered by booking cancellation; reconciles capacity. |
| `PARTIALLY_FILLED` | `CANCEL` | `CANCELLED` | CUSTOMER (owner), ADMIN, SYSTEM | Cancels unfilled portion. |
| `FILLED` | `RELEASE_SLOT` | `PARTIALLY_FILLED` / `OPEN` | CUSTOMER, ADMIN, SYSTEM, WORKER | Releases slot upon booking cancellation. |
| `FILLED` | `CANCEL` | `CANCELLED` | CUSTOMER (owner), ADMIN, SYSTEM | Terminal cancel. |
| `NO_WORKERS_AVAILABLE` | `START_DISPATCH` | `DISPATCHING` | CUSTOMER (owner), ADMIN, SYSTEM | Retries dispatch for unfilled demand. |
| `NO_WORKERS_AVAILABLE` | `CANCEL` | `CANCELLED` | CUSTOMER (owner), ADMIN, SYSTEM | Cancels requirement. |

---

## 4. Authoritative Capacity Model & Invariants

### Formulas:
$$\text{filled\_capacity} = \text{COUNT}(\text{bookings where status} \in \{\text{'confirmed'}, \text{'IN\_PROGRESS'}, \text{'COMPLETED'}\})$$
$$\text{remaining\_capacity} = \max(0, \text{worker\_count\_needed} - \text{filled\_capacity})$$

### Invariants:
1. $0 \le \text{filled\_capacity} \le \text{worker\_count\_needed}$
2. $0 \le \text{remaining\_capacity} \le \text{worker\_count\_needed}$
3. $\text{worker\_count\_needed} \ge 1$ (enforced by DB check constraint `chk_job_requirement_worker_count_needed`)
4. $\text{worker\_count\_filled} \ge 0$ (enforced by DB check constraint `chk_job_requirement_worker_count_filled`)
5. Updating demand cannot set $\text{new\_worker\_count\_needed} < \text{filled\_capacity}$.

---

## 5. Concurrency & Overbooking Protection

When workers accept dispatch notifications concurrently:
1. `acceptDispatch` enters a PostgreSQL transaction.
2. Acquires row lock: `SELECT id FROM job_requirement WHERE id = $id FOR UPDATE`.
3. Verifies `worker_count_filled < worker_count_needed` and `status != 'FILLED'`. If full, throws `409 SLOTS_FULL`.
4. Executes conditional dispatch update (`UPDATE job_dispatch WHERE ... status = 'pending'`).
5. Creates unique `booking` record.
6. Increments `worker_count_filled` and transitions requirement status via `requirementStateService.transition(...)`.
7. When the last slot is filled (`nowFilled = true`), expires all remaining pending dispatches atomically.

---

## 6. Database Constraints & Schema

```sql
-- Check constraints
ALTER TABLE "job_requirement"
  ADD CONSTRAINT "chk_job_requirement_worker_count_needed"
  CHECK ("worker_count_needed" > 0);

ALTER TABLE "job_requirement"
  ADD CONSTRAINT "chk_job_requirement_worker_count_filled"
  CHECK ("worker_count_filled" >= 0);

-- Status indexing
CREATE INDEX IF NOT EXISTS "idx_requirement_status" ON "job_requirement"("status");
```
