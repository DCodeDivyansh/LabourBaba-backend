-- Migration: 20260920040000_booking_state_machine
-- Description: Add lifecycle metadata columns to booking table, canonicalize status values, create status index, and create booking_transition table for audit history.

-- 1. Canonicalize legacy lowercase status values to canonical uppercase
UPDATE "booking" SET "status" = 'CONFIRMED' WHERE "status" = 'confirmed';

-- 2. Add lifecycle timestamp and actor tracking columns to booking table
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "started_at" TIMESTAMPTZ(6);
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "completion_requested_at" TIMESTAMPTZ(6);
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMPTZ(6);
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMPTZ(6);
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "cancelled_by" VARCHAR(100);
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "cancellation_reason" TEXT;
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "confirmed_by" VARCHAR(100);

-- 3. Add index on booking status
CREATE INDEX IF NOT EXISTS "idx_booking_status" ON "booking"("status");

-- 4. Create booking_transition table for durable state machine history
CREATE TABLE IF NOT EXISTS "booking_transition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "booking_id" UUID NOT NULL,
    "from_status" VARCHAR(30) NOT NULL,
    "to_status" VARCHAR(30) NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "actor_type" VARCHAR(30) NOT NULL,
    "actor_id" VARCHAR(100),
    "reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_transition_pkey" PRIMARY KEY ("id")
);

-- 5. Foreign key constraint with cascade on delete
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_transition_booking'
    ) THEN
        ALTER TABLE "booking_transition"
        ADD CONSTRAINT "fk_transition_booking"
        FOREIGN KEY ("booking_id")
        REFERENCES "booking"("id")
        ON DELETE CASCADE
        ON UPDATE NO ACTION;
    END IF;
END $$;

-- 6. Index for fast transition history lookup by booking_id and created_at
CREATE INDEX IF NOT EXISTS "idx_booking_transition_booking_id" ON "booking_transition"("booking_id", "created_at");
