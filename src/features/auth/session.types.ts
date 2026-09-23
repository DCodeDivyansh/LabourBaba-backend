import { UserRole } from "../../type/userRole";

// ── Raw token format ─────────────────────────────────────────────────────────
// Opaque bearer credential returned to the client:
//   <session_id_uuid>.<64-char-hex-secret>
// The session_id prefix enables O(1) DB lookup; the secret is bcrypt-verified.
export const REFRESH_TOKEN_SEPARATOR = ".";
export const REFRESH_SECRET_BYTES = 32; // → 64 hex chars

// ── Session status constants ─────────────────────────────────────────────────
export const SESSION_STATUS = {
  ACTIVE: "ACTIVE",
  ROTATED: "ROTATED",
  REVOKED: "REVOKED",
  EXPIRED: "EXPIRED",
} as const;
export type SessionStatus = typeof SESSION_STATUS[keyof typeof SESSION_STATUS];

// ── Revocation reason constants ──────────────────────────────────────────────
export const REVOKE_REASON = {
  LOGOUT: "LOGOUT",
  REUSE: "REUSE",
  ADMIN: "ADMIN",
  SUSPENDED: "SUSPENDED",
  /** Used when sessions/tokens may have been exposed in a security incident. */
  SECURITY_INCIDENT: "SECURITY_INCIDENT",
} as const;
export type RevokeReason = typeof REVOKE_REASON[keyof typeof REVOKE_REASON];

// ── CreateSession options ────────────────────────────────────────────────────
export interface CreateSessionOptions {
  userId: string;
  userRole: UserRole;
  deviceId?: string;
  userAgent?: string;
  ipAddress?: string;
  /** Override default TTL in days */
  ttlDays?: number;
}

// ── Result of createSession ──────────────────────────────────────────────────
export interface CreateSessionResult {
  /** The opaque token to return to the client. NEVER persist this. */
  rawToken: string;
  sessionId: string;
  expiresAt: Date;
}

// ── Result of rotateSession ──────────────────────────────────────────────────
export interface RotateSessionResult {
  newRawToken: string;
  newSessionId: string;
  expiresAt: Date;
  userId: string;
  userRole: UserRole;
}

// ── Safe session DTO (returned to client for session management UI) ───────────
export interface SessionDTO {
  id: string;
  user_id?: string;
  user_role?: string;
  device_id: string | null;
  user_agent: string | null;
  ip_address: string | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date;
  status: string;
  rotated_to_id?: string | null;
}

