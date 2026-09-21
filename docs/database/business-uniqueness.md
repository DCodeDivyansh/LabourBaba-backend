# Business Uniqueness & Database Integrity Review (Issue #32)

## 1. Purpose & Principles
In high-throughput, distributed marketplace backend systems, application-level checks (e.g., `findFirst()` followed by `create()`) are susceptible to race conditions under concurrent requests, retries, and network replays.

The core principle of this remediation is: **PostgreSQL is the single, authoritative source of truth for all duplicate-prone business identities.** Duplicate logical business records must be rejected deterministically by database-level `UNIQUE` constraints and indexes.

---

## 2. Business Identity Inventory

| Entity / Domain | Logical Business Identity | Database Constraint / Unique Index | Invariant & Concurrency Protection |
|---|---|---|---|
| **`dispatch_wave`** | `(requirement_id, wave_number)` | `uniq_dispatch_wave_req_wave` (UNIQUE) | Prevents redundant or conflicting wave definitions for the same requirement. |
| **`dispatch_wave`** | `operation_id` | `uniq_dispatch_wave_operation_id` (UNIQUE) | Guarantees dispatch operation idempotency across BullMQ workers and retry cycles. |
| **`job_dispatch`** | `(requirement_id, worker_id)` | `uniq_job_dispatch_req_worker` (UNIQUE) | Enforces that a worker can be dispatched at most once per requirement across all waves. |
| **`booking`** | `(requirement_id, worker_id)` | `uniq_booking_requirement_worker` (UNIQUE) | Guarantees a worker cannot obtain multiple concurrent bookings for the same job requirement. |
| **`review`** | `booking_id` | `uniq_review_booking` (UNIQUE) | Enforces the strict product rule: exactly one review per confirmed booking. |
| **`payment`** | `booking_id` | `payment_booking_id_key` (UNIQUE) | Enforces that exactly one payment order corresponds to one booking. |
| **`payment`** | `idempotency_key` | `payment_idempotency_key_key` (UNIQUE) | Enforces idempotent payment order creation under client/network retry. |
| **`payment`** | `razorpay_order_id` | `payment_razorpay_order_id_key` (UNIQUE) | Rejects duplicate Razorpay order references. |
| **`worker_device`** | `(worker_id, device_id)` | `uq_worker_device_worker_device` (UNIQUE) | Allows a worker to register multiple devices while guaranteeing exactly one record per physical device. |
| **`payment_webhook_event`** | `(provider, providerEventId)` | `payment_webhook_event_provider_providerEventId_key` (UNIQUE) | Enforces replay protection for payment provider webhook payloads. |
| **`otp_challenge`** | `(phone, purpose)` WHERE `status = 'ACTIVE'` | `uniq_active_otp_phone_purpose` (Partial UNIQUE) | Ensures at most one active OTP challenge exists per phone and purpose. |
| **`worker_skill`** | `(worker_id, skill_id)` | `uniq_worker_skill` (UNIQUE) | Rejects duplicate skill associations for workers. |
| **`job_requirement_skill`**| `(requirement_id, skill_id)` | `uniq_job_requirement_skill` (UNIQUE) | Rejects duplicate skill requirements for jobs. |
| **`Worker`** | `phone` | `worker_phone_key` (UNIQUE) | Prevents duplicate worker registrations with the same phone. |
| **`customer`** | `phone` | `customer_phone_key` (UNIQUE) | Prevents duplicate customer registrations with the same phone. |
| **`skill_category`** | `name` | `skill_category_name_key` (UNIQUE) | Prevents duplicate skill taxonomy categories. |
| **`conversation`** | `booking_id` | `conversation_booking_id_key` (UNIQUE) | Exactly one chat conversation per booking. |
| **`worker_analytics`** | `worker_id` | `worker_analytics_worker_id_key` (UNIQUE) | Exactly one analytics record per worker. |

---

## 3. Constraints Intentionally Not Added

1. **Global Uniqueness on `worker_device.fcm_token`**:
   - *Rationale*: FCM tokens can rotate across app reinstalls or shared testing devices. Imposing a global unique constraint on push tokens would prevent legitimate device transitions and causes false conflicts. `(worker_id, device_id)` is the canonical business identity, and `fcm_token` is indexed (`idx_worker_device_fcm_token`) for fast lookups.
2. **Global Uniqueness on `booking.job_id`**:
   - *Rationale*: A job can have multi-worker requirements (e.g. 5 painters needed for 1 job), resulting in multiple bookings per job. The correct composite identity is `(requirement_id, worker_id)`.

---

## 4. Conflict Handling & Retry Safety
- **Prisma Unique Violations**: Any concurrent duplicate insert triggers PostgreSQL error `23505` which Prisma surfaces as `PrismaClientKnownRequestError` with code `P2002`.
- **Application Handling**:
  - `acceptDispatch`: Catches `P2002` or `uniq_booking_requirement_worker` and returns a controlled 409 `BOOKING_ALREADY_EXISTS` error.
  - `worker_device`: Uses `upsert` on `worker_id_device_id` so repeated device registrations update the token and timestamps idempotently without throwing.
  - Webhooks & Events: Handlers record events inside transaction with unique constraint, enabling safe drops on redelivered webhook duplicates.

---

## 5. Verification & Test Evidence
Implemented in [`tests/businessUniquenessConcurrency.test.ts`](../../tests/businessUniquenessConcurrency.test.ts):
- Concurrent duplicate wave creation: 1 succeeded, 1 rejected with unique violation.
- Concurrent duplicate booking creation: 1 succeeded, 1 rejected with unique violation.
- Concurrent duplicate review creation: 1 succeeded, 1 rejected with unique violation.
- Concurrent duplicate payment order creation: 1 succeeded, 1 rejected with unique violation.
- Concurrent duplicate worker device registration: 1 succeeded, 1 rejected with unique violation.
- Concurrent duplicate webhook event ingestion: 1 succeeded, 1 rejected with unique violation.
- Retrying registration with upsert: Idempotent resolution without duplicate rows.
- Direct constraint violation error verification: Throws controlled `P2002` error.
