-- AlterTable notification_outbox: Add aggregate_version, socket_status, socket_sent_at, socket_error, fcm_status, fcm_sent_at, fcm_error
ALTER TABLE "notification_outbox" 
ADD COLUMN IF NOT EXISTS "aggregate_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS "socket_status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
ADD COLUMN IF NOT EXISTS "socket_sent_at" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS "socket_error" TEXT,
ADD COLUMN IF NOT EXISTS "fcm_status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
ADD COLUMN IF NOT EXISTS "fcm_sent_at" TIMESTAMPTZ(6),
ADD COLUMN IF NOT EXISTS "fcm_error" TEXT;

-- Backfill existing rows safely without modifying production data
UPDATE "notification_outbox"
SET "socket_status" = 'SENT',
    "socket_sent_at" = "processed_at",
    "fcm_status" = 'SENT',
    "fcm_sent_at" = "processed_at"
WHERE "status" = 'SENT' AND "socket_status" = 'PENDING';

UPDATE "notification_outbox"
SET "socket_status" = 'FAILED',
    "socket_error" = "last_error",
    "fcm_status" = 'FAILED',
    "fcm_error" = "last_error"
WHERE "status" = 'FAILED' AND "socket_status" = 'PENDING';

-- Create notification_delivery table
CREATE TABLE IF NOT EXISTS "notification_delivery" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "channel" VARCHAR(30) NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_delivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_notification_delivery_event" FOREIGN KEY ("event_id") REFERENCES "notification_outbox"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- Unique constraint enforcing idempotency across event, recipient, and channel
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_notification_delivery_event_recipient_channel" 
ON "notification_delivery"("event_id", "recipient_id", "channel");

-- Indexes for efficient lookups
CREATE INDEX IF NOT EXISTS "idx_notification_delivery_event_id" 
ON "notification_delivery"("event_id");

CREATE INDEX IF NOT EXISTS "idx_notification_delivery_recipient_channel_status" 
ON "notification_delivery"("recipient_id", "channel", "status");
