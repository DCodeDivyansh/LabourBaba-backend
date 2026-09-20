# LabourBaba Job State Machine Architecture Specification
## Issue #14: Define and Enforce Job State Machine

---

### 1. Purpose & Overview

In high-throughput marketplace operations, inconsistent or ad-hoc state mutations lead to double bookings, lost dispatch waves, orphaned workers, and conflicting cancellations. 

The **LabourBaba Job State Machine** is the single, authoritative, and transactionally enforced lifecycle mechanism for all Jobs in the backend. 

Key invariants guaranteed:
1. **Zero Direct Mutations**: No controller, background worker, or service can bypass the state machine to mutate `job.status`.
2. **Explicit Legal Transitions**: All lifecycle state changes are evaluated against a formal transition table.
3. **Actor Authorization & Ownership**: Every transition validates the actor role and verifies customer ownership.
4. **Transactional Atomicity & CAS**: Status updates, lifecycle timestamps, and durable audit history (`job_transition`) commit atomically within the same database transaction.
5. **Stable Domain Errors**: Illegal transitions, concurrency conflicts, and permission violations return typed, predictable domain errors.

---

### 2. State Definitions

The Job lifecycle consists of 6 canonical states:

| State | Lifecycle Phase | Terminal? | Business Meaning |
|---|---|---|---|
| `OPEN` | Initial | No | Job has been created by a customer with initial requirements. Awaiting dispatch discovery. |
| `DISPATCHING` | Active | No | System is actively running PostGIS radius waves and notifying eligible candidate workers. |
| `BOOKED` | Active | No | All requirement slots for the job are filled and confirmed with active worker bookings. |
| `IN_PROGRESS` | Active | No | At least one worker has verified their start OTP on-site and commenced work. |
| `COMPLETED` | Terminal | Yes | Work has concluded for all requirements, confirmed by customer/admin. |
| `CANCELLED` | Terminal | Yes | Job was cancelled prior to completion by customer owner or admin. All unfilled requirements and pending dispatches are inactivated. |

---

### 3. Transition Matrix & Business Guards

```
              ┌─────────────────────────────────────────────────────────┐
              │                        [CREATE]                         │
              │                            ▼                            │
              │                         +------+                        │
              │                         | OPEN |                        │
              │                         +---+--+                        │
              │                             |                           │
              │             [START_DISPATCH]│ [CANCEL]                  │
              │                             ▼   │                       │
              │                    +-------------+                      │
              │    ┌──────────────►| DISPATCHING |─────────┐            │
              │    │               +------+------+         │            │
              │    │                      |                │            │
              │    │ [REOPEN_DISPATCH]    │ [MARK_BOOKED]  │            │
              │    │                      ▼                │ [CANCEL]   │
              │    │                  +--------+           │            │
              │    └──────────────────| BOOKED |───────────┤            │
              │                       +---+----+           │            │
              │                           |                │            │
              │               [START_WORK]│                │            │
              │                           ▼                │            │
              │                    +-------------+         │            │
              │                    | IN_PROGRESS |         │            │
              │                    +------+------+         │            │
              │                           |                │            │
              │                 [COMPLETE]│                ▼            │
              │                           ▼          +-----------+      │
              │                     +-----------+    | CANCELLED |      │
              │                     | COMPLETED |    +-----------+      │
              │                     +-----------+    (Terminal)         │
              │                      (Terminal)                         │
              └─────────────────────────────────────────────────────────┘
```

| Source State | Action | Target State | Authorized Actors | Ownership Guard | Side Effects & Invariants |
|---|---|---|---|---|---|
| *None* | `CREATE` | `OPEN` | `CUSTOMER`, `ADMIN`, `SYSTEM` | Authenticated principal is owner | Creates initial requirements; records `job_transition` |
| `OPEN` | `START_DISPATCH` | `DISPATCHING` | `SYSTEM`, `DISPATCH_WORKER`, `ADMIN` | None | Initiates PostGIS worker discovery waves |
| `OPEN` | `CANCEL` | `CANCELLED` | `CUSTOMER`, `ADMIN`, `SYSTEM` | Customer must own job | Cancels unfilled requirements; sets `cancelled_at`, `cancelled_by` |
| `DISPATCHING` | `MARK_BOOKED` | `BOOKED` | `SYSTEM`, `DISPATCH_WORKER`, `WORKER` | None | Expires remaining dispatches; sets `dispatch_status: fully_booked` |
| `DISPATCHING` | `START_WORK` | `IN_PROGRESS` | `WORKER`, `SYSTEM`, `ADMIN` | Worker must have valid booking | Sets `started_at`; worker verified OTP |
| `DISPATCHING` | `CANCEL` | `CANCELLED` | `CUSTOMER`, `ADMIN`, `SYSTEM` | Customer must own job | Inactivates pending dispatches & open requirements |
| `BOOKED` | `START_WORK` | `IN_PROGRESS` | `WORKER`, `SYSTEM`, `ADMIN` | Worker must have valid booking | Sets `started_at`; worker verified OTP |
| `BOOKED` | `REOPEN_DISPATCH` | `DISPATCHING` | `SYSTEM`, `ADMIN` | None | Triggered when a booking is cancelled and slot is underfilled |
| `BOOKED` | `COMPLETE` | `COMPLETED` | `CUSTOMER`, `ADMIN`, `SYSTEM` | Customer must own job | Sets `completed_at` |
| `BOOKED` | `CANCEL` | `CANCELLED` | `CUSTOMER`, `ADMIN`, `SYSTEM` | Customer must own job | Inactivates open slots |
| `IN_PROGRESS` | `COMPLETE` | `COMPLETED` | `CUSTOMER`, `ADMIN`, `SYSTEM` | Customer must own job | Sets `completed_at` |
| `IN_PROGRESS` | `CANCEL` | `CANCELLED` | `ADMIN`, `SYSTEM` | Privileged admin only | In-progress jobs require admin intervention to cancel |
| `COMPLETED` | *None* | *None* | *None* | N/A | Terminal state — all actions rejected with `JOB_INVALID_TRANSITION` |
| `CANCELLED` | *None* | *None* | *None* | N/A | Terminal state — all actions rejected with `JOB_INVALID_TRANSITION` |

---

### 4. Database Schema & Migration

#### 4.1. `job` Table Extensions
- `updated_at`: `TIMESTAMPTZ(6)` tracking last state change.
- `cancelled_at`: `TIMESTAMPTZ(6)` timestamp when cancelled.
- `cancelled_by`: `VARCHAR(100)` ID or role of actor who cancelled.
- `completed_at`: `TIMESTAMPTZ(6)` timestamp when completed.
- Index: `idx_job_status_customer` on `("status", "customer_id")`.

#### 4.2. `job_transition` Audit Table
```sql
CREATE TABLE IF NOT EXISTS "job_transition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" UUID NOT NULL,
    "from_status" VARCHAR(30) NOT NULL,
    "to_status" VARCHAR(30) NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "actor_type" VARCHAR(30) NOT NULL,
    "actor_id" VARCHAR(100),
    "reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "job_transition_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_transition_job" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_job_transition_job_id" ON "job_transition"("job_id", "created_at");
```

---

### 5. Domain Error Architecture

| Error Class | HTTP Status | Error Code | Description |
|---|---|---|---|
| `JobNotFoundError` | 404 | `JOB_NOT_FOUND` | Job ID does not exist in the database |
| `JobInvalidTransitionError` | 400 | `JOB_INVALID_TRANSITION` | Attempted action is not valid for current job status |
| `JobStateConflictError` | 409 | `JOB_STATE_CONFLICT` | Job status changed concurrently (CAS mismatch) |
| `JobAuthorizationError` | 403 | `JOB_FORBIDDEN` | Caller role or identity is not authorized for this transition |
