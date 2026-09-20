-- Issue #13: Finish OTP Abuse Controls - Database Index Optimization
--
-- Adds composite index on (phone, purpose, status) and (created_at)
-- to optimize active challenge verification and resend cooldown lookups under high concurrency.

CREATE INDEX IF NOT EXISTS "idx_otp_challenge_phone_purpose_status"
  ON "otp_challenge"("phone", "purpose", "status");

CREATE INDEX IF NOT EXISTS "idx_otp_challenge_created_at"
  ON "otp_challenge"("created_at");
