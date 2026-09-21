-- Migration: 20260921050000_harden_lifecycle_schema_fields
-- Purpose: Remediate Issue #31 by hardening lifecycle fields, making required status fields NOT NULL with defaults, and establishing database-level CHECK constraints.

-- 1. ENSURE worker_device columns exist
ALTER TABLE "worker_device" ADD COLUMN IF NOT EXISTS "fcm_token" TEXT;
ALTER TABLE "worker_device" ADD COLUMN IF NOT EXISTS "platform" VARCHAR(50) DEFAULT 'android';
ALTER TABLE "worker_device" ADD COLUMN IF NOT EXISTS "last_seen_at" TIMESTAMPTZ(6) DEFAULT NOW();
ALTER TABLE "worker_device" ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMPTZ(6);
ALTER TABLE "worker_device" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) DEFAULT NOW();
ALTER TABLE "worker_device" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) DEFAULT NOW();

-- 2. DATA BACKFILL: Clean up existing NULL values before setting NOT NULL
UPDATE "worker" SET "verification_status" = 'pending' WHERE "verification_status" IS NULL;
UPDATE "booking" SET "status" = 'CONFIRMED' WHERE "status" IS NULL;
UPDATE "booking" SET "updated_at" = NOW() WHERE "updated_at" IS NULL;
UPDATE "job" SET "status" = 'OPEN' WHERE "status" IS NULL;
UPDATE "job" SET "dispatch_status" = 'IDLE' WHERE "dispatch_status" IS NULL;
UPDATE "job" SET "created_at" = NOW() WHERE "created_at" IS NULL;
UPDATE "job" SET "updated_at" = NOW() WHERE "updated_at" IS NULL;
UPDATE "customer" SET "created_at" = NOW() WHERE "created_at" IS NULL;
UPDATE "job_dispatch" SET "status" = 'pending' WHERE "status" IS NULL;
UPDATE "job_dispatch" SET "updated_at" = NOW() WHERE "updated_at" IS NULL;
UPDATE "skill_category" SET "created_at" = NOW() WHERE "created_at" IS NULL;
UPDATE "skill_category" SET "updated_at" = NOW() WHERE "updated_at" IS NULL;
UPDATE "worker_device" SET "updated_at" = NOW() WHERE "updated_at" IS NULL;
UPDATE "worker_document" SET "status" = 'pending' WHERE "status" IS NULL;
UPDATE "dispatch_wave" SET "status" = 'active' WHERE "status" IS NULL;
UPDATE "dispatch_wave" SET "updated_at" = NOW() WHERE "updated_at" IS NULL;
UPDATE "job_requirement" SET "status" = 'OPEN' WHERE "status" IS NULL;
UPDATE "job_requirement" SET "updated_at" = NOW() WHERE "updated_at" IS NULL;

-- 3. ALTER TABLE: Enforce NOT NULL and DEFAULT constraints on lifecycle fields
ALTER TABLE "worker" ALTER COLUMN "verification_status" SET DEFAULT 'pending';
ALTER TABLE "worker" ALTER COLUMN "verification_status" SET NOT NULL;

ALTER TABLE "booking" ALTER COLUMN "status" SET DEFAULT 'CONFIRMED';
ALTER TABLE "booking" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "booking" ALTER COLUMN "updated_at" SET NOT NULL;

ALTER TABLE "job" ALTER COLUMN "status" SET DEFAULT 'OPEN';
ALTER TABLE "job" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "job" ALTER COLUMN "dispatch_status" SET DEFAULT 'IDLE';
ALTER TABLE "job" ALTER COLUMN "dispatch_status" SET NOT NULL;
ALTER TABLE "job" ALTER COLUMN "created_at" SET DEFAULT NOW();
ALTER TABLE "job" ALTER COLUMN "created_at" SET NOT NULL;
ALTER TABLE "job" ALTER COLUMN "updated_at" SET DEFAULT NOW();
ALTER TABLE "job" ALTER COLUMN "updated_at" SET NOT NULL;

ALTER TABLE "customer" ALTER COLUMN "created_at" SET DEFAULT NOW();
ALTER TABLE "customer" ALTER COLUMN "created_at" SET NOT NULL;

ALTER TABLE "job_dispatch" ALTER COLUMN "status" SET DEFAULT 'pending';
ALTER TABLE "job_dispatch" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "job_dispatch" ALTER COLUMN "updated_at" SET NOT NULL;

ALTER TABLE "skill_category" ALTER COLUMN "created_at" SET DEFAULT NOW();
ALTER TABLE "skill_category" ALTER COLUMN "created_at" SET NOT NULL;
ALTER TABLE "skill_category" ALTER COLUMN "updated_at" SET DEFAULT NOW();
ALTER TABLE "skill_category" ALTER COLUMN "updated_at" SET NOT NULL;

ALTER TABLE "worker_document" ALTER COLUMN "status" SET DEFAULT 'pending';
ALTER TABLE "worker_document" ALTER COLUMN "status" SET NOT NULL;

ALTER TABLE "dispatch_wave" ALTER COLUMN "status" SET DEFAULT 'active';
ALTER TABLE "dispatch_wave" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "dispatch_wave" ALTER COLUMN "updated_at" SET NOT NULL;

ALTER TABLE "job_requirement" ALTER COLUMN "status" SET DEFAULT 'OPEN';
ALTER TABLE "job_requirement" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "job_requirement" ALTER COLUMN "updated_at" SET NOT NULL;

-- 4. DATABASE-LEVEL CHECK CONSTRAINTS: Prevent invalid/typoed status values
ALTER TABLE "worker" DROP CONSTRAINT IF EXISTS "chk_worker_verification_status";
ALTER TABLE "worker" ADD CONSTRAINT "chk_worker_verification_status"
  CHECK ("verification_status" IN ('pending', 'verified', 'rejected', 'suspended'));

ALTER TABLE "booking" DROP CONSTRAINT IF EXISTS "chk_booking_status";
ALTER TABLE "booking" ADD CONSTRAINT "chk_booking_status"
  CHECK ("status" IN ('CONFIRMED', 'IN_PROGRESS', 'AWAITING_CONFIRMATION', 'COMPLETED', 'CANCELLED', 'pending', 'confirmed', 'in_progress', 'completion_requested', 'completed', 'cancelled'));

ALTER TABLE "job" DROP CONSTRAINT IF EXISTS "chk_job_status";
ALTER TABLE "job" ADD CONSTRAINT "chk_job_status"
  CHECK ("status" IN ('OPEN', 'DISPATCHING', 'BOOKED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'open', 'dispatching', 'booked', 'in_progress', 'completed', 'cancelled'));

ALTER TABLE "job" DROP CONSTRAINT IF EXISTS "chk_job_dispatch_status";
ALTER TABLE "job" ADD CONSTRAINT "chk_job_dispatch_status"
  CHECK ("dispatch_status" IN ('PENDING', 'pending', 'IDLE', 'idle', 'DISPATCHING', 'dispatching', 'PARTIALLY_FILLED', 'partially_filled', 'FILLED', 'filled', 'EXHAUSTED', 'exhausted', 'FAILED', 'failed', 'fully_booked'));

ALTER TABLE "job_requirement" DROP CONSTRAINT IF EXISTS "chk_job_requirement_status";
ALTER TABLE "job_requirement" ADD CONSTRAINT "chk_job_requirement_status"
  CHECK ("status" IN ('OPEN', 'DISPATCHING', 'PARTIALLY_FILLED', 'FILLED', 'NO_WORKERS_AVAILABLE', 'CANCELLED', 'open', 'dispatching', 'partially_filled', 'filled', 'no_workers_available', 'cancelled'));

ALTER TABLE "job_dispatch" DROP CONSTRAINT IF EXISTS "chk_job_dispatch_status";
ALTER TABLE "job_dispatch" ADD CONSTRAINT "chk_job_dispatch_status"
  CHECK ("status" IN ('pending', 'accepted', 'declined', 'expired', 'timeout', 'cancelled', 'PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'TIMEOUT', 'CANCELLED'));

ALTER TABLE "dispatch_wave" DROP CONSTRAINT IF EXISTS "chk_dispatch_wave_status";
ALTER TABLE "dispatch_wave" ADD CONSTRAINT "chk_dispatch_wave_status"
  CHECK ("status" IN ('active', 'pending', 'dispatching', 'resolved', 'filled', 'exhausted', 'expired', 'cancelled', 'ACTIVE', 'PENDING', 'DISPATCHING', 'RESOLVED', 'FILLED', 'EXHAUSTED', 'EXPIRED', 'CANCELLED'));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'otp_challenge') THEN
    ALTER TABLE "otp_challenge" DROP CONSTRAINT IF EXISTS "chk_otp_challenge_status";
    ALTER TABLE "otp_challenge" ADD CONSTRAINT "chk_otp_challenge_status"
      CHECK ("status" IN ('ACTIVE', 'CONSUMED', 'EXPIRED', 'LOCKED'));
  END IF;
  
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'refresh_session') THEN
    ALTER TABLE "refresh_session" DROP CONSTRAINT IF EXISTS "chk_refresh_session_status";
    ALTER TABLE "refresh_session" ADD CONSTRAINT "chk_refresh_session_status"
      CHECK ("status" IN ('ACTIVE', 'REVOKED', 'EXPIRED'));
  END IF;
END $$;
