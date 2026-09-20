# Issue 16 — Booking State Machine Remediation

Priority: P1  
Category: Marketplace Correctness  
Original Audit Mapping: Audit #30, #32–34  
Roadmap Phase: B — Marketplace Correctness  

---

## 1. Problem Statement & Root Cause

Prior to this remediation, `src/features/booking/bookingServices.ts` had a critical defect in `completeBooking()`:
1. When an assigned worker called `completeBooking()`, the booking was transitioned directly from `IN_PROGRESS` to `COMPLETED`:
   ```ts
   // Former vulnerable implementation in bookingServices.ts:
   await tx.booking.update({
     where: { id: bookingId },
     data: { status: "COMPLETED" }
   });
   ```
2. A separate customer confirmation endpoint `confirmComplete()` existed, but it did not transition status; it merely checked if `booking.status === "COMPLETED"` before recording an optional review.
3. This produced contradictory lifecycle semantics: a worker could unilaterally mark a booking `COMPLETED`, completely bypassing customer review and confirmation of work quality.
4. Transitions were scattered with raw `tx.booking.update({ data: { status: ... } })` calls in multiple methods, without a centralized transition table, row locking, or durable transition audit history.

---

## 2. Existing Architecture & Investigated Modules

The following files and components were comprehensively audited:
- **`prisma/schema.prisma`**: Model `booking` lacked lifecycle tracking timestamps (`started_at`, `completion_requested_at`, `completed_at`, `cancelled_at`, `cancelled_by`, `cancellation_reason`, `confirmed_by`), lacked a status index, and had no transition audit table.
- **`src/features/booking/bookingServices.ts`**: Ad-hoc `tx.booking.update` statements for OTP verification, completion, and cancellation.
- **`src/features/booking/bookingController.ts`**: Controller catching generic errors without domain state machine mappings.
- **`src/policies/booking.policy.ts`**: Authorization policy enforcing customer ownership, worker assignment, and participant cancellation.
- **`src/features/jobs/requirementStateMachine.ts`**: Authoritative capacity model calculating filled worker slots based on `ACTIVE_BOOKING_STATUSES`.
- **`src/features/payment/paymentServices.ts`**: `PAYABLE_BOOKING_STATUSES` regulating payment order creation.
- **`src/features/review/reviewServices.ts`**: Review creation strictly restricted to `COMPLETED` bookings.
- **`src/features/dispatch/dispatchServices.ts`**: Initial booking creation upon dispatch acceptance.

---

## 3. Final State Machine

The authoritative booking state machine enforces the canonical lifecycle:

```
                  [dispatchServices.acceptDispatch]
                                  │
                                  ▼
                            ┌───────────┐
                            │ CONFIRMED │
                            └─────┬─────┘
                                  │
                  (START_WORK: assigned worker verifies OTP)
                                  │
                                  ▼
                           ┌─────────────┐
                           │ IN_PROGRESS │
                           └──────┬──────┘
                                  │
              (REQUEST_COMPLETION: worker marks work complete)
                                  │
                                  ▼
                     ┌───────────────────────┐
                     │ AWAITING_CONFIRMATION │
                     └───────────┬───────────┘
                                  │
              (CONFIRM_COMPLETION: customer confirms completion)
                                  │
                                  ▼
                            ┌───────────┐
                            │ COMPLETED │  ◄── [Terminal State / Reviews Permitted]
                            └───────────┘

           Cancellation Paths (Active Non-Terminal States):
           ┌───────────┐
           │ CONFIRMED │────────┐
           └───────────┘        │
           ┌─────────────┐      │ (CANCEL: Authorized Actor)
           │ IN_PROGRESS │──────┼────────────────────────────► ┌───────────┐
           └─────────────┘      │                              │ CANCELLED │
           ┌───────────────────┐│                              └───────────┘
           │ AWAITING_CONFIRM. │┘                       [Terminal State]
           └───────────────────┘
```

---

## 4. Transition Matrix

| Source State | Action | Target State | Authorized Actor | Preconditions / Guards | Side Effects |
|---|---|---|---|---|---|
| `CONFIRMED` | `START_WORK` | `IN_PROGRESS` | `WORKER`, `ADMIN`, `SYSTEM` | Worker must match `booking.worker_id`; valid OTP verified | Sets `started_at`, `otp_verified = true`; transitions parent job to `IN_PROGRESS`; writes audit record |
| `CONFIRMED` | `CANCEL` | `CANCELLED` | `CUSTOMER`, `WORKER`, `ADMIN`, `SYSTEM` | Must be authorized participant | Sets `cancelled_at`, `cancelled_by`, `cancellation_reason`; reconciles requirement capacity; reopens dispatch if parent job active |
| `IN_PROGRESS` | `REQUEST_COMPLETION` | `AWAITING_CONFIRMATION` | `WORKER`, `ADMIN`, `SYSTEM` | Worker must match `booking.worker_id` | Sets `completion_requested_at`; writes audit record; notifies customer |
| `IN_PROGRESS` | `CANCEL` | `CANCELLED` | `ADMIN`, `SYSTEM`, `CUSTOMER`, `WORKER` | Authorized participant under cancellation policy | Sets `cancelled_at`, `cancelled_by`; reconciles requirement capacity |
| `AWAITING_CONFIRMATION` | `CONFIRM_COMPLETION` | `COMPLETED` | `CUSTOMER`, `ADMIN`, `SYSTEM` | Customer must match `booking.customer_id` | Sets `completed_at`, `confirmed_by`; enables review submission; auto-completes parent job if all bookings complete |
| `AWAITING_CONFIRMATION` | `CANCEL` | `CANCELLED` | `CUSTOMER`, `ADMIN`, `SYSTEM` | Customer owner or admin/system | Sets `cancelled_at`, `cancelled_by`; reconciles requirement capacity |
| `COMPLETED` | *Any* | — | None | Terminal State | All transitions strictly rejected |
| `CANCELLED` | *Any* | — | None | Terminal State | All transitions strictly rejected |

---

## 5. Concurrency Model

Race conditions and concurrent mutations are prevented using multiple layers of defense:
1. **Row-Level Locking (`SELECT ... FOR UPDATE`)**:
   In PostgreSQL, the transition method acquires an exclusive row lock on the target booking:
   ```sql
   SELECT id, status, customer_id, worker_id, job_id, requirement_id
   FROM "booking"
   WHERE id = $1::uuid
   FOR UPDATE;
   ```
   Concurrent transactions targeting the same booking serialize at the database level.
2. **Atomic Compare-And-Swap (CAS)**:
   The latest committed status read under the row lock is validated against the transition rule table. If an `expectedCurrentStatus` is specified and does not match, a `BookingStateConflictError` (HTTP 409) is thrown.
3. **Idempotent Repeated Actions**:
   - Repeated customer confirmation on an already `COMPLETED` booking returns idempotent success without duplicate reviews, duplicate status updates, or duplicate outbox/audit records.
   - Repeated worker completion on an already `AWAITING_CONFIRMATION` booking returns idempotent success.
4. **Single-Winner Race Resolution**:
   - Simultaneous worker completion requests: exactly one executes the update; the second resolves idempotently.
   - Simultaneous customer confirmations: exactly one marks `COMPLETED`; the second resolves idempotently.
   - Cancellation vs Completion: the first to acquire the lock commits; the subsequent transition is rejected because terminal states forbid further transitions.

---

## 6. Database Schema & Migration Changes

1. **Prisma Schema (`prisma/schema.prisma`)**:
   - Added lifecycle tracking columns to `model booking`:
     - `started_at`: `DateTime? @db.Timestamptz(6)`
     - `completion_requested_at`: `DateTime? @db.Timestamptz(6)`
     - `completed_at`: `DateTime? @db.Timestamptz(6)`
     - `cancelled_at`: `DateTime? @db.Timestamptz(6)`
     - `cancelled_by`: `String? @db.VarChar(100)`
     - `cancellation_reason`: `String? @db.Text`
     - `confirmed_by`: `String? @db.VarChar(100)`
   - Added index on booking status: `@@index([status], map: "idx_booking_status")`
   - Added relation: `booking_transition booking_transition[]`
   - Created `model booking_transition` audit table:
     - `id`: `UUID @id @default(gen_random_uuid())`
     - `booking_id`: `UUID` (Foreign key to `booking.id` with `onDelete: Cascade`)
     - `from_status`: `VarChar(30)`
     - `to_status`: `VarChar(30)`
     - `action`: `VarChar(50)`
     - `actor_type`: `VarChar(30)`
     - `actor_id`: `VarChar(100)?`
     - `reason`: `Text?`
     - `metadata`: `Json?`
     - `created_at`: `Timestamptz(6) @default(now())`
     - Index: `@@index([booking_id, created_at], map: "idx_booking_transition_booking_id")`
2. **Migration (`prisma/migrations/20260920040000_booking_state_machine/migration.sql`)**:
   - Automatically canonicalizes legacy status values: `UPDATE "booking" SET "status" = 'CONFIRMED' WHERE "status" = 'confirmed';`
   - Adds lifecycle columns and status index.
   - Creates `booking_transition` table and indexes with idempotent DDL (`IF NOT EXISTS`).

---

## 7. Downstream Cross-Feature Integrations

1. **Requirement State Machine Capacity (`requirementStateMachine.ts`)**:
   - Added `"AWAITING_CONFIRMATION"` to `ACTIVE_BOOKING_STATUSES`:
     ```ts
     export const ACTIVE_BOOKING_STATUSES: ReadonlySet<string> = new Set([
       "confirmed",
       "CONFIRMED",
       "IN_PROGRESS",
       "AWAITING_CONFIRMATION",
       "COMPLETED",
     ]);
     ```
   - Prevents premature release of requirement worker capacity slots while customer confirmation is pending.
2. **Payment Lifecycle (`paymentServices.ts`)**:
   - Added canonical `"CONFIRMED"` to `PAYABLE_BOOKING_STATUSES`.
3. **Review Creation (`reviewServices.ts`)**:
   - Enforces that reviews can only be submitted for `COMPLETED` bookings.
   - In `confirmComplete()`, reviews are recorded seamlessly when transitioning from `AWAITING_CONFIRMATION` to `COMPLETED` or during idempotent retries.
4. **DTO Boundary Protection (`prismaSelects.ts`)**:
   - Exposed lifecycle timestamps (`started_at`, `completion_requested_at`, `completed_at`, `cancelled_at`, `cancelled_by`, `cancellation_reason`, `confirmed_by`) in `BookingSafeDTO` and `bookingSafeSelect`.
5. **Elimination of Bypass Paths**:
   - Repository-wide grep audit confirmed that zero ad-hoc `booking.update` or `booking.updateMany` calls exist outside of `bookingStateService.transition()`.

---

## 8. Verification & Validation Summary

- **Unit & Concurrency Suite (`tests/bookingStateMachine.test.ts`)**: 27 tests passing.
  - Covers all 5 canonical states, terminal states, and legacy casing normalization.
  - Covers all legal transitions with timestamp and audit verification.
  - Regression test proving worker `completeBooking()` produces `AWAITING_CONFIRMATION`, not `COMPLETED`.
  - Rejection of illegal transitions (`IN_PROGRESS -> COMPLETED`, `CANCELLED -> START_WORK`, etc.).
  - Actor authorization checks (unassigned worker, non-owning customer).
  - Concurrency simulation across Races A, B, C, D, and E.
  - HTTP endpoint integration tests (`/complete`, `/confirm-complete`, `/cancel`).
- **Regression Suites Verified**:
  - `tests/reviewSecurity.test.ts`: 35/35 tests passing.
  - `tests/bookingPaymentSecurity.test.ts`: 24/24 tests passing.
  - `tests/dispatchAcceptanceSecurity.test.ts`: 17/17 tests passing.
  - `tests/jobStateMachine.test.ts`: 23/23 tests passing.
  - `tests/requirementStateMachine.test.ts`: 16/16 tests passing.
- **Typecheck (`npx tsc --noEmit`)**: 0 errors.
- **Prisma Validation (`npx prisma validate`)**: Valid.
