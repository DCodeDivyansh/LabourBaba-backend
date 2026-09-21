-- AlterTable: worker_location indexes for bounded query and retention cleanup
CREATE INDEX IF NOT EXISTS "idx_worker_location_updated_at" ON "worker_location"("updated_at");
CREATE INDEX IF NOT EXISTS "idx_worker_location_worker_updated_at" ON "worker_location"("worker_id", "updated_at");

-- CreateTable: audit_log for administrative and security event auditing
CREATE TABLE IF NOT EXISTS "audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor_id" VARCHAR(100) NOT NULL,
    "actor_role" VARCHAR(30) NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "target_type" VARCHAR(50) NOT NULL,
    "target_id" VARCHAR(100) NOT NULL,
    "reason" TEXT,
    "correlation_id" VARCHAR(255),
    "ip_address" VARCHAR(50),
    "user_agent" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex for audit_log
CREATE INDEX IF NOT EXISTS "idx_audit_log_action_created" ON "audit_log"("action", "created_at");
CREATE INDEX IF NOT EXISTS "idx_audit_log_actor_created" ON "audit_log"("actor_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_audit_log_target" ON "audit_log"("target_type", "target_id");
CREATE INDEX IF NOT EXISTS "idx_audit_log_correlation" ON "audit_log"("correlation_id");
