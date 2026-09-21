-- Migration: 20260922020000_canonical_refresh_session_lifecycle
-- Ensures refresh_session table has rotated_to_id and canonical status check constraint

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'refresh_session') THEN
    ALTER TABLE "refresh_session" ADD COLUMN IF NOT EXISTS "rotated_to_id" UUID;
    ALTER TABLE "refresh_session" DROP CONSTRAINT IF EXISTS "chk_refresh_session_status";
    ALTER TABLE "refresh_session" ADD CONSTRAINT "chk_refresh_session_status"
      CHECK ("status" IN ('ACTIVE', 'ROTATED', 'REVOKED', 'EXPIRED'));
  END IF;
END $$;
