-- Migration: 20260920090000_dispatch_idempotency_constraints
-- Ensures database-level uniqueness for dispatch waves and worker dispatches.

-- 1. Unique constraint on dispatch_wave(requirement_id, wave_number)
-- Guarantees that at-least-once BullMQ redeliveries or concurrent workers cannot insert duplicate waves for a requirement.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_dispatch_wave_req_wave" ON "dispatch_wave"("requirement_id", "wave_number");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uniq_dispatch_wave_req_wave'
    ) THEN
        ALTER TABLE "dispatch_wave" ADD CONSTRAINT "uniq_dispatch_wave_req_wave" UNIQUE USING INDEX "uniq_dispatch_wave_req_wave";
    END IF;
END $$;

-- 2. Unique constraint on job_dispatch(requirement_id, worker_id)
-- Guarantees that a worker is never dispatched twice for the same requirement across any wave.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_job_dispatch_req_worker" ON "job_dispatch"("requirement_id", "worker_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uniq_job_dispatch_req_worker'
    ) THEN
        ALTER TABLE "job_dispatch" ADD CONSTRAINT "uniq_job_dispatch_req_worker" UNIQUE USING INDEX "uniq_job_dispatch_req_worker";
    END IF;
END $$;
