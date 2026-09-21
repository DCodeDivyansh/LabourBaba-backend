-- AlterTable: Add canonical last_location_at to worker table
ALTER TABLE "worker" ADD COLUMN IF NOT EXISTS "last_location_at" TIMESTAMPTZ(6);

-- CreateIndex: Index for efficient location freshness queries on worker
CREATE INDEX IF NOT EXISTS "idx_worker_last_location_at" ON "worker"("last_location_at");

-- Data Migration / Backfill:
-- 1. Backfill last_location_at from latest worker_location history where available
UPDATE "worker" w
SET "last_location_at" = sub.max_updated
FROM (
  SELECT worker_id, MAX(updated_at) AS max_updated
  FROM "worker_location"
  GROUP BY worker_id
) sub
WHERE w.id = sub.worker_id AND w.location_geo IS NOT NULL AND w.last_location_at IS NULL;

-- 2. Fallback for workers with active location_geo but no history row
UPDATE "worker"
SET "last_location_at" = NOW()
WHERE "location_geo" IS NOT NULL AND "last_location_at" IS NULL;
