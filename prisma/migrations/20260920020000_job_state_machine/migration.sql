-- Migration: 20260920020000_job_state_machine
-- Description: Add lifecycle metadata columns to job table and create job_transition table for state machine audit history.

-- 1. Add lifecycle timestamp and actor tracking columns to job table
ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "cancelled_at" TIMESTAMPTZ(6);
ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "cancelled_by" VARCHAR(100);
ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMPTZ(6);

-- 2. Add composite index for status queries
CREATE INDEX IF NOT EXISTS "idx_job_status_customer" ON "job"("status", "customer_id");

-- 3. Create job_transition table for durable state machine history
CREATE TABLE IF NOT EXISTS "job_transition" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" UUID NOT NULL,
    "from_status" VARCHAR(30) NOT NULL,
    "to_status" VARCHAR(30) NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "actor_type" VARCHAR(30) NOT NULL,
    "actor_id" VARCHAR(100),
    "reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_transition_pkey" PRIMARY KEY ("id")
);

-- 4. Foreign key constraint with cascade on delete
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_transition_job'
    ) THEN
        ALTER TABLE "job_transition"
        ADD CONSTRAINT "fk_transition_job"
        FOREIGN KEY ("job_id")
        REFERENCES "job"("id")
        ON DELETE CASCADE
        ON UPDATE NO ACTION;
    END IF;
END $$;

-- 5. Index for fast transition history lookup by job_id and created_at
CREATE INDEX IF NOT EXISTS "idx_job_transition_job_id" ON "job_transition"("job_id", "created_at");
