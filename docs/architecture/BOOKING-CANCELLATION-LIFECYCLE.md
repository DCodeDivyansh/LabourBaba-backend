# Booking Cancellation Lifecycle & Audit Data Architecture

## Overview
This document defines the authoritative booking cancellation lifecycle, validation rules, side-effect reconciliation, database invariants, and audit data persistence in the LabourBaba platform.

---

## 1. Core Principles

1. **Cancellation is a Business Event, Not a Mutable String Update**:
   - Every cancellation must atomically capture `cancelled_at`, `cancelled_by`, and `cancellation_reason`.
   - The database enforces this invariant via a check constraint: `chk_booking_cancellation_audit`.

2. **Source-of-Truth Identity Attribution**:
   - `cancelled_by` is authoritatively derived strictly from the authenticated JWT principal (`actor.id`).
   - Client requests attempting to inject `cancelled_by` or `cancelled_at` are rejected with `HTTP 400 Bad Request` via `.strict()` schema enforcement.

3. **Strict Transition Matrix**:
   - Cancellation is ONLY allowed from legal active states:
     - `CONFIRMED` $\to$ `CANCELLED` (Customer, Assigned Worker, Admin)
     - `IN_PROGRESS` $\to$ `CANCELLED` (Customer, Assigned Worker, Admin)
     - `AWAITING_CONFIRMATION` $\to$ `CANCELLED` (Customer, Admin)
   - Worker cannot cancel in `AWAITING_CONFIRMATION` (work has already been submitted).
   - Terminal states cannot be cancelled:
     - `COMPLETED` $\to$ `CANCELLED` is strictly forbidden (`HTTP 400 BOOKING_INVALID_TRANSITION`).
     - `CANCELLED` $\to$ `CANCELLED` is rejected as an illegal transition on a terminal state (`HTTP 400 BOOKING_INVALID_TRANSITION`).

---

## 2. Cancellation Transition Matrix

| Source State | Action | Target State | Authorized Actor | Preconditions & Invariants | Side Effects & Audit Stamping |
|---|---|---|---|---|---|
| `CONFIRMED` | `CANCEL` | `CANCELLED` | Owning `CUSTOMER`, Assigned `WORKER`, `ADMIN` | Participant authorized; Reason non-empty, trimmed (1-500 chars) | Atomically stamps `cancelled_at`, `cancelled_by`, `cancellation_reason`; creates `booking_transition`; reconciles capacity & dispatch |
| `IN_PROGRESS` | `CANCEL` | `CANCELLED` | Owning `CUSTOMER`, Assigned `WORKER`, `ADMIN` | Participant authorized; Reason non-empty, trimmed (1-500 chars) | Atomically stamps `cancelled_at`, `cancelled_by`, `cancellation_reason`; creates `booking_transition`; reconciles capacity & dispatch |
| `AWAITING_CONFIRMATION` | `CANCEL` | `CANCELLED` | Owning `CUSTOMER`, `ADMIN` | Participant authorized; Reason non-empty, trimmed (1-500 chars); **Worker Forbidden** | Atomically stamps `cancelled_at`, `cancelled_by`, `cancellation_reason`; creates `booking_transition`; reconciles capacity & dispatch |
| `COMPLETED` | `CANCEL` | *Illegal* | None | Terminal state | Throws `BookingInvalidTransitionError` (`HTTP 400`) |
| `CANCELLED` | `CANCEL` | *Illegal* | None | Terminal state | Throws `BookingInvalidTransitionError` (`HTTP 400`) |

---

## 3. Reason Validation Rules

- **Schema**: `CancelBookingReqSchema`
  - Field: `reason: z.string().trim().min(1, "Cancellation reason is required and cannot be empty").max(500, "Cancellation reason cannot exceed 500 characters")`
  - Strict mode: `.strict()` rejects unexpected keys.
- Whitespace-only reasons (e.g. `"   "`) are trimmed to `""` and rejected with `HTTP 400 Bad Request`.
- Empty string reasons are rejected with `HTTP 400 Bad Request`.
- Strings longer than 500 characters are rejected with `HTTP 400 Bad Request`.

---

## 4. Side Effects & Atomic Reconciliation

When a booking cancels, the following side effects are executed transactionally inside `prisma.$transaction`:

1. **Row-Level Lock**:
   - Acquires `SELECT ... FOR UPDATE` on the booking record to eliminate concurrent transition races.
2. **State Machine Execution**:
   - Updates `status = 'CANCELLED'`, `cancelled_at = now()`, `cancelled_by = actor.id`, `cancellation_reason = reason.trim()`.
3. **Durable Transition Audit Logging**:
   - Inserts record into `booking_transition` table capturing:
     - `booking_id`
     - `from_status`
     - `to_status` (`CANCELLED`)
     - `action` (`CANCEL`)
     - `actor_type` (`CUSTOMER`, `WORKER`, `ADMIN`)
     - `actor_id`
     - `reason`
     - `created_at`
4. **Authoritative Requirement Capacity Reconciliation**:
   - Calls `requirementStateService.reconcileCapacity(tx, booking.requirement_id)`.
   - Calculates filled slots strictly from remaining active bookings (`CONFIRMED`, `IN_PROGRESS`, `AWAITING_CONFIRMATION`, `COMPLETED`).
   - Automatically adjusts requirement status from `FILLED` $\to$ `PARTIALLY_FILLED` or `OPEN`.
5. **Dispatch Record Reconciliation**:
   - Updates matching worker's `job_dispatch` record (`status in ['accepted', 'pending']`) to `status = 'cancelled'`, setting `responded_at = now()`.
6. **Parent Job Dispatch Reopening**:
   - If no remaining active bookings exist for the job, transitions parent job via `JobAction.REOPEN_DISPATCH`.

---

## 5. Database-Level Check Constraint

Migration `20260920070000_booking_cancellation_audit` enforces the invariant at the PostgreSQL level:

```sql
ALTER TABLE "booking"
ADD CONSTRAINT "chk_booking_cancellation_audit"
CHECK (
  status != 'CANCELLED'
  OR (
    cancelled_at IS NOT NULL
    AND cancelled_by IS NOT NULL
    AND cancellation_reason IS NOT NULL
    AND length(trim(cancellation_reason)) > 0
  )
);
```

---

## 6. DTO & Information Safety

- `toBookingDTO(booking, actor)` safely exposes:
  - `cancelled_at: Date`
  - `cancelled_by: string`
  - `cancellation_reason: string`
- Sensitive secrets such as `otp_hash` are never exposed in the response payload.
