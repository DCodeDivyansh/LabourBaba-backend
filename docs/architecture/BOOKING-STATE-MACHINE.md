# Booking State Machine Architecture

## 1. Overview & Core Lifecycle

The Booking State Machine establishes an authoritative, transactional lifecycle for bookings within the LabourBaba backend.

```
       [Worker Accepts Dispatch]
                   │
                   ▼
             ┌───────────┐
             │ CONFIRMED │
             └─────┬─────┘
                   │  (START_WORK: OTP verified by assigned worker)
                   ▼
            ┌─────────────┐
            │ IN_PROGRESS │
            └──────┬──────┘
                   │  (REQUEST_COMPLETION: Assigned worker marks work complete)
                   ▼
      ┌───────────────────────┐
      │ AWAITING_CONFIRMATION │
      └────────────┬──────────┘
                   │  (CONFIRM_COMPLETION: Owning customer confirms completion)
                   ▼
             ┌───────────┐
             │ COMPLETED │ ◄── [Terminal: Reviews permitted]
             └───────────┘

Cancellation Paths (from active non-terminal states):
  CONFIRMED             ──(CANCEL)──► CANCELLED [Terminal]
  IN_PROGRESS           ──(CANCEL)──► CANCELLED [Terminal]
  AWAITING_CONFIRMATION ──(CANCEL)──► CANCELLED [Terminal]
```

---

## 2. Canonical States (`BookingStatus`)

1. **`CONFIRMED`**: Initial booking state upon dispatch acceptance. Worker is assigned, OTP hash generated, and work is pending start.
2. **`IN_PROGRESS`**: Assigned worker verified OTP and work is currently underway.
3. **`AWAITING_CONFIRMATION`**: Worker indicated work is finished. Customer must confirm before the booking reaches terminal completion.
4. **`COMPLETED`**: Customer confirmed completion. Terminal state. Customer is now eligible to submit ratings and reviews.
5. **`CANCELLED`**: Booking was cancelled by an authorized participant or administrator. Terminal state. Requirement capacity is authoritatively reconciled.

---

## 3. Transition Rules & Matrix

| From | Action | To | Allowed Roles | Guards | Metadata Updated |
|---|---|---|---|---|---|
| `CONFIRMED` | `START_WORK` | `IN_PROGRESS` | `WORKER`, `ADMIN`, `SYSTEM` | Worker ID must match `booking.worker_id` | `started_at`, `otp_verified = true` |
| `CONFIRMED` | `CANCEL` | `CANCELLED` | `CUSTOMER`, `WORKER`, `ADMIN`, `SYSTEM` | Authorized participant | `cancelled_at`, `cancelled_by`, `cancellation_reason` |
| `IN_PROGRESS` | `REQUEST_COMPLETION` | `AWAITING_CONFIRMATION` | `WORKER`, `ADMIN`, `SYSTEM` | Worker ID must match `booking.worker_id` | `completion_requested_at` |
| `IN_PROGRESS` | `CANCEL` | `CANCELLED` | `ADMIN`, `SYSTEM`, `CUSTOMER`, `WORKER` | Authorized participant | `cancelled_at`, `cancelled_by`, `cancellation_reason` |
| `AWAITING_CONFIRMATION` | `CONFIRM_COMPLETION` | `COMPLETED` | `CUSTOMER`, `ADMIN`, `SYSTEM` | Customer ID must match `booking.customer_id` | `completed_at`, `confirmed_by` |
| `AWAITING_CONFIRMATION` | `CANCEL` | `CANCELLED` | `CUSTOMER`, `ADMIN`, `SYSTEM` | Customer owner or admin/system | `cancelled_at`, `cancelled_by`, `cancellation_reason` |
| `COMPLETED` | *Any* | — | None | Terminal state | — |
| `CANCELLED` | *Any* | — | None | Terminal state | — |

---

## 4. Concurrency & Integrity Invariants

1. **Transactional Row Locking**:
   All lifecycle mutations occur inside a database transaction holding a PostgreSQL row-level lock (`SELECT ... FOR UPDATE`).
2. **Centralized Authority**:
   No controller or service may mutate `booking.status` directly. All mutations must pass through `bookingStateService.transition(...)`.
3. **Idempotency**:
   - Repeated `CONFIRM_COMPLETION` on `COMPLETED` bookings succeeds safely without re-executing transitions, duplicate review creation, or double-counting capacity.
   - Repeated `REQUEST_COMPLETION` on `AWAITING_CONFIRMATION` bookings succeeds safely.
4. **Durable Transition Audit**:
   Every state change records an entry in the `booking_transition` table within the same atomic transaction.
