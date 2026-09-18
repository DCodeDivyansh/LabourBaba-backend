-- Migration: 20260918020000_payment_provider_fields
-- Purpose: Add real Razorpay provider fields to the payment table.
-- These fields are all nullable to ensure backward compatibility with existing records.
-- No existing data is modified.

-- Step 1: Add razorpay_payment_id (populated by webhook on payment.captured)
ALTER TABLE "payment" ADD COLUMN IF NOT EXISTS "razorpay_payment_id" VARCHAR(255);

-- Step 2: Add currency column with default INR for all new and existing records
ALTER TABLE "payment" ADD COLUMN IF NOT EXISTS "currency" VARCHAR(10) NOT NULL DEFAULT 'INR';

-- Step 3: Add idempotency_key (= booking_id as text, enforces one order per booking).
-- Existing payment records will have NULL — this is safe: uniqueness only blocks future inserts.
ALTER TABLE "payment" ADD COLUMN IF NOT EXISTS "idempotency_key" VARCHAR(255);

-- Step 4: Create unique index on idempotency_key (NULLs are excluded from uniqueness by PostgreSQL).
-- This prevents concurrent duplicate payment order creation for the same booking.
CREATE UNIQUE INDEX IF NOT EXISTS "payment_idempotency_key_key" ON "payment"("idempotency_key");
