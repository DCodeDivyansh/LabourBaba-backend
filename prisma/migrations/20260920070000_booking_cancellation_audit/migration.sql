-- Migration: 20260920070000_booking_cancellation_audit
-- Description: Backfill legacy cancelled bookings and enforce database CHECK constraint for complete cancellation audit fields.

-- 1. Backfill any legacy cancelled bookings that may lack cancellation metadata
UPDATE "booking"
SET
    "cancelled_at" = COALESCE("cancelled_at", "updated_at", NOW()),
    "cancelled_by" = COALESCE("cancelled_by", 'SYSTEM_MIGRATION'),
    "cancellation_reason" = COALESCE("cancellation_reason", 'Legacy cancellation')
WHERE "status" = 'CANCELLED'
  AND ("cancelled_at" IS NULL OR "cancelled_by" IS NULL OR "cancellation_reason" IS NULL);

-- 2. Add CHECK constraint enforcing complete cancellation audit fields
ALTER TABLE "booking" DROP CONSTRAINT IF EXISTS "chk_booking_cancellation_audit";
ALTER TABLE "booking"
ADD CONSTRAINT "chk_booking_cancellation_audit"
CHECK (
    "status" != 'CANCELLED'
    OR (
        "cancelled_at" IS NOT NULL
        AND "cancelled_by" IS NOT NULL
        AND "cancellation_reason" IS NOT NULL
    )
);
