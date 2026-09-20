# Remediation Report: Issue #20 — Enforce One Review Per Booking

## Metadata
- **Issue**: Issue #20 — Enforce one review per booking
- **Priority**: P1 Data Integrity
- **Audit Findings**: Audit #35
- **Roadmap Phase**: Phase B — Marketplace Correctness
- **Status**: Remediated & Verified (100% Green, 35 test suites, 810 tests passing)

---

## 1. Root Cause Analysis

Prior to remediation:
1. In the database, the `review` table lacked a database-level `UNIQUE` constraint on `booking_id`.
2. Although `prisma/schema.prisma` contained `@unique`, migrations had not been applied to the live PostgreSQL database (`public.review` only had `review_pkey` and foreign keys).
3. Under concurrent requests, network retries, or mobile double-taps, application-level checks (`findFirst` followed by `create`) suffered from race conditions: two requests could execute `findFirst` simultaneously, find no existing review, and insert duplicate reviews for the same booking.
4. Previous tests mocked Prisma and did not exercise real database concurrency.

---

## 2. Database Changes & Migration

### Migration: `20260920080000_enforce_one_review_per_booking`
- **Safe Pre-Migration Check**: Checks whether duplicate reviews exist; halts safely with a descriptive message rather than destructively deleting user data.
- **Unique Index & Constraint**:
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_review_booking" ON "review"("booking_id");
  CREATE UNIQUE INDEX IF NOT EXISTS "review_booking_id_key" ON "review"("booking_id");

  ALTER TABLE "review" ADD CONSTRAINT "uniq_review_booking"
  UNIQUE USING INDEX "uniq_review_booking";
  ```
- **Secondary Query Indexes**:
  ```sql
  CREATE INDEX IF NOT EXISTS "idx_review_customer" ON "review"("customer_id");
  CREATE INDEX IF NOT EXISTS "idx_review_worker" ON "review"("worker_id");
  ```
- **Prisma Schema Mapping**:
  In `prisma/schema.prisma`:
  ```prisma
  model review {
    id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
    booking_id  String   @unique(map: "uniq_review_booking") @db.Uuid
    ...
  }
  ```

---

## 3. Application Changes & Error Handling

1. **Precise Constraint Error Detection**:
   In `src/features/review/reviewServices.ts`, `isReviewUniqueConstraintError(err)` accurately detects:
   - Prisma `P2002` targeting `booking_id` or constraint names `uniq_review_booking` / `review_booking_id_key`.
   - PostgreSQL native SQLSTATE `23505` with `constraint = 'uniq_review_booking'` or detail containing `booking_id`.
   - Unrelated unique violations (e.g. phone numbers) and general database errors are never swallowed.
2. **Stable API Conflict Response**:
   When a duplicate review is attempted, `reviewService.createReview` throws `ReviewError("A review has already been submitted for this booking", "REVIEW_ALREADY_EXISTS", 409)`.
3. **Idempotent Completion Reviews**:
   When reviews are submitted inline during customer confirmation (`confirmComplete`), duplicate violations are caught and safely ignored idempotently, avoiding transaction rollbacks.

---

## 4. Tests Added & Verification

### Dedicated Real PostgreSQL Concurrency Suite: `tests/reviewPostgresConcurrency.test.ts`
Executes directly against live PostgreSQL without Prisma mocks:
1. **Raw Database Rejection**: PostgreSQL rejects raw duplicate INSERT with SQLSTATE `23505` and constraint `uniq_review_booking`.
2. **2 Concurrent Requests**: Exactly 1 review created; 1 succeeds (201), 1 fails safely (409 `REVIEW_ALREADY_EXISTS`).
3. **10 Concurrent Requests**: Exactly 1 review created; 1 succeeds (201), 9 fail safely (409).
4. **25 Concurrent Requests (High Stress)**: Exactly 1 review created in DB (`COUNT(*) = 1`); zero duplicate rows, zero 500 errors.
5. **Sequential Mobile Retry**: Duplicate submission receives 409 without creating duplicate records.
6. **Cross-Customer Ownership Guard**: Customer B cannot review Customer A's completed booking (403 Forbidden).
7. **Lifecycle State Guard**: Incomplete booking cannot be reviewed (409 `BOOKING_NOT_COMPLETED`).

### Mock-Based Security Suite: `tests/reviewSecurity.test.ts`
All 35 existing unit/authorization tests pass cleanly.

---

## 5. Definition of Done Checklist

- [x] Exactly one review exists per booking.
- [x] `review.booking_id` is database-unique via `uniq_review_booking` constraint.
- [x] Duplicate review attempts cannot create duplicates.
- [x] Concurrent review creation is PostgreSQL-tested (2, 10, and 25 workers).
- [x] Retry/double-submit behavior is safe.
- [x] Unique constraint violations are handled safely (HTTP 409 `REVIEW_ALREADY_EXISTS`).
- [x] Unexpected database errors are not swallowed.
- [x] Review authorization remains enforced (only owning customer).
- [x] Review creation requires terminal `COMPLETED` booking state.
- [x] Migration is production-safe with non-destructive duplicate detection.
- [x] All test suites pass.
- [x] TypeScript builds cleanly (`npm run build`).
