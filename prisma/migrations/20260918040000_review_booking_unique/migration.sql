-- Migration: 20260918040000_review_booking_unique
-- Purpose: Enforce database-level uniqueness for reviews — at most one review per booking.
--
-- Security motivation (Issue #1):
--   Without database-level uniqueness on booking_id, concurrent or repeated review creation
--   requests can create duplicate review records for the same booking. Application-level
--   checks (SELECT then INSERT) are subject to race conditions under concurrent requests.
--   The UNIQUE constraint on booking_id is the authoritative database-level guard: exactly
--   one review can be created per completed booking; any race or duplicate attempt fails
--   with a unique constraint violation (Prisma P2002), which the application maps to a safe
--   409 conflict.
--
-- Migration safety & existing data reconciliation:
--   Step 1: Reconcile any pre-existing duplicate reviews per booking if any exist.
--           Retain the earliest review (by id / created order).
--   Step 2: Create UNIQUE INDEX on review(booking_id).
--   Step 3: Create secondary indexes on customer_id and worker_id for query performance.

-- Step 1: Deterministic duplicate reconciliation (safety guard for existing tables)
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

-- Step 2: Create unique index to enforce at most one review per booking at the database level.
CREATE UNIQUE INDEX IF NOT EXISTS "review_booking_id_key" ON "review"("booking_id");

-- Step 3: Indexes for operational queries (fetching reviews by worker or customer)
CREATE INDEX IF NOT EXISTS "idx_review_customer" ON "review"("customer_id");
CREATE INDEX IF NOT EXISTS "idx_review_worker" ON "review"("worker_id");
