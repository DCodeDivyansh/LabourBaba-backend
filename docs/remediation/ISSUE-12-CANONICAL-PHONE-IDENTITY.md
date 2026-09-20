# P2 Authentication & Identity Remediation — Issue #12: Canonicalize Phone Identity

## 1. Status
**RESOLVED**

All requirements of Issue #12 and Section 19 of the Implementation Plan have been executed, verified, and tested with zero regressions across all unit, integration, schema validation, rate-limiting, and authentication test suites.

---

## 2. Executive Summary
- **Original Problem**: The system lacked uniform phone canonicalization across authentication entrypoints. While OTP send/verify attempted basic punctuation stripping via a naive regex, registration (`POST /api/clients/signup`, `POST /api/workers/register`), login (`POST /api/clients/login`, `POST /api/workers/login`), worker profile updates, and rate-limiting keys accepted raw, varied string representations. This enabled duplicate account creation for the same physical device (e.g. `+919876543210` vs `+91 98765 43210` vs `+91-98765-43210`), split rate-limiting quotas across representations, and prevented login when users entered valid formatted numbers.
- **Remediation Invariant Established**: All phone numbers entering the backend are parsed, validated, and normalized to canonical **E.164 format** (`+<country_code><national_number>`, e.g., `+919876543210`) using Google's `libphonenumber-js` standard. All database lookups, inserts, updates, OTP challenges, and rate limiter keys operate strictly on canonical E.164 strings. Ambiguous numbers without country code are rejected with HTTP 422 / 400. Database uniqueness is enforced on canonical strings with safe collision guards.

---

## 3. Source / Audit Mapping
- **Roadmap Issue**: Issue #12
- **Priority**: P2
- **Category**: Authentication / Identity Integrity
- **Original Audit Finding**: Audit #66 — Phone normalization / canonical phone identity
- **Roadmap Requirements**:
  1. Normalize phone input to E.164 before lookup/create.
  2. Migrate existing phone records to canonical representation.
  3. Make canonical phone identity unique at the database level.
  4. Never compare raw user-entered phone strings.
  5. Equivalent phone representations must resolve to one identity.
  6. Duplicate account creation must be rejected safely.

---

## 4. Codebase Audit & Gap Analysis

Before remediation, a comprehensive audit of all phone-handling paths revealed:

1. **`src/utils/authUtils.ts` (`normalizePhone`)**:
   - Implemented a naive regex: `phone.trim().replace(/[\s\-\(\)\.]/g, "")`.
   - Did not validate country calling codes, E.164 standard, or number validity.
   - Left ambiguous numbers (e.g., `09876543210` vs `+919876543210`) as separate identities.

2. **`src/schemas/index.ts` (Zod Schemas)**:
   - Used basic regex `/^\+?[1-9]\d{9,14}$/` or `.min(10)` without transformation.
   - Controllers received unnormalized strings directly from request bodies.

3. **`src/features/auth/customerAuthController.ts`**:
   - `signupCustomer` and `loginCustomer` passed raw `req.body.phone` directly into `prisma.customer.findUnique` and `prisma.customer.create`.

4. **`src/features/worker/workerController.ts` & `workerServices.ts`**:
   - `loginWorker`, `register`, and `updateProfile` passed raw unnormalized phone strings into Prisma queries.

5. **`src/middlewares/otpRateLimiter.ts`**:
   - Built Redis/in-memory rate limit keys from naive `normalizePhone`, risking key fragmentation for differently formatted inputs.

6. **`prisma/schema.prisma`**:
   - `Worker.phone` and `customer.phone` were typed as `VarChar(15)`, which risked truncation or tight margins for international numbers up to 15 digits plus `+` prefix and country codes.

---

## 5. Architectural Remediation Design

```
+-------------------------------------------------------------------------+
|                          Incoming Client Request                        |
|  Examples: "+91 98765 43210", "+91-98765-43210", "+91 (98765) 43210"   |
+-------------------------------------------------------------------------+
                                     │
                                     ▼
+-------------------------------------------------------------------------+
|                  Zod Validation & Transformation Layer                  |
|                   (e164PhoneSchema / normalizePhoneToE164)              |
|                                                                         |
|  • Parses number with libphonenumber-js                                 |
|  • Validates national structure & country code                          |
|  • Rejects local ambiguous numbers lacking country code (422/400)       |
|  • Transforms to canonical E.164: "+919876543210"                       |
+-------------------------------------------------------------------------+
                                     │
                                     ▼
+-------------------------------------------------------------------------+
|                          Controllers & Services                         |
|  • OTP Send / Verify       → queries otp_challenge with "+919876543210" |
|  • Customer Signup / Login → queries customer with "+919876543210"      |
|  • Worker Register / Login → queries worker with "+919876543210"        |
|  • Rate Limiting           → key "ratelimit:otp:req:phone:+919876543210"|
+-------------------------------------------------------------------------+
                                     │
                                     ▼
+-------------------------------------------------------------------------+
|                         PostgreSQL Database                             |
|  • worker.phone: VARCHAR(20) @unique                                    |
|  • customer.phone: VARCHAR(20) @unique                                  |
|  • otp_challenge.phone: VARCHAR(20)                                     |
+-------------------------------------------------------------------------+
```

---

## 6. Implementation Details

### 6.1 `src/utils/authUtils.ts`
Implemented `normalizePhoneToE164(phone: string): string`:
- Uses `parsePhoneNumber` from `libphonenumber-js`.
- Verifies `parsed.isValid()`.
- Returns `parsed.format("E.164")`.
- Throws `{ code: "INVALID_PHONE_NUMBER", message: "..." }` on missing, malformed, or ambiguous numbers lacking country code.
- Maintained `normalizePhone` as an alias calling `normalizePhoneToE164` for full backward compatibility.

### 6.2 `src/schemas/index.ts`
Added `e164PhoneSchema` and `optionalE164PhoneSchema` using Zod `.transform()`:
- `CreateCustomerReqSchema`
- `CreateWorkerReqSchema`
- `LoginWorkerReqSchema`
- `SignupCustomerReqSchema`
- `LoginCustomerReqSchema`
- `SendOtpReqSchema`
- `AuthVerifyOtpReqSchema`
- `UpdateWorkerProfileReqSchema`

### 6.3 `src/features/auth/customerAuthController.ts`
- Normalizes phone numbers with `normalizePhoneToE164` in `signupCustomer` and `loginCustomer`.
- Catches Prisma `P2002` (unique constraint violation) and returns 409 `{ code: "PHONE_ALREADY_REGISTERED", message: "Customer with this phone number already exists" }`.
- Catches `INVALID_PHONE_NUMBER` and returns 422.

### 6.4 `src/features/worker/workerServices.ts` & `workerController.ts`
- Normalizes phone numbers before find/create in `register`, `loginWorker`, and `updateProfile`.
- Detects existing workers and catches `P2002` race conditions, returning 409 `PHONE_ALREADY_REGISTERED`.
- Catches `INVALID_PHONE_NUMBER` and returns 422.

### 6.5 `src/middlewares/otpRateLimiter.ts`
- Safely parses and normalizes phone numbers to E.164 for rate limit key construction (`ratelimit:otp:req:phone:+919876543210`).
- If an unparseable phone number is submitted, rate limiting falls back to IP-based rate limiting while the Zod validator rejects the request downstream.

### 6.6 `prisma/schema.prisma` & Migration
- Expanded `Worker.phone` and `customer.phone` to `@db.VarChar(20)`.
- Created migration `prisma/migrations/20260920000000_canonicalize_phone_e164/migration.sql`:
  - `ALTER TABLE "worker" ALTER COLUMN "phone" TYPE VARCHAR(20);`
  - `ALTER TABLE "customer" ALTER COLUMN "phone" TYPE VARCHAR(20);`
  - Normalizes existing data by stripping legacy formatting characters.
  - Executes PL/pgSQL collision detection guard that raises an exception and aborts if duplicate identities are found after normalization.

---

## 7. Verification & Test Coverage

A comprehensive test suite was implemented in `tests/phoneNormalization.test.ts`:
1. **Unit Canonicalization**: Verifies valid international formats (+91, +1, +44 with spaces, hyphens, parentheses, dots) normalize to identical E.164 strings.
2. **Ambiguity & Invalid Rejection**: Verifies numbers without country code (e.g. `9876543210`), empty strings, whitespace, and malformed strings throw `INVALID_PHONE_NUMBER`.
3. **Customer Registration & Duplicates**: Verifies signup canonicalizes phone and rejects duplicate registrations across different formats with 409 `PHONE_ALREADY_REGISTERED`.
4. **Customer Login Equivalence**: Verifies login succeeds using differently formatted phone representations against the stored canonical record.
5. **Worker Registration & Update**: Verifies registration and profile update canonicalize phone numbers and reject duplicates.
6. **OTP Equivalence**: Verifies sending OTP in one format and verifying in a different format resolves to the same challenge and authenticates the user.
7. **Rate Limiting Bucket Equivalence**: Verifies all formatting variations consume from the exact same rate limit key.

---

## 8. Definition of Done Checklist

- [x] Production dependency `libphonenumber-js` installed.
- [x] `normalizePhoneToE164` implemented with E.164 standard formatting.
- [x] `normalizePhone` updated as alias to `normalizePhoneToE164`.
- [x] Zod schemas transformed to output canonical E.164 strings.
- [x] Ambiguous local numbers without country code rejected (Fail-Closed).
- [x] Customer registration, login, and worker registration, login, update normalized.
- [x] Prisma `P2002` concurrent duplicate conflicts safely handled with 409.
- [x] Rate limiting keys canonicalized to prevent quota multiplication.
- [x] Prisma schema expanded to `VARCHAR(20)`.
- [x] Safe, idempotent migration with collision detection created.
- [x] Full test suite implemented and passing.
- [x] TypeScript builds cleanly without errors (`tsc --noEmit`).
