-- Migration: 20260924000000_customer_notification_and_device_lifecycle
-- Purpose: Add customer_device lifecycle and customer notification delivery/acknowledgement semantics (P6 Issue 5)

CREATE TABLE IF NOT EXISTS "customer_device" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "customer_id" UUID NOT NULL,
    "device_id" VARCHAR(255) NOT NULL,
    "fcm_token" TEXT NOT NULL,
    "platform" VARCHAR(50) NOT NULL DEFAULT 'android',
    "ip_address" VARCHAR(50),
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_device_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_device_customer" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- Unique constraint on (customer_id, device_id)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_customer_device_customer_device'
    ) THEN
        ALTER TABLE "customer_device" ADD CONSTRAINT "uq_customer_device_customer_device" UNIQUE ("customer_id", "device_id");
    END IF;
END $$;

-- Indexes on customer_device
CREATE INDEX IF NOT EXISTS "idx_customer_device_active" ON "customer_device"("customer_id", "revoked_at");
CREATE INDEX IF NOT EXISTS "idx_customer_device_fcm_token" ON "customer_device"("fcm_token");

-- Add acknowledged_at and acknowledged_by columns to notification_outbox
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'notification_outbox' AND column_name = 'acknowledged_at'
    ) THEN
        ALTER TABLE "notification_outbox" ADD COLUMN "acknowledged_at" TIMESTAMPTZ(6);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'notification_outbox' AND column_name = 'acknowledged_by'
    ) THEN
        ALTER TABLE "notification_outbox" ADD COLUMN "acknowledged_by" VARCHAR(100);
    END IF;
END $$;

-- Indexes for customer notification recovery & acknowledgement
CREATE INDEX IF NOT EXISTS "idx_outbox_recipient_status_created" ON "notification_outbox"("recipient_type", "recipient_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "idx_outbox_recipient_acknowledged" ON "notification_outbox"("recipient_type", "recipient_id", "acknowledged_at");
