# Review Uniqueness Invariant & Concurrency Architecture

## Overview
This document specifies the authoritative business invariant, database design, concurrency controls, and idempotency semantics for reviews in the LabourBaba platform.

---

## 1. Core Invariant

$$\text{For every booking\_id: } \text{COUNT}(\text{review WHERE review.booking\_id} = \text{booking\_id}) \le 1$$

- **Exactly one review may exist per booking.**
- Reviews are strictly customer-authored and can only be created for completed bookings.
- The PostgreSQL database is the final, authoritative arbiter of uniqueness.

---

## 2. Why Database Enforcement Is Mandatory

Application-level pre-checks (`findFirst` followed by `create`) are inherently race-prone:

```
Process / Request A                     Process / Request B
        │                                       │
        ▼                                       ▼
SELECT FROM review                      SELECT FROM review
WHERE booking_id = X                    WHERE booking_id = X
  └─► No review found                     └─► No review found
        │                                       │
        ▼                                       ▼
INSERT INTO review                      INSERT INTO review
  └─► Success                             └─► DUPLICATE ROW CREATED! (Corrupt state)
```

Such races occur naturally under:
1. Mobile double-taps or UI retries.
2. Network timeouts followed by client retries.
3. Multiple Node.js processes, containers, or cluster workers running concurrently.
4. Client-side retry middleware.

With the database-level unique constraint (`uniq_review_booking` / `review_booking_id_key`):

```
Process / Request A                     Process / Request B
        │                                       │
        ▼                                       ▼
INSERT INTO review                      INSERT INTO review
  └─► Committed (201 Created)             └─► Rejected by PostgreSQL:
                                                UNIQUE constraint violation (23505 / P2002)
                                                Mapped safely to HTTP 409 Conflict
                                                (REVIEW_ALREADY_EXISTS)
```

---

## 3. Database Schema & Migration

### Migration: `20260920080000_enforce_one_review_per_booking`
- **Safe Pre-Check**: Verifies no duplicate rows exist; aborts cleanly if duplicates are detected.
- **Authoritative Unique Constraint & Index**:
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_review_booking" ON "review"("booking_id");
  CREATE UNIQUE INDEX IF NOT EXISTS "review_booking_id_key" ON "review"("booking_id");

  ALTER TABLE "review" ADD CONSTRAINT "uniq_review_booking"
  UNIQUE USING INDEX "uniq_review_booking";
  ```
- **Secondary Indexes**:
  ```sql
  CREATE INDEX IF NOT EXISTS "idx_review_customer" ON "review"("customer_id");
  CREATE INDEX IF NOT EXISTS "idx_review_worker" ON "review"("worker_id");
  ```

---

## 4. Application Error Handling & Idempotency

In `src/features/review/reviewServices.ts`:
- `isReviewUniqueConstraintError(err)` accurately detects:
  1. Prisma `P2002` targeting `booking_id` or `uniq_review_booking` / `review_booking_id_key`.
  2. Native PostgreSQL SQLSTATE `23505` with `constraint = 'uniq_review_booking'` or detail containing `booking_id`.
- Unrelated P2002 errors (e.g. phone uniqueness) and generic database errors are never swallowed and are rethrown.
- Duplicate review creation attempts throw `ReviewError("A review has already been submitted for this booking", "REVIEW_ALREADY_EXISTS", 409)`.
- Inline reviews in `confirmComplete()` handle the unique violation idempotently, preserving existing reviews without failing the completion transaction.
