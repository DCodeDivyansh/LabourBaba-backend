-- Migration: 20260918030000_payment_webhook_event
-- Purpose: Add payment_webhook_event table for database-backed webhook replay protection.
--
-- Security motivation (Issue #12):
--   Without this table, duplicate or concurrent webhook deliveries (provider retries,
--   multiple app instances, or network re-delivery) can each independently trigger the
--   same payment state transition.  The (provider, provider_event_id) UNIQUE constraint
--   is the authoritative database-level guard: only one INSERT can succeed; all
--   concurrent or replayed INSERTs receive a unique-constraint error and are treated
--   as safe duplicates.
--
-- This migration is fully additive and backward-compatible:
--   - No existing tables are modified.
--   - No existing data is touched.
--   - The new table starts empty; there are no FK dependencies blocking deployment.
--
-- Idempotency identity scheme (see PaymentWebhookEvent model in schema.prisma):
--   payment.captured  → provider_event_id = Razorpay payment entity ID  (pay_xxx)
--   payment.failed    → provider_event_id = razorpay_order_id + ":failed"
--   other events      → provider_event_id = razorpay_order_id + ":" + event_type

CREATE TABLE IF NOT EXISTS "payment_webhook_event" (
    "id"               UUID          NOT NULL DEFAULT gen_random_uuid(),
    "provider"         VARCHAR(50)   NOT NULL,
    "providerEventId"  VARCHAR(512)  NOT NULL,
    "eventType"        VARCHAR(100)  NOT NULL,
    "status"           VARCHAR(30)   NOT NULL,
    "failureReason"    TEXT,
    "receivedAt"       TIMESTAMPTZ   NOT NULL DEFAULT now(),
    "processedAt"      TIMESTAMPTZ,

    CONSTRAINT "payment_webhook_event_pkey" PRIMARY KEY ("id")
);

-- The critical uniqueness invariant: one row per (provider, providerEventId).
-- This is safe under concurrent INSERT from multiple processes/instances:
-- PostgreSQL's unique index guarantees that exactly one INSERT wins; all others
-- receive an error that the application maps to "already processed".
CREATE UNIQUE INDEX IF NOT EXISTS "payment_webhook_event_provider_providerEventId_key"
    ON "payment_webhook_event"("provider", "providerEventId");

-- Index for operational monitoring: allows efficient lookup of recent events.
CREATE INDEX IF NOT EXISTS "idx_webhook_event_received_at"
    ON "payment_webhook_event"("receivedAt");
