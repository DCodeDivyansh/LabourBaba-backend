-- Migration: 20260920030000_requirement_state_machine
-- Purpose: Authoritative worker_count_needed check constraints, capacity bounds, and status index for job_requirement

-- Step 1: Backfill / repair any legacy rows where worker_count_needed might have been <= 0 or null
UPDATE "job_requirement"
SET "worker_count_needed" = 1
WHERE "worker_count_needed" IS NULL OR "worker_count_needed" <= 0;

-- Step 2: Ensure worker_count_filled is non-negative
UPDATE "job_requirement"
SET "worker_count_filled" = 0
WHERE "worker_count_filled" IS NULL OR "worker_count_filled" < 0;

-- Step 3: Add database-level check constraints
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_job_requirement_worker_count_needed'
  ) THEN
    ALTER TABLE "job_requirement"
      ADD CONSTRAINT "chk_job_requirement_worker_count_needed"
      CHECK ("worker_count_needed" > 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_job_requirement_worker_count_filled'
  ) THEN
    ALTER TABLE "job_requirement"
      ADD CONSTRAINT "chk_job_requirement_worker_count_filled"
      CHECK ("worker_count_filled" >= 0);
  END IF;
END $$;

-- Step 4: Add index on requirement status
CREATE INDEX IF NOT EXISTS "idx_requirement_status" ON "job_requirement"("status");
