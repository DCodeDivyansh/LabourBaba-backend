-- Migration: 20260926000000_worker_document_status_constraint
-- Purpose: Remediate P6 Issue 9 by enforcing a database-level CHECK constraint on worker_document.status
--          and canonicalizing the default value to uppercase 'PENDING'.

-- 1. Normalize existing data to canonical uppercase (if any legacy rows exist)
UPDATE "worker_document"
SET "status" = UPPER("status")
WHERE "status" IN ('pending', 'verified', 'rejected');

-- 2. Validate that no unmapped or corrupt status values exist before adding constraint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "worker_document"
    WHERE "status" NOT IN ('PENDING', 'VERIFIED', 'REJECTED')
  ) THEN
    RAISE EXCEPTION 'Cannot apply chk_worker_document_status: unexpected status values exist in worker_document table';
  END IF;
END $$;

-- 3. Update default to canonical uppercase 'PENDING' and ensure NOT NULL
ALTER TABLE "worker_document" ALTER COLUMN "status" SET DEFAULT 'PENDING';
ALTER TABLE "worker_document" ALTER COLUMN "status" SET NOT NULL;

-- 4. Add database-level CHECK constraint enforcing canonical lifecycle values
ALTER TABLE "worker_document" DROP CONSTRAINT IF EXISTS "chk_worker_document_status";
ALTER TABLE "worker_document" ADD CONSTRAINT "chk_worker_document_status"
  CHECK ("status" IN ('PENDING', 'VERIFIED', 'REJECTED'));
