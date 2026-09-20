-- Migration: 20260920080000_enforce_one_review_per_booking
-- Issue #20: Enforce One Review Per Booking (Audit #35, Priority: P1, Category: Data Integrity)
--
-- Core Invariant:
--   For every booking_id: COUNT(review WHERE review.booking_id = booking_id) <= 1
--
-- Motivation:
--   Application-level pre-checks (SELECT then INSERT) are race-prone under concurrent
--   mobile requests, network retries, and double-submits. The PostgreSQL UNIQUE constraint
--   is the authoritative, database-level guard against duplicate reviews.

-- Step 1: Pre-migration duplicate check (safe non-destructive guard)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "review"
        GROUP BY booking_id
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'Cannot enforce one review per booking: duplicate reviews detected in database. Manual deduplication is required before applying unique constraint.';
    END IF;
END $$;

-- Step 2: Create unique index on review(booking_id)
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_review_booking" ON "review"("booking_id");
CREATE UNIQUE INDEX IF NOT EXISTS "review_booking_id_key" ON "review"("booking_id");

-- Step 3: Enforce database constraint using the unique index
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uniq_review_booking'
    ) THEN
        ALTER TABLE "review" ADD CONSTRAINT "uniq_review_booking" UNIQUE USING INDEX "uniq_review_booking";
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        -- If already enforced or index conflict, ensure at least unique index exists
        NULL;
END $$;

-- Step 4: Create secondary query indexes for operational reads
CREATE INDEX IF NOT EXISTS "idx_review_customer" ON "review"("customer_id");
CREATE INDEX IF NOT EXISTS "idx_review_worker" ON "review"("worker_id");
