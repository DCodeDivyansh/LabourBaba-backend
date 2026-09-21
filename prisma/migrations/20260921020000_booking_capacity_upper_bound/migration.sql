-- Issue #24: the persisted requirement capacity ledger must never exceed demand.
-- Existing rows were already normalized by the requirement-state migration; the
-- clamp makes this migration safe for legacy null/overfilled counters without
-- changing bookings. The acceptance/cancellation transaction is responsible for
-- keeping the counter equal to capacity-consuming bookings going forward.
UPDATE "job_requirement"
SET "worker_count_filled" = LEAST(
  GREATEST(COALESCE("worker_count_filled", 0), 0),
  "worker_count_needed"
);

ALTER TABLE "job_requirement"
  ALTER COLUMN "worker_count_filled" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_job_requirement_worker_count_capacity'
  ) THEN
    ALTER TABLE "job_requirement"
      ADD CONSTRAINT "chk_job_requirement_worker_count_capacity"
      CHECK (
        "worker_count_filled" >= 0
        AND "worker_count_filled" <= "worker_count_needed"
      );
  END IF;
END $$;
