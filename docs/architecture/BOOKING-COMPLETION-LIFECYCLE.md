# Booking Completion Lifecycle Architecture

## Overview
This document defines the authoritative booking completion and customer confirmation lifecycle in the LabourBaba platform.

---

## 1. Core Lifecycle Invariant

**WORKER ACTION $\neq$ FINAL COMPLETION.**

A worker can indicate that physical work is complete, but cannot unilaterally finalize a booking. Customer confirmation is required to authoritatively transition the booking to `COMPLETED`.

```
CONFIRMED
    │
    │  (START_WORK: assigned worker verifies OTP)
    ▼
IN_PROGRESS
    │
    │  (REQUEST_COMPLETION: assigned worker marks work completed)
    ▼
AWAITING_CONFIRMATION
    │
    │  (CONFIRM_COMPLETION: authenticated owning customer confirms)
    ▼
COMPLETED  ◄─── [Terminal Reviewable State]
```

### Transition Specifications

| Source State | Action | Target State | Authorized Actor | Preconditions & Invariants | Side Effects |
|---|---|---|---|---|---|
| `IN_PROGRESS` | `REQUEST_COMPLETION` | `AWAITING_CONFIRMATION` | Assigned `WORKER`, `ADMIN`, `SYSTEM` | Authenticated worker matches `booking.worker_id` | Sets `completion_requested_at = now()` |
| `AWAITING_CONFIRMATION` | `CONFIRM_COMPLETION` | `COMPLETED` | Owning `CUSTOMER`, `ADMIN`, `SYSTEM` | Authenticated customer matches `booking.customer_id` | Sets `completed_at = now()`, `confirmed_at = now()`, `confirmed_by = actor.id`; reviews eligible; cascades job completion |
| `COMPLETED` | `CONFIRM_COMPLETION` | `COMPLETED` | Owning `CUSTOMER`, `ADMIN`, `SYSTEM` | Authenticated customer matches `booking.customer_id` | **Idempotent No-Op**: Preserves existing `confirmed_at` and `confirmed_by` |

---

## 2. Review Eligibility

- Reviews are **strictly prohibited** in all non-`COMPLETED` states (`CONFIRMED`, `IN_PROGRESS`, `AWAITING_CONFIRMATION`, `CANCELLED`).
- Calling `POST /api/reviews/:bookingId` on a booking in `AWAITING_CONFIRMATION` is rejected with `HTTP 409 Conflict` (`BOOKING_NOT_COMPLETED`).
- Optional reviews submitted inline during `POST /api/bookings/:bookingId/confirm-complete` are created atomically inside the transaction **only after** the transition to `COMPLETED` has succeeded.
- Exactly one review per booking is enforced both by application-level deduplication and the database constraint `uniq_review_booking`.

---

## 3. Concurrency & Atomicity

- All transitions execute within `prisma.$transaction`.
- Employs PostgreSQL row-level exclusive locks (`SELECT ... FOR UPDATE`).
- Two concurrent customer confirmation requests (e.g. mobile double-tap or network retry) serialize on the row lock:
  - First request transitions `AWAITING_CONFIRMATION` $\to$ `COMPLETED` and stamps `confirmed_at`.
  - Second request re-reads the committed row, detects status `COMPLETED`, evaluates idempotency, and safely returns success without duplicate side effects or timestamp corruption.

---

## 4. DTO & Information Safety

- `bookingSafeSelect` exposes:
  - `status`
  - `started_at`
  - `completion_requested_at`
  - `completed_at`
  - `confirmed_at`
  - `confirmed_by`
- Strictly excludes sensitive authentication/crypto fields: `otp_hash`, `otp_attempts`, `otp_locked_at`, `otp_consumed_at`.
