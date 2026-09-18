-- Migration: Complete WorkerDevice Lifecycle
-- Enhances worker_device with canonical push identity, lifecycle timestamps, constraints, and backfills legacy worker.device_token

-- 1. Add columns to worker_device if not existing
ALTER TABLE "worker_device"
  ADD COLUMN IF NOT EXISTS "fcm_token" TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "platform" VARCHAR(50) NOT NULL DEFAULT 'android',
  ADD COLUMN IF NOT EXISTS "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 2. Populate null device_id with UUID and enforce NOT NULL
UPDATE "worker_device"
SET "device_id" = id::text
WHERE "device_id" IS NULL;

ALTER TABLE "worker_device"
  ALTER COLUMN "device_id" SET NOT NULL;

-- 3. Backfill legacy worker.device_token into worker_device
INSERT INTO "worker_device" ("id", "worker_id", "device_id", "fcm_token", "platform", "last_seen_at", "created_at", "updated_at")
SELECT
  gen_random_uuid(),
  "id",
  gen_random_uuid()::text,
  "device_token",
  'android',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "worker"
WHERE "device_token" IS NOT NULL AND "device_token" != ''
ON CONFLICT DO NOTHING;

-- 4. Add unique constraint and performance indexes
ALTER TABLE "worker_device"
  DROP CONSTRAINT IF EXISTS "uq_worker_device_worker_device";

ALTER TABLE "worker_device"
  ADD CONSTRAINT "uq_worker_device_worker_device" UNIQUE ("worker_id", "device_id");

CREATE INDEX IF NOT EXISTS "idx_worker_device_active" ON "worker_device" ("worker_id", "revoked_at");
CREATE INDEX IF NOT EXISTS "idx_worker_device_fcm_token" ON "worker_device" ("fcm_token");
