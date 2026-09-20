# Booking OTP Lifecycle & Verification Architecture

## Overview
Booking OTP verification authoritatively transitions a booking from `CONFIRMED` to `IN_PROGRESS`. This document defines the lifecycle, schema, security invariants, lockouts, concurrency controls, and metadata auditing for booking OTPs in the LabourBaba platform.

---

## 1. Schema & Persistence Model

Booking OTP verification fields reside directly on the `booking` table in PostgreSQL:

| Column | Type | Constraints | Description |
|---|---|---|---|
| `otp_hash` | `VARCHAR(255)` | Nullable | Bcrypt hash of the 6-digit numeric OTP generated at dispatch acceptance. |
| `otp_expires_at` | `TIMESTAMPTZ(6)` | Nullable | Expiration timestamp (default: 24h / 86,400s from creation). |
| `otp_attempts` | `INT` | Default `0` | Number of failed verification attempts. |
| `otp_locked_at` | `TIMESTAMPTZ(6)` | Nullable | Timestamp when brute-force threshold (5 attempts) was reached. |
| `otp_consumed_at` | `TIMESTAMPTZ(6)` | Nullable | Timestamp when OTP was successfully verified and consumed. |
| `otp_verified` | `BOOLEAN` | Default `false` | Boolean indicator of completion of OTP step. |
| `verified_at` | `TIMESTAMPTZ(6)` | Nullable | Authoritative verification timestamp. |
| `verified_by` | `VARCHAR(100)` | Nullable | Principal ID (worker ID) who performed verification. |

### Migration
Defined in `prisma/migrations/20260920050000_harden_booking_otp/migration.sql`:
```sql
ALTER TABLE "booking"
  ADD COLUMN IF NOT EXISTS "otp_expires_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "otp_attempts" INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "otp_locked_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "otp_consumed_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "verified_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "verified_by" VARCHAR(100);

CREATE INDEX IF NOT EXISTS "idx_booking_otp_lifecycle"
  ON "booking"("status", "otp_verified", "otp_expires_at");
```

---

## 2. State Machine Binding & Pre-Verification Invariants

The booking state machine requires that OTP verification occurs **only** when the booking is in `CONFIRMED` state:

```
                      [Dispatched Worker Accepts]
                                  │
                                  ▼
                            [ CONFIRMED ]
                                  │
                  Worker Submits Valid OTP (verifyOtp)
                                  │
                                  ▼
                           [ IN_PROGRESS ]
                                  │
                                 ...
```

### Invariants:
1. **Pre-verification State Guard**:
   - If `status !== BookingStatus.CONFIRMED`, verification throws `BookingOtpWrongStateError` (HTTP 400, `OTP_WRONG_STATE`).
   - Wrong-state verification attempts **do not** increment the `otp_attempts` counter.
2. **Single-Use Consumption**:
   - If `otp_consumed_at != null` or `otp_verified === true`, verification throws `BookingOtpAlreadyConsumedError` (HTTP 409, `OTP_ALREADY_USED`).
3. **Expiration**:
   - If `Date.now() > otp_expires_at`, verification throws `BookingOtpExpiredError` (HTTP 400, `OTP_EXPIRED`).
4. **Brute-Force Lockout**:
   - If `otp_locked_at != null` or `otp_attempts >= bookingConfig.bookingOtpMaxAttempts` (5), verification throws `BookingOtpLockedError` (HTTP 400, `OTP_LOCKED`).
   - A locked challenge rejects even the valid OTP.
5. **Failed Attempt Tracking**:
   - Each invalid OTP increment `otp_attempts` by 1.
   - If `newAttempts >= 5`, `otp_locked_at` is set to `now()` and `BookingOtpLockedError` is thrown.
   - Otherwise, `BookingOtpInvalidError` (HTTP 400, `OTP_INVALID`) is thrown.
6. **Atomic Transition & Metadata Audit**:
   - On valid OTP, `bookingStateService.transition()` transitions status to `IN_PROGRESS` and stamps:
     - `started_at = now()`
     - `otp_verified = true`
     - `otp_consumed_at = now()`
     - `verified_at = now()`
     - `verified_by = actor.id`
   - Synchronizes parent Job to `IN_PROGRESS`.
   - Inserts audit record into `booking_transition`.

---

## 3. Concurrency & Atomicity (PostgreSQL Row Locks)

To prevent race conditions where concurrent requests might verify the same OTP simultaneously or cause lost attempt updates:

1. Verification runs inside `prisma.$transaction`.
2. Employs `SELECT ... FROM "booking" WHERE id = $1::uuid FOR UPDATE`.
3. Ensures exclusive write serialization for the duration of the state transition and attempt updates.

---

## 4. DTO & Information Leakage Defense

- `bookingSafeSelect` strictly excludes:
  - `otp_hash`
  - `otp_attempts`
  - `otp_locked_at`
  - `otp_consumed_at`
- `BookingSafeDTO` exposes safe audit fields:
  - `verified_at`
  - `verified_by`
  - `started_at`
  - `otp_verified`
