# Remediation Report: Issue #17 — Harden Booking OTP

## Metadata
- **Issue**: Issue #17 — Harden booking OTP
- **Priority**: P1 Marketplace Correctness
- **Audit Findings**: Audit #31
- **Phase**: B — Marketplace Correctness
- **Status**: Remediated & Verified (100% Green, 32 test suites, 765 tests)

---

## 1. Problem Statement & Audit Finding
Previously, booking OTP verification was handled naively:
1. It compared bcrypt hashes with `comparePassword(otp, booking.otp_hash)` without checking whether the booking was in an allowable pre-verification state (`CONFIRMED`).
2. There was no expiration (`otp_expires_at`) validation on the server side.
3. There was no attempt counter (`otp_attempts`) or brute-force lockout (`otp_locked_at`), allowing unbounded offline or online guessing.
4. There was no single-use consumption timestamp (`otp_consumed_at`) or verification audit metadata (`verified_at`, `verified_by`).
5. Concurrent requests could race on the booking status update.

---

## 2. Implemented Solutions

### 2.1 Database & Schema (`prisma/schema.prisma` & Migration)
Added the following lifecycle fields to `model booking`:
- `otp_expires_at DateTime? @db.Timestamptz(6)`
- `otp_attempts Int? @default(0)`
- `otp_locked_at DateTime? @db.Timestamptz(6)`
- `otp_consumed_at DateTime? @db.Timestamptz(6)`
- `verified_at DateTime? @db.Timestamptz(6)`
- `verified_by String? @db.VarChar(100)`

Migration: `prisma/migrations/20260920050000_harden_booking_otp/migration.sql`.

### 2.2 Central Configuration (`src/config/bookingConfig.ts`)
- `bookingOtpTtlSeconds`: Default `86,400` seconds (24 hours), configurable via `BOOKING_OTP_TTL_SECONDS`.
- `bookingOtpMaxAttempts`: Default `5` failed attempts, configurable via `BOOKING_OTP_MAX_ATTEMPTS`.

### 2.3 Domain Errors (`src/features/booking/bookingStateMachine.ts`)
Added domain errors inheriting from `BookingStateError`:
- `BookingOtpError` (base, 400, `OTP_ERROR`)
- `BookingOtpInvalidError` (400, `OTP_INVALID`)
- `BookingOtpExpiredError` (400, `OTP_EXPIRED`)
- `BookingOtpLockedError` (400, `OTP_LOCKED`)
- `BookingOtpAlreadyConsumedError` (409, `OTP_ALREADY_USED`)
- `BookingOtpWrongStateError` (400, `OTP_WRONG_STATE`)

### 2.4 Transactional Verification Service (`src/features/booking/bookingServices.ts`)
In `verifyOtp(bookingId, workerId, otp, actor)`:
1. Enforces PostgreSQL row locking (`SELECT ... FOR UPDATE`).
2. Evaluates actor authorization via `bookingPolicy.canVerifyOtp(actor, lockedBooking)`.
3. Validates pre-verification state: strictly `CONFIRMED`; non-`CONFIRMED` states reject immediately without burning attempts.
4. Verifies consumption status: rejects already consumed or verified bookings.
5. Evaluates lockout: rejects locked challenges (>= 5 attempts or `otp_locked_at` set).
6. Evaluates expiration: rejects expired challenges.
7. Evaluates bcrypt hash:
   - On mismatch: increments `otp_attempts`, locks if max attempts reached, updates DB atomically, throws appropriate error.
   - On match: transitions status to `IN_PROGRESS` via `bookingStateService.transition`, stamping `started_at`, `otp_verified: true`, `otp_consumed_at`, `verified_at`, and `verified_by`. Synchronizes parent job state.

### 2.5 Strict Schemas & DTO Protection
- `VerifyBookingOtpReqSchema`: Made strict via `.strict()` to reject any parameter injection.
- `bookingSafeSelect` & `BookingSafeDTO`: Excludes `otp_hash`, `otp_attempts`, `otp_locked_at`, and `otp_consumed_at` while safely exposing `verified_at` and `verified_by`.

---

## 3. Verification & Test Coverage

### Dedicated Test Suite: `tests/bookingOtpSecurity.test.ts`
21 comprehensive unit & integration tests covering:
- Valid OTP verification & audit metadata recording.
- Replay prevention & single-use consumption.
- Expiration enforcement (`OTP_EXPIRED`).
- Pre-verification state guards (`IN_PROGRESS`, `AWAITING_CONFIRMATION`, `COMPLETED`, `CANCELLED`).
- Attempt counter tracking & brute-force lockout (5 attempts).
- Locked challenge immunity against valid OTP.
- Authorization boundaries (non-assigned worker, customer, unauthenticated).
- Strict schema & input validations (regex, length, extra fields, UUIDs).
- DTO information leakage defense.
- Concurrency and serialization invariants under simultaneous requests.

### Global Test Results
- **All 32 test suites passed**.
- **765 tests passed (100% green)**.
- **TypeScript build passed** (`npm run build`).
