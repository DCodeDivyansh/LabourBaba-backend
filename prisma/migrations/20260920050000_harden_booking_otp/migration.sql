-- Migration: 20260920050000_harden_booking_otp
-- Description: Add expiry, attempt counters, lock state, consumption timestamps, and verification audit columns to booking table.

-- 1. Add OTP hardening columns to booking table
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "otp_expires_at" TIMESTAMPTZ(6);
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "otp_attempts" INTEGER DEFAULT 0;
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "otp_locked_at" TIMESTAMPTZ(6);
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "otp_consumed_at" TIMESTAMPTZ(6);
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "verified_at" TIMESTAMPTZ(6);
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "verified_by" VARCHAR(100);

-- 2. Backfill null attempt counts for existing bookings
UPDATE "booking" SET "otp_attempts" = 0 WHERE "otp_attempts" IS NULL;
