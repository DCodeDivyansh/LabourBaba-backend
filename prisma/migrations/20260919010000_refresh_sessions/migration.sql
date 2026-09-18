-- Issue #10: Server-Side Refresh Sessions
--
-- Creates the refresh_session table to back server-side session management.
-- No existing data is affected; this is a pure additive migration.
--
-- Migration strategy:
--   Existing JWT refresh tokens issued before this migration will fail
--   the new opaque-token format check and return a safe 401. Users must
--   log in again after deployment. No data loss occurs.
--
-- Rollback:
--   DROP TABLE IF EXISTS refresh_session;

CREATE TABLE "refresh_session" (
  "id"             UUID        NOT NULL DEFAULT gen_random_uuid(),
  -- Polymorphic: worker.id or customer.id depending on user_role
  "user_id"        UUID        NOT NULL,
  -- worker | customer | admin
  "user_role"      VARCHAR(20) NOT NULL,
  -- bcrypt hash of the opaque secret. NEVER the raw token.
  "token_hash"     VARCHAR(255) NOT NULL,
  -- Shared across all rotations in a session chain. Used for family revocation.
  "family_id"      UUID        NOT NULL DEFAULT gen_random_uuid(),
  "device_id"      VARCHAR(255),
  "user_agent"     TEXT,
  "ip_address"     VARCHAR(50),
  -- ACTIVE | ROTATED | REVOKED
  "status"         VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "expires_at"     TIMESTAMPTZ NOT NULL,
  "last_used_at"   TIMESTAMPTZ,
  "rotated_at"     TIMESTAMPTZ,
  "revoked_at"     TIMESTAMPTZ,
  -- LOGOUT | REUSE | ADMIN | SUSPENDED
  "revoked_reason" VARCHAR(50),

  CONSTRAINT "refresh_session_pkey" PRIMARY KEY ("id")
);

-- Fast lookup by session ID (covered by PK)
-- Active sessions per user
CREATE INDEX "idx_refresh_session_user_status" ON "refresh_session"("user_id", "status");
-- Family revocation (reuse detection)
CREATE INDEX "idx_refresh_session_family" ON "refresh_session"("family_id");
-- Cleanup job: find old expired sessions
CREATE INDEX "idx_refresh_session_expires_at" ON "refresh_session"("expires_at");
-- Combined cleanup query
CREATE INDEX "idx_refresh_session_status_expires" ON "refresh_session"("status", "expires_at");

-- Partial index: fast lookup of active sessions for a user (most common query path)
CREATE INDEX "idx_refresh_session_user_active"
  ON "refresh_session"("user_id")
  WHERE "status" = 'ACTIVE';
