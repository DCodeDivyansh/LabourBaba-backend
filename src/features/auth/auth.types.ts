/**
 * auth.types.ts
 *
 * Canonical OTP & Authentication types and status constants.
 */

// ── Canonical OTP Status State Machine ─────────────────────────────────────────
// Exactly 4 canonical states matching PostgreSQL constraint chk_otp_challenge_status:
//   ACTIVE   → Live challenge, verifiable within TTL
//   CONSUMED → Successfully verified and consumed for authentication (Terminal)
//   EXPIRED  → Prematurely expired on resend, failed delivery, or elapsed TTL (Terminal)
//   LOCKED   → Exceeded maximum failed verification attempts (Terminal)
export const OTP_STATUS = {
  ACTIVE: "ACTIVE",
  CONSUMED: "CONSUMED",
  EXPIRED: "EXPIRED",
  LOCKED: "LOCKED",
} as const;

export type OtpStatus = typeof OTP_STATUS[keyof typeof OTP_STATUS];
