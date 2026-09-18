# Issue #1 — Hard-Coded Review Identity Remediation

**Priority:** P0 — Release Blocker  
**Category:** Security / Authorization  
**Original Audit Finding:** #15  
**Primary Affected Area:** Review Creation (`src/features/review/reviewController.ts`)  
**Status:** RESOLVED  
**Date:** 2026-09-18  

---

## 1. Summary

The production-readiness audit identified a critical **P0 security vulnerability** in review creation (`POST /api/reviews/:bookingId`). The controller used a mock helper function (`getCustomerId()`) that returned a fixed, hard-coded customer UUID (`a1b2c3d4-e5f6-7890-1234-56789abcdef0`) instead of deriving the identity from the authenticated JWT principal.

This vulnerability meant:
- Every review created via this endpoint was attributed to a static non-existent customer.
- Authenticated customers had no real authorship over their reviews.
- The request schema accepted `customer_id`, `worker_id`, and `booking_id` in the request body, allowing clients to attempt identity spoofing.
- Workers and administrators were not blocked by role-based access control.
- Bookings in non-completed lifecycle states (`PENDING`, `IN_PROGRESS`, `CANCELLED`) could be reviewed.
- No database-level uniqueness constraint existed on `booking_id`, allowing duplicate reviews and race conditions.

---

## 2. Root Cause

1. **Controller Identity Helper:** In `src/features/review/reviewController.ts`, `getCustomerId(req)` inspected the `Authorization` header only for presence, and returned a fixed string literal UUID.
2. **Schema Trust:** `CreateReviewReqSchema` accepted `booking_id`, `worker_id`, and `customer_id` from the request body rather than relying strictly on the route parameter and authenticated JWT context.
3. **Missing Role Enforcement:** `POST /api/reviews/:bookingId` lacked `requireRole(UserRole.CUSTOMER)`, permitting non-customer accounts (workers, admins) to post reviews.
4. **Missing State Enforcement:** Neither `reviewServices.ts` nor `bookingServices.ts` verified that the booking was in the terminal `COMPLETED` state before persisting a review.
5. **Missing Database Invariant:** The Prisma schema defined `review` with a non-unique `booking_id`, permitting multiple reviews per booking at the database level.
6. **Raw Error Leakage:** The review controller catch block returned `res.status(500).json({ success: false, message: error.message })`, exposing internal database and driver exceptions.

---

## 3. Vulnerability Map

| ID | Location | Vulnerability | Remediation |
|---|---|---|---|
| **V1** | `reviewController.ts:5-9` | `getCustomerId()` returned hard-coded UUID `a1b2c3d4-e5f6-7890-1234-56789abcdef0` | Removed `getCustomerId()`; extracted `req.user.id` from `AuthenticatedRequest` |
| **V2** | `reviewController.ts:15` | Redundant authentication check inside controller | Rely strictly on `authenticateJWT` and `requireRole(UserRole.CUSTOMER)` |
| **V3** | `schemas/index.ts:216-222` | `CreateReviewReqSchema` accepted `customer_id`, `worker_id`, `booking_id` from body | Redefined schema to only allow `rating` and `comment`, enforced `.strict()` |
| **V4** | `reviewRoutes.ts:39` | Missing `requireRole(UserRole.CUSTOMER)` middleware | Added `requireRole(UserRole.CUSTOMER)` to `POST /:bookingId` |
| **V5** | `reviewServices.ts:10` | No lifecycle state check on booking before creating review | Enforced `booking.status === "COMPLETED"` check; returns 409 if not completed |
| **V6** | `prisma/schema.prisma:151` | `review` model lacked unique constraint on `booking_id` | Added `@unique` to `booking_id`, updated relation to 1:1 `review?`, generated migration `20260918040000_review_booking_unique` |
| **V7** | `reviewController.ts:21,31,41` | Catch block returned `error.message` directly (DB leakage) | Introduced `ReviewError` and safe `handleReviewError()` returning stable error codes |
| **V8** | `bookingServices.ts:81-91` | `confirmComplete()` created reviews without checking completed status or handling unique constraint conflicts | Added `booking.status === "COMPLETED"` check and idempotent P2002 conflict handling |

---

## 4. Insecure Flow (Before)

```
Client POST /api/reviews/:bookingId
    ↓
Body contains { customer_id, worker_id, booking_id, rating, comment }
    ↓
authenticateJWT (populates req.user, but controller ignores it)
    ↓
getCustomerId(req)
    ↓
Returns HARD-CODED UUID "a1b2c3d4-e5f6-7890-1234-56789abcdef0"
    ↓
No role check (workers & admins allowed)
    ↓
reviewService.createReview()
    - Queries booking with hard-coded customer ID (always fails unless seeded)
    - No check on booking.status (PENDING, CANCELLED, etc. could be reviewed)
    - No DB unique constraint (multiple reviews allowed for same booking)
    ↓
On error: returns raw error.message (DB internals leaked)
```

---

## 5. Remediated Flow (After)

```
Client POST /api/reviews/:bookingId
    ↓
authenticateJWT (verifies JWT signature, role validity, expiration)
    ↓
requireRole(UserRole.CUSTOMER) (403 Forbidden for workers, admins)
    ↓
validateBody(CreateReviewReqSchema) (.strict() rejects customer_id, worker_id, booking_id)
    ↓
createReview Controller:
    - customerId = (req as AuthenticatedRequest).user!.id  [AUTHORITATIVE]
    - bookingId validated as standard UUID (400 on malformed UUID)
    ↓
reviewService.createReview(bookingId, customerId, payload):
    - Scoped query: findFirst({ where: { id: bookingId, customer_id: customerId } })
    - If not found: check findUnique to distinguish 403 (unowned) vs 404 (not found)
    - State check: booking.status === "COMPLETED" (409 Conflict if not completed)
    - Application duplicate pre-check: review.findFirst({ where: { booking_id } }) (409)
    - Database creation: prisma.review.create(...)
    - Catch block: catches Prisma P2002 on booking_id → maps to 409 Conflict
    ↓
Database: UNIQUE constraint "review_booking_id_key" prevents concurrent duplicate insertion
    ↓
Safe JSON response: { success: true, data: review }
```

---

## 6. Identity Rules

1. **Client Identity Fields are Stripped and Rejected:** The `CreateReviewReqSchema` uses Zod's `.strict()` mode. Any attempt to supply `customer_id`, `customerId`, `worker_id`, `workerId`, `booking_id`, or `bookingId` in the body fails immediately with `400 Bad Request`.
2. **Authoritative Customer Identity:** The review author is strictly `req.user.id` populated by `authenticateJWT`.
3. **Authoritative Worker Identity:** The worker is derived strictly server-side from `booking.worker_id`.
4. **Authoritative Booking Identity:** The booking is identified strictly by the URL path parameter `req.params.bookingId`.

---

## 7. Ownership Rules

1. The service queries the booking using `{ id: bookingId, customer_id: customerId }`.
2. If the booking exists but belongs to a different customer, the service throws a `ReviewError` with code `FORBIDDEN_BOOKING_ACCESS` and status `403 Forbidden`.
3. If the booking does not exist at all, the service throws `BOOKING_NOT_FOUND` with status `404 Not Found`.
4. Knowing another user's booking UUID does not grant permission to review it.

---

## 8. State Rules

1. The only reviewable booking status is **`COMPLETED`**.
2. If a review is attempted for a booking in any other status (`PENDING`, `IN_PROGRESS`, `CANCELLED`, `CONFIRMED`), the service rejects the request with code `BOOKING_NOT_COMPLETED` and status `409 Conflict`.
3. In `bookingServices.ts:confirmComplete()`, review creation is only attempted if `booking.status === "COMPLETED"`.

---

## 9. Duplicate Protection

1. **Application Pre-Check:** `prisma.review.findFirst({ where: { booking_id: bookingId } })` provides fast rejection for sequential retries.
2. **Database Constraint:** `CREATE UNIQUE INDEX "review_booking_id_key" ON "review"("booking_id");` guarantees that race conditions under concurrent requests cannot insert duplicate reviews.
3. **Precise P2002 Handling:** `isReviewUniqueConstraintError(err)` inspects `err.meta.target` and error message to confirm the violation is specifically for `review(booking_id)`. Unrelated unique violations (e.g. on phone or payments) are rethrown and treated as internal server errors (500), avoiding false positives.

---

## 10. Retry Behavior

- **First POST:** Creates the review, returns `201 Created` with the review payload.
- **Repeated POST (Sequential Retry):** Detects existing review, returns `409 Conflict` with code `REVIEW_ALREADY_EXISTS`.
- **confirmComplete() Retry:** If a user confirms completion repeatedly, the second confirmation succeeds with `200 OK` (idempotent), ignoring the duplicate review error without failing the overall confirmation.

---

## 11. Concurrency

Under concurrent execution of two identical requests:
1. Both requests pass authentication, ownership, and state validation.
2. Both attempt `prisma.review.create(...)`.
3. The PostgreSQL database transaction layer commits exactly one `INSERT`.
4. The losing request receives PostgreSQL error `23505` (Prisma code `P2002`).
5. The application catches this error, verifies `meta.target` includes `booking_id`, and returns a safe `409 Conflict`.
6. Database review count is strictly `1`.

---

## 12. `confirmComplete()` Lifecycle Handling

`src/features/booking/bookingServices.ts` contains a second review creation path in `confirmComplete()`:
- **Verified Current Lifecycle:** In `bookingServices.ts`, `completeBooking()` (worker action) transitions the booking to `COMPLETED`. `confirmComplete()` (customer action) is invoked after completion.
- **Safe Handling Added:**
  - Enforced that reviews are only created if `booking.status === "COMPLETED"`. If a rating is supplied on an uncompleted booking, an error is thrown.
  - Wrapped `tx.review.create(...)` with `isReviewUniqueConstraintError()`. If a duplicate review error occurs (e.g. on customer double-click or network retry), the error is safely ignored so the confirmation succeeds idempotently.
  - Unrelated database errors are rethrown.
- **Scope Boundary:** Full booking state-machine overhaul (e.g. formal `AWAITING_CONFIRM` transition state) is deliberately deferred to Issue #16 and Issue #18 as planned in the roadmap.

---

## 13. Tests

All tests are implemented in `tests/reviewSecurity.test.ts` and `tests/apiProtection.test.ts`.

| Test ID | Scenario | Expected | Result |
|---|---|---|---|
| **T1** | Customer A reviews own completed booking | 201 Created, author = Customer A | PASS |
| **T2** | Client supplies `customer_id` in body | 400 Bad Request (strict schema) | PASS |
| **T3** | Client supplies `worker_id` in body | 400 Bad Request (strict schema) | PASS |
| **T4** | Client supplies `booking_id` in body | 400 Bad Request (strict schema) | PASS |
| **T5** | Customer A attempts to review Customer B's booking | 403 Forbidden (`FORBIDDEN_BOOKING_ACCESS`) | PASS |
| **T6** | Worker attempts review creation | 403 Forbidden (RBAC) | PASS |
| **T7** | Admin attempts review creation | 403 Forbidden (RBAC) | PASS |
| **T8** | Review on `PENDING`, `IN_PROGRESS`, `CANCELLED` booking | 409 Conflict (`BOOKING_NOT_COMPLETED`) | PASS |
| **T9** | Sequential duplicate review attempt | 409 Conflict (`REVIEW_ALREADY_EXISTS`) | PASS |
| **T10** | Concurrent duplicate review creation (Promise.all race) | 1x 201, 1x 409 (`REVIEW_ALREADY_EXISTS`) | PASS |
| **T11** | Unauthenticated review attempt | 401 Unauthorized | PASS |
| **T12** | Non-UUID booking route parameter (`/api/reviews/invalid-uuid`) | 400 Bad Request (`INVALID_BOOKING_ID`) | PASS |
| **T13** | Retry semantics on duplicate submission | Safe conflict response, review count = 1 | PASS |
| **T14** | `isReviewUniqueConstraintError` detects `booking_id` P2002 | Returns `true` for review constraint | PASS |
| **T15** | `isReviewUniqueConstraintError` on unrelated P2002 (e.g. phone) | Returns `false`, service rethrows as 500 | PASS |
| **T16** | `confirmComplete()` repeated submission | Idempotent 200 OK, no duplicate error | PASS |
| **A1–A13** | Complete 13-vector attack suite | All 13 vectors mitigated | PASS |

---

## 14. Database Migration

**Migration Directory:** `prisma/migrations/20260918040000_review_booking_unique/`  
**Migration File:** `migration.sql`

```sql
-- Step 1: Reconcile pre-existing duplicate reviews if any exist (safety guard)
DELETE FROM "review" r1
WHERE r1.id IN (
    SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY booking_id
                   ORDER BY id ASC
               ) as rnum
        FROM "review"
    ) ranked
    WHERE ranked.rnum > 1
);

-- Step 2: Create unique index on review(booking_id)
CREATE UNIQUE INDEX IF NOT EXISTS "review_booking_id_key" ON "review"("booking_id");

-- Step 3: Operational indexes for query performance
CREATE INDEX IF NOT EXISTS "idx_review_customer" ON "review"("customer_id");
CREATE INDEX IF NOT EXISTS "idx_review_worker" ON "review"("worker_id");
```

---

## 15. Verification Commands

```bash
# 1. Prisma schema validation
npx prisma validate
# Output: The schema at prisma\schema.prisma is valid 🚀

# 2. Prisma migration status
npx prisma migrate status
# Output: 5 migrations found, recognized 20260918040000_review_booking_unique

# 3. TypeScript build
npm run build
# Output: tsc exited with code 0 (zero errors)

# 4. Review security test suite
npx jest tests/reviewSecurity.test.ts
# Output: 35 passed, 35 total

# 5. API Protection regression suite
npx jest tests/apiProtection.test.ts
# Output: 54 passed, 54 total
```

---

## 16. Remaining Risks & Deferred Findings

- **Deferred Issue #2:** Job creation customer identity (`src/features/jobs/jobController.ts:8`) still has its own fallback decoding logic.
- **Deferred Issue #16 / #18:** Booking state-machine formalization (`AWAITING_CONFIRM` intermediate state, worker completion vs customer acceptance transition flow) is tracked separately under Issues #16 and #18.
