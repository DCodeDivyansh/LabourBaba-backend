-- CreateTable
CREATE TABLE "notification_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_type" VARCHAR(50) NOT NULL,
    "aggregate_type" VARCHAR(50) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "recipient_type" VARCHAR(30) NOT NULL,
    "recipient_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "idempotency_key" VARCHAR(255),
    "correlation_id" VARCHAR(255),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uniq_notification_outbox_idempotency_key" ON "notification_outbox"("idempotency_key");

-- CreateIndex
CREATE INDEX "idx_outbox_status_available" ON "notification_outbox"("status", "available_at");

-- CreateIndex
CREATE INDEX "idx_outbox_aggregate" ON "notification_outbox"("aggregate_type", "aggregate_id");

-- CreateIndex
CREATE INDEX "idx_outbox_recipient" ON "notification_outbox"("recipient_id");
