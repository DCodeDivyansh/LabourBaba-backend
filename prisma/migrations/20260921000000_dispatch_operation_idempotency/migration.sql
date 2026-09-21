-- Migration: 20260921000000_dispatch_operation_idempotency
-- Issue #23: Add Dispatch Operation Idempotency
-- Adds operation_id to dispatch_wave with deterministic backfill and database uniqueness.

-- 1. Add operation_id column to dispatch_wave if it does not exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'dispatch_wave' AND column_name = 'operation_id'
    ) THEN
        ALTER TABLE "dispatch_wave" ADD COLUMN "operation_id" VARCHAR(255);
    END IF;
END $$;

-- 2. Backfill existing dispatch_wave rows with deterministic operation IDs
-- Formula: 'disp_op_' || substring(md5('req:' || requirement_id::text || ':wave:' || wave_number::text || ':type:WAVE_DISPATCH') from 1 for 32)
UPDATE "dispatch_wave"
SET "operation_id" = 'disp_op_' || SUBSTRING(MD5('req:' || LOWER(TRIM(requirement_id::text)) || ':wave:' || wave_number::text || ':type:WAVE_DISPATCH') FROM 1 FOR 32)
WHERE "operation_id" IS NULL;

-- 3. Create unique index and constraint on dispatch_wave(operation_id)
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_dispatch_wave_operation_id" ON "dispatch_wave"("operation_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uniq_dispatch_wave_operation_id'
    ) THEN
        ALTER TABLE "dispatch_wave" ADD CONSTRAINT "uniq_dispatch_wave_operation_id" UNIQUE USING INDEX "uniq_dispatch_wave_operation_id";
    END IF;
END $$;

-- 4. Supporting indexes for query and status lookup
CREATE INDEX IF NOT EXISTS "idx_dispatch_wave_operation_id" ON "dispatch_wave"("operation_id");
CREATE INDEX IF NOT EXISTS "idx_dispatch_wave_req_status" ON "dispatch_wave"("requirement_id", "status");
