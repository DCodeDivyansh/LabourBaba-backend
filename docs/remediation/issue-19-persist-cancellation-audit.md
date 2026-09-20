# Remediation Report: Issue #19 — Persist Cancellation Audit Data

## Metadata
- **Issue**: Issue #19 — Persist cancellation audit data
- **Priority**: P1 Marketplace Correctness
- **Audit Findings**: Audit #34
- **Roadmap Phase**: Phase B — Marketplace Correctness
- **Status**: Fully Remediated & Verified (100% Green, 34 test suites, 803 tests passing)

---

## 1. Problem Statement & Root Cause Analysis

Prior to remediation:
1. `cancelBooking()` was treated as an arbitrary string status mutation on `booking.status`.
2. Crucial business metadata was dropped: who cancelled the booking (`cancelled_by`), when it happened (`cancelled_at`), and the validated operational reason (`cancellation_reason`).
3. Client payloads could potentially inject identity or timestamp attributes or provide empty/whitespace cancellation reasons.
4. Downstream requirement capacity and worker dispatch records were at risk of getting desynchronized or corrupted upon cancellation.
5. In the database, records in `status = 'CANCELLED'` had no constraint preventing `NULL` values in audit columns.

---

## 2. Technical Architecture of the Remediation

### 2.1 Database Check Constraint & Migration
- Created migration [`20260920070000_booking_cancellation_audit`](file:///e:/LabourBaba/LabourBaba-backend/prisma/migrations/20260920070000_booking_cancellation_audit/migration.sql).
- Backfills any legacy cancelled records with deterministic fallback values (`cancelled_at = updated_at`, `cancelled_by = 'SYSTEM_BACKFILL'`, `cancellation_reason = 'Cancelled prior to audit tracking'`).
- Enforces database-level check constraint `chk_booking_cancellation_audit`:
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

### 2.2 Strict Request Schema & Identity Attestation
- Updated [`CancelBookingReqSchema`](file:///e:/LabourBaba/LabourBaba-backend/src/schemas/index.ts):
  - Validates `reason: z.string().trim().min(1, "Cancellation reason is required and cannot be empty").max(500, "Cancellation reason cannot exceed 500 characters")`.
  - `.strict()` prevents client injection of spoofed `cancelled_by`, `cancelled_at`, or status fields.
- `cancelled_by` is authoritatively derived strictly from the authenticated JWT principal (`actor.id`).

### 2.3 State Machine Transition Contract
- In [`bookingStateMachine.ts`](file:///e:/LabourBaba/LabourBaba-backend/src/features/booking/bookingStateMachine.ts):
  - Cancellation is legally permitted from `CONFIRMED`, `IN_PROGRESS`, and `AWAITING_CONFIRMATION` (Customer/Admin only).
  - Assigned worker cannot cancel once work has been submitted in `AWAITING_CONFIRMATION`.
  - Terminal states (`COMPLETED`, `CANCELLED`) strictly reject cancellation attempts with `BookingInvalidTransitionError` (`HTTP 400`).
  - Stamped timestamps: `cancelled_at = now()`, `cancelled_by = actor.id`, `cancellation_reason = reason.trim()`.
  - Atomically records durable transition event in `booking_transition` table.

### 2.4 Transactional Side Effects & Capacity Reconciliation
- In [`bookingServices.ts`](file:///e:/LabourBaba/LabourBaba-backend/src/features/booking/bookingServices.ts):
  - Employs exclusive row locking (`SELECT ... FOR UPDATE`).
  - Calls `bookingPolicy.canCancel(actor, booking)` to enforce authorization boundaries.
  - Automatically reconciles requirement capacity via `requirementStateService.reconcileCapacity(tx, requirement_id)` to decrement filled slots and update requirement status (`FILLED` $\to$ `PARTIALLY_FILLED` or `OPEN`).
  - Reconciles worker dispatch record (`tx.job_dispatch.updateMany({ where: { status: { in: ['accepted', 'pending'] } }, data: { status: 'cancelled' } })`).
  - If no active bookings remain under the parent job, reopens parent job dispatch via `JobAction.REOPEN_DISPATCH`.

### 2.5 DTO Protection & Safe Exposure
- In [`prismaSelects.ts`](file:///e:/LabourBaba/LabourBaba-backend/src/shared/prismaSelects.ts), `toBookingDTO` safely exposes `cancelled_at`, `cancelled_by`, and `cancellation_reason` to authorized participants while strictly redacting sensitive secrets (`otp_hash`).

---

## 3. Verification & Test Suite

### Dedicated Test Suite: [`tests/bookingCancellationSecurity.test.ts`](file:///e:/LabourBaba/LabourBaba-backend/tests/bookingCancellationSecurity.test.ts)
21 exhaustive tests covering:
1. Customer cancellation on `CONFIRMED`, `IN_PROGRESS`, and `AWAITING_CONFIRMATION` bookings.
2. Worker cancellation on `CONFIRMED` and `IN_PROGRESS` bookings.
3. Worker cancellation forbidden on `AWAITING_CONFIRMATION` bookings.
4. Authorization guards: non-owner customer (403), unassigned worker (403), unauthenticated (401), admin override (200).
5. Terminal state guards: cannot cancel `COMPLETED` or `CANCELLED` bookings (400 `BOOKING_INVALID_TRANSITION`).
6. Reason validation: missing reason (400), empty string (400), whitespace-only (400), >500 characters (400).
7. Strict schema enforcement: extra payload keys rejected (400).
8. Parameter validation: malformed UUID rejected (400).
9. Side effect reconciliation: requirement capacity recalculated, worker dispatch marked `cancelled`.
10. DTO safety: cancellation audit fields included, `otp_hash` redacted.

### Global Test Suite Status
- **Test Suites**: 34 passed, 34 total (100% PASS)
- **Tests**: 803 passed, 803 total (100% PASS)
- **TypeScript Compilation**: 0 errors (`npm run build` succeeds).
