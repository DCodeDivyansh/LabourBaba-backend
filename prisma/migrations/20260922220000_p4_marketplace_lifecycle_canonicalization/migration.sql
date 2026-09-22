-- Migration: 20260922220000_p4_marketplace_lifecycle_canonicalization
-- Purpose: Remediate P4 Issue 15 by migrating legacy lifecycle values and enforcing single canonical casing in PostgreSQL via CHECK constraints.

-- 1. DATA NORMALIZATION: Explicit deterministic mapping of existing legacy values to canonical representations
-- job.dispatch_status normalization
UPDATE "job" SET "dispatch_status" = 'FILLED' WHERE UPPER("dispatch_status") = 'FULLY_BOOKED';
UPDATE "job" SET "dispatch_status" = 'IDLE' WHERE UPPER("dispatch_status") = 'PENDING';
UPDATE "job" SET "dispatch_status" = UPPER("dispatch_status") WHERE "dispatch_status" IS NOT NULL;
UPDATE "job" SET "dispatch_status" = 'IDLE' WHERE "dispatch_status" NOT IN ('IDLE', 'DISPATCHING', 'PARTIALLY_FILLED', 'FILLED', 'EXHAUSTED', 'FAILED', 'CANCELLED');

-- job.status normalization
UPDATE "job" SET "status" = UPPER("status") WHERE "status" IS NOT NULL;
UPDATE "job" SET "status" = 'OPEN' WHERE "status" NOT IN ('OPEN', 'DISPATCHING', 'BOOKED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- job_requirement.status normalization
UPDATE "job_requirement" SET "status" = UPPER("status") WHERE "status" IS NOT NULL;
UPDATE "job_requirement" SET "status" = 'OPEN' WHERE "status" NOT IN ('OPEN', 'DISPATCHING', 'PARTIALLY_FILLED', 'FILLED', 'NO_WORKERS_AVAILABLE', 'CANCELLED');

-- booking.status normalization
UPDATE "booking" SET "status" = UPPER("status") WHERE "status" IS NOT NULL;
UPDATE "booking" SET "status" = 'CONFIRMED' WHERE "status" NOT IN ('CONFIRMED', 'IN_PROGRESS', 'AWAITING_CONFIRMATION', 'COMPLETED', 'CANCELLED');

-- job_dispatch.status normalization (Strictly lowercase)
UPDATE "job_dispatch" SET "status" = LOWER("status") WHERE "status" IS NOT NULL;
UPDATE "job_dispatch" SET "status" = 'pending' WHERE "status" NOT IN ('pending', 'accepted', 'declined', 'timeout', 'cancelled', 'expired');

-- dispatch_wave.status normalization (Strictly lowercase)
UPDATE "dispatch_wave" SET "status" = LOWER("status") WHERE "status" IS NOT NULL;
UPDATE "dispatch_wave" SET "status" = 'active' WHERE "status" NOT IN ('active', 'completed', 'cancelled', 'timeout', 'exhausted', 'expired', 'resolved', 'filled', 'pending', 'dispatching');

-- 2. ENSURE NOT NULL and DEFAULTS
ALTER TABLE "job" ALTER COLUMN "status" SET DEFAULT 'OPEN';
ALTER TABLE "job" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "job" ALTER COLUMN "dispatch_status" SET DEFAULT 'IDLE';
ALTER TABLE "job" ALTER COLUMN "dispatch_status" SET NOT NULL;

ALTER TABLE "job_requirement" ALTER COLUMN "status" SET DEFAULT 'OPEN';
ALTER TABLE "job_requirement" ALTER COLUMN "status" SET NOT NULL;

ALTER TABLE "booking" ALTER COLUMN "status" SET DEFAULT 'CONFIRMED';
ALTER TABLE "booking" ALTER COLUMN "status" SET NOT NULL;

ALTER TABLE "job_dispatch" ALTER COLUMN "status" SET DEFAULT 'pending';
ALTER TABLE "job_dispatch" ALTER COLUMN "status" SET NOT NULL;

ALTER TABLE "dispatch_wave" ALTER COLUMN "status" SET DEFAULT 'active';
ALTER TABLE "dispatch_wave" ALTER COLUMN "status" SET NOT NULL;

-- 3. CANONICAL DATABASE-LEVEL CHECK CONSTRAINTS (Single Casing Only)
-- job.status (Strictly Uppercase)
ALTER TABLE "job" DROP CONSTRAINT IF EXISTS "chk_job_status";
ALTER TABLE "job" ADD CONSTRAINT "chk_job_status"
  CHECK ("status" IN ('OPEN', 'DISPATCHING', 'BOOKED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'));

-- job.dispatch_status (Strictly Uppercase)
ALTER TABLE "job" DROP CONSTRAINT IF EXISTS "chk_job_dispatch_status";
ALTER TABLE "job" ADD CONSTRAINT "chk_job_dispatch_status"
  CHECK ("dispatch_status" IN ('IDLE', 'DISPATCHING', 'PARTIALLY_FILLED', 'FILLED', 'EXHAUSTED', 'FAILED', 'CANCELLED'));

-- job_requirement.status (Strictly Uppercase)
ALTER TABLE "job_requirement" DROP CONSTRAINT IF EXISTS "chk_job_requirement_status";
ALTER TABLE "job_requirement" ADD CONSTRAINT "chk_job_requirement_status"
  CHECK ("status" IN ('OPEN', 'DISPATCHING', 'PARTIALLY_FILLED', 'FILLED', 'NO_WORKERS_AVAILABLE', 'CANCELLED'));

-- booking.status (Strictly Uppercase)
ALTER TABLE "booking" DROP CONSTRAINT IF EXISTS "chk_booking_status";
ALTER TABLE "booking" ADD CONSTRAINT "chk_booking_status"
  CHECK ("status" IN ('CONFIRMED', 'IN_PROGRESS', 'AWAITING_CONFIRMATION', 'COMPLETED', 'CANCELLED'));

-- job_dispatch.status (Strictly Lowercase)
ALTER TABLE "job_dispatch" DROP CONSTRAINT IF EXISTS "chk_job_dispatch_status";
ALTER TABLE "job_dispatch" ADD CONSTRAINT "chk_job_dispatch_status"
  CHECK ("status" IN ('pending', 'accepted', 'declined', 'timeout', 'cancelled', 'expired'));

-- dispatch_wave.status (Strictly Lowercase)
ALTER TABLE "dispatch_wave" DROP CONSTRAINT IF EXISTS "chk_dispatch_wave_status";
ALTER TABLE "dispatch_wave" ADD CONSTRAINT "chk_dispatch_wave_status"
  CHECK ("status" IN ('active', 'completed', 'cancelled', 'timeout', 'exhausted', 'expired', 'resolved', 'filled', 'pending', 'dispatching'));
