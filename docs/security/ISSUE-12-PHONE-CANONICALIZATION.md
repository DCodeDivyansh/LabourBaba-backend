# Issue 12 — Canonicalize Phone Identity (E.164)

## 1. Problem Description
Phone numbers serve as primary identity keys for authentication, OTP challenges, and account discovery in the LabourBaba platform. Unnormalized or raw textual phone representations (e.g., `9876543210`, `09876543210`, `+91 98765-43210`, `+919876543210`) allowed identity fragmentation, rate limit bypasses, and account collision vulnerabilities.

## 2. Current Architecture & Implementation
A single canonical normalization utility is implemented in `src/utils/authUtils.ts` using `libphonenumber-js`:
- `normalizePhoneToE164(phone: string): string` parses and normalizes phone numbers to standard E.164 format (e.g., `+919876543210`).
- Ambiguous or malformed inputs throw `INVALID_PHONE_NUMBER` error code (HTTP 400).
- Normalization is enforced universally before:
  - Customer registration & login
  - Worker registration & login
  - OTP challenge creation (`POST /api/auth/send-otp`)
  - OTP challenge verification (`POST /api/auth/verify-otp`)
  - Rate limiting key derivation (`ratelimit:otp:req:phone:<sha256>`)

## 3. Database Constraints & Uniqueness
- The PostgreSQL `Customer` and `Worker` tables enforce unique indexes on `phone`.
- Concurrency race conditions (e.g., concurrent registration with differently formatted representations of the same phone) are caught by PostgreSQL unique constraint violations (`P2002`) and converted to HTTP 409 Conflict.

## 4. Test Evidence
- Verified via `tests/phoneNormalization.test.ts` (14 tests PASS) & `tests/businessUniquenessConcurrency.test.ts` (10 tests PASS).
- Tested equivalence across local formats, country-code prefixes, whitespace/hyphen formatting, invalid phone rejection, and rate limiter bucket sharing.
