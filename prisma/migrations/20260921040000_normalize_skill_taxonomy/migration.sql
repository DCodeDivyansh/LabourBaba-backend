-- AlterTable skill_category
ALTER TABLE "skill_category" ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN DEFAULT true;
ALTER TABLE "skill_category" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "skill_category" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP;

-- CreateTable worker_skill
CREATE TABLE IF NOT EXISTS "worker_skill" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "worker_id" UUID NOT NULL,
    "skill_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_skill_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uniq_worker_skill" UNIQUE ("worker_id", "skill_id"),
    CONSTRAINT "fk_worker_skill_worker" FOREIGN KEY ("worker_id") REFERENCES "worker"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "fk_worker_skill_category" FOREIGN KEY ("skill_id") REFERENCES "skill_category"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateIndexes for worker_skill
CREATE INDEX IF NOT EXISTS "idx_worker_skill_worker" ON "worker_skill"("worker_id");
CREATE INDEX IF NOT EXISTS "idx_worker_skill_skill" ON "worker_skill"("skill_id");

-- AlterTable job_requirement
ALTER TABLE "job_requirement" ADD COLUMN IF NOT EXISTS "skill_id" UUID;

-- AddForeignKey and Index for job_requirement.skill_id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_requirement_skill_category'
    ) THEN
        ALTER TABLE "job_requirement" ADD CONSTRAINT "fk_requirement_skill_category" 
        FOREIGN KEY ("skill_id") REFERENCES "skill_category"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_requirement_skill_id" ON "job_requirement"("skill_id");

-- CreateTable job_requirement_skill
CREATE TABLE IF NOT EXISTS "job_requirement_skill" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "requirement_id" UUID NOT NULL,
    "skill_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_requirement_skill_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uniq_job_requirement_skill" UNIQUE ("requirement_id", "skill_id"),
    CONSTRAINT "fk_req_skill_requirement" FOREIGN KEY ("requirement_id") REFERENCES "job_requirement"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "fk_req_skill_category" FOREIGN KEY ("skill_id") REFERENCES "skill_category"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateIndexes for job_requirement_skill
CREATE INDEX IF NOT EXISTS "idx_job_requirement_skill_req" ON "job_requirement_skill"("requirement_id");
CREATE INDEX IF NOT EXISTS "idx_job_requirement_skill_skill" ON "job_requirement_skill"("skill_id");

-- Data Backfill: Populate worker_skill for all existing workers with skill_category_id
INSERT INTO "worker_skill" ("worker_id", "skill_id")
SELECT "id", "skill_category_id"
FROM "worker"
WHERE "skill_category_id" IS NOT NULL
ON CONFLICT ("worker_id", "skill_id") DO NOTHING;

-- Data Backfill: Resolve job_requirement.skill_id from skill_category match
UPDATE "job_requirement" jr
SET "skill_id" = sc."id"
FROM "skill_category" sc
WHERE jr."skill_id" IS NULL
  AND jr."skill_type" IS NOT NULL
  AND (
    LOWER(TRIM(jr."skill_type")) = LOWER(TRIM(sc."name"))
    OR jr."skill_type" = sc."id"::text
  );

-- Data Backfill: Populate job_requirement_skill for all resolved job_requirements
INSERT INTO "job_requirement_skill" ("requirement_id", "skill_id")
SELECT "id", "skill_id"
FROM "job_requirement"
WHERE "skill_id" IS NOT NULL
ON CONFLICT ("requirement_id", "skill_id") DO NOTHING;
