-- Migration: 20260923010000_p5_session_and_otp_hardening
-- Purpose: Enforce database-level invariants for P5 Issue 1 (Refresh Session) and Issue 2 (OTP Lifecycle)

DO $$
BEGIN
  -- 1. Unique index on rotated_to_id (ensures no two sessions rotate to the same successor)
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE tablename = 'refresh_session' AND indexname = 'uniq_refresh_session_rotated_to'
  ) THEN
    CREATE UNIQUE INDEX "uniq_refresh_session_rotated_to" 
    ON "refresh_session"("rotated_to_id") 
    WHERE "rotated_to_id" IS NOT NULL;
  END IF;

  -- 2. Foreign key for rotated_to_id referencing refresh_session(id) with DEFERRED constraint
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_refresh_session_rotated_to'
  ) THEN
    ALTER TABLE "refresh_session"
    ADD CONSTRAINT "fk_refresh_session_rotated_to"
    FOREIGN KEY ("rotated_to_id") REFERENCES "refresh_session"("id")
    ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED;
  END IF;

  -- 3. Affirm refresh_session CHECK constraint
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'refresh_session') THEN
    ALTER TABLE "refresh_session" DROP CONSTRAINT IF EXISTS "chk_refresh_session_status";
    ALTER TABLE "refresh_session" ADD CONSTRAINT "chk_refresh_session_status"
      CHECK ("status" IN ('ACTIVE', 'ROTATED', 'REVOKED', 'EXPIRED'));
  END IF;

  -- 4. Affirm otp_challenge CHECK constraint and partial unique index
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'otp_challenge') THEN
    ALTER TABLE "otp_challenge" DROP CONSTRAINT IF EXISTS "chk_otp_challenge_status";
    ALTER TABLE "otp_challenge" ADD CONSTRAINT "chk_otp_challenge_status"
      CHECK ("status" IN ('ACTIVE', 'CONSUMED', 'EXPIRED', 'LOCKED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE tablename = 'otp_challenge' AND indexname = 'uniq_active_otp_phone_purpose'
  ) THEN
    CREATE UNIQUE INDEX "uniq_active_otp_phone_purpose" 
    ON "otp_challenge"("phone", "purpose") 
    WHERE "status" = 'ACTIVE';
  END IF;
END $$;
