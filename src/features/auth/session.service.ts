/**
 * session.service.ts
 *
 * Issue #10 — Server-Side Refresh Sessions
 *
 * Provides the canonical server-side session lifecycle:
 *   createSession  → login
 *   rotateSession  → refresh (atomic, concurrency-safe)
 *   revokeSession  → logout / admin revoke
 *   revokeFamilyBySessionId → reuse detection
 *   listActiveSessions → session management UI
 *   cleanupExpiredSessions → maintenance
 *
 * Security invariants enforced here:
 *   1. Raw token NEVER persisted — only bcrypt hash of secret.
 *   2. Token lookup is O(1) by session UUID (PK), then constant-time bcrypt verify.
 *   3. Rotation is atomic: UPDATE WHERE status=ACTIVE → 0 rows = reuse detected.
 *   4. Reuse revokes the entire token family.
 *   5. Suspended/deleted user check is the caller's responsibility (login path).
 */

import crypto from "crypto";
import bcrypt from "bcrypt";
import prisma from "../../config/prisma";
import { UserRole } from "../../type/userRole";
import { maskPhone } from "../../utils/authUtils";
import { logger } from "../../utils/logger";
import {
  REFRESH_TOKEN_SEPARATOR,
  REFRESH_SECRET_BYTES,
  SESSION_STATUS,
  REVOKE_REASON,
  CreateSessionOptions,
  CreateSessionResult,
  RotateSessionResult,
  RevokeReason,
  SessionDTO,
} from "./session.types";
import { getRefreshSessionConfig } from "../../config/authConfig";

const BCRYPT_ROUNDS = 10;

// ── Token helpers ─────────────────────────────────────────────────────────────

function generateRawSecret(): string {
  return crypto.randomBytes(REFRESH_SECRET_BYTES).toString("hex");
}

function buildRawToken(sessionId: string, secret: string): string {
  return `${sessionId}${REFRESH_TOKEN_SEPARATOR}${secret}`;
}

function parseRawToken(rawToken: string): { sessionId: string; secret: string } | null {
  const idx = rawToken.indexOf(REFRESH_TOKEN_SEPARATOR);
  if (idx <= 0) return null;
  const sessionId = rawToken.slice(0, idx);
  const secret = rawToken.slice(idx + 1);
  // Basic shape validation
  if (!sessionId || !secret || secret.length !== REFRESH_SECRET_BYTES * 2) return null;
  // UUID format guard
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(sessionId)) return null;
  return { sessionId, secret };
}

// ── Session Service ───────────────────────────────────────────────────────────

export const sessionService = {
  /**
   * Creates a server-side refresh session and returns the opaque raw token.
   * Called on every successful login.
   */
  async createSession(opts: CreateSessionOptions): Promise<CreateSessionResult> {
    const cfg = getRefreshSessionConfig();
    const ttlDays = opts.ttlDays ?? cfg.refreshSessionTtlDays;
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

    const secret = generateRawSecret();
    const tokenHash = await bcrypt.hash(secret, BCRYPT_ROUNDS);
    const familyId = crypto.randomUUID();

    const session = await prisma.refresh_session.create({
      data: {
        user_id: opts.userId,
        user_role: opts.userRole,
        token_hash: tokenHash,
        family_id: familyId,
        device_id: opts.deviceId ?? null,
        user_agent: opts.userAgent ?? null,
        ip_address: opts.ipAddress ?? null,
        status: SESSION_STATUS.ACTIVE,
        expires_at: expiresAt,
      },
      select: { id: true, expires_at: true },
    });

    const rawToken = buildRawToken(session.id, secret);

    logger.info(`[SESSION] Created session ${session.id} for user ${opts.userId} (role: ${opts.userRole})`);

    return { rawToken, sessionId: session.id, expiresAt: session.expires_at };
  },

  /**
   * Atomically rotates a refresh session.
   *
   * Concurrency guarantee:
   *   Uses UPDATE ... WHERE status='ACTIVE' RETURNING id, which PostgreSQL
   *   executes as a single atomic operation. Only one concurrent caller
   *   can flip ACTIVE → ROTATED; the other sees 0 rows → reuse path.
   *
   * Reuse detection:
   *   If the session exists but is already ROTATED or REVOKED, the entire
   *   token family is revoked and REFRESH_TOKEN_REUSE is thrown.
   */
  async rotateSession(rawToken: string): Promise<RotateSessionResult> {
    const parsed = parseRawToken(rawToken);
    if (!parsed) {
      const err: any = new Error("Invalid refresh token format");
      err.code = "INVALID_REFRESH_TOKEN";
      throw err;
    }

    const { sessionId, secret } = parsed;

    // 1. Load the candidate session
    const session = await prisma.refresh_session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        user_id: true,
        user_role: true,
        token_hash: true,
        family_id: true,
        status: true,
        expires_at: true,
        device_id: true,
        user_agent: true,
        ip_address: true,
      },
    });

    if (!session) {
      const err: any = new Error("Refresh session not found");
      err.code = "INVALID_REFRESH_TOKEN";
      throw err;
    }

    // 2. Reuse detection: token found but already rotated or revoked
    if (session.status === SESSION_STATUS.ROTATED || session.status === SESSION_STATUS.REVOKED) {
      logger.warn(
        `[SESSION_AUDIT] REFRESH_TOKEN_REUSE detected for session ${sessionId} (family ${session.family_id}). Revoking entire family.`
      );
      // Record durable security audit event
      try {
        const { auditService } = require("../audit/audit.service");
        const { AuditAction } = require("../audit/audit.types");
        await auditService.recordEvent(prisma, {
          actorId: session.user_id,
          actorRole: session.user_role === UserRole.WORKER ? "worker" : session.user_role === UserRole.CUSTOMER ? "customer" : "admin",
          action: AuditAction.REFRESH_TOKEN_REUSE_DETECTED,
          targetType: "session",
          targetId: sessionId,
          reason: "Attempted use of already-rotated or revoked refresh token",
          metadata: {
            familyId: session.family_id,
            previousStatus: session.status,
          },
        });
      } catch {}

      // Revoke the entire family as a security response
      await sessionService.revokeFamilyByFamilyId(session.family_id, REVOKE_REASON.REUSE);
      const err: any = new Error("Refresh token already used — potential token theft detected. Please log in again.");
      err.code = "REFRESH_TOKEN_REUSE";
      throw err;
    }

    // 3. Expiry check
    if (session.expires_at < new Date()) {
      const err: any = new Error("Refresh session has expired");
      err.code = "REFRESH_SESSION_EXPIRED";
      throw err;
    }

    // 4. Constant-time secret verification
    const secretValid = await bcrypt.compare(secret, session.token_hash);
    if (!secretValid) {
      logger.warn(`[SESSION_AUDIT] Token secret mismatch for session ${sessionId}`);
      const err: any = new Error("Invalid refresh token");
      err.code = "INVALID_REFRESH_TOKEN";
      throw err;
    }

    // 4.5 Authoritative Account State Check (Issue #11)
    // A suspended or deleted account MUST NOT be able to refresh tokens or extend access.
    if (session.user_role === UserRole.WORKER && prisma.worker?.findUnique) {
      const worker = await prisma.worker.findUnique({
        where: { id: session.user_id },
        select: { id: true, deleted_at: true, verification_status: true },
      });

      if (worker !== undefined) {
        if (!worker || worker.deleted_at != null || worker.verification_status === "suspended") {
          logger.warn(
            `[SESSION_AUDIT] Refresh rejected: Worker ${session.user_id} is suspended, inactive, or deleted. Revoking family ${session.family_id}.`
          );
          await sessionService.revokeFamilyByFamilyId(session.family_id, REVOKE_REASON.SUSPENDED);
          const err: any = new Error("Account has been suspended or deactivated");
          err.code = "ACCOUNT_SUSPENDED";
          throw err;
        }
      }
    } else if (session.user_role === UserRole.CUSTOMER && prisma.customer?.findUnique) {
      const customer = await prisma.customer.findUnique({
        where: { id: session.user_id },
        select: { id: true, deleted_at: true },
      });

      if (customer !== undefined) {
        if (!customer || customer.deleted_at != null) {
          logger.warn(
            `[SESSION_AUDIT] Refresh rejected: Customer ${session.user_id} is inactive or deleted. Revoking family ${session.family_id}.`
          );
          await sessionService.revokeFamilyByFamilyId(session.family_id, REVOKE_REASON.SUSPENDED);
          const err: any = new Error("Account is inactive or has been deactivated");
          err.code = "ACCOUNT_INACTIVE";
          throw err;
        }
      }
    }

    // Pre-generate the successor session ID, secret, and hash before entering the transaction
    const cfg = getRefreshSessionConfig();
    const newExpiresAt = new Date(Date.now() + cfg.refreshSessionTtlDays * 24 * 60 * 60 * 1000);
    const newSessionId = crypto.randomUUID();
    const newSecret = generateRawSecret();
    const newTokenHash = await bcrypt.hash(newSecret, BCRYPT_ROUNDS);

    // 5. Atomic Transaction: Transition old session to ROTATED (with rotated_to_id) AND insert successor session
    const txResult = await prisma.$transaction(async (tx) => {
      const updated = await tx.refresh_session.updateMany({
        where: {
          id: sessionId,
          status: SESSION_STATUS.ACTIVE, // ← atomic guard
        },
        data: {
          status: SESSION_STATUS.ROTATED,
          rotated_at: new Date(),
          rotated_to_id: newSessionId,
        },
      });

      if (updated.count === 0) {
        return { conflict: true, newSession: null };
      }

      const newSession = await tx.refresh_session.create({
        data: {
          id: newSessionId,
          user_id: session.user_id,
          user_role: session.user_role,
          token_hash: newTokenHash,
          family_id: session.family_id, // ← same family
          device_id: session.device_id,
          user_agent: session.user_agent,
          ip_address: session.ip_address,
          status: SESSION_STATUS.ACTIVE,
          expires_at: newExpiresAt,
          last_used_at: new Date(),
        },
        select: { id: true, expires_at: true },
      });

      return { conflict: false, newSession };
    });

    if (txResult.conflict || !txResult.newSession) {
      // Case A — Legitimate concurrent race:
      // Two requests legitimately used the same currently-active refresh token at approximately the same time.
      // One request won the atomic ACTIVE transition and created a valid successor.
      // This losing request MUST NOT revoke the token family or invalidate the winner's valid successor.
      // The loser receives a deterministic failure, while the winner's successor remains usable.
      logger.warn(
        `[SESSION] Concurrent rotation race lost for session ${sessionId}. Token was rotated concurrently; preserving active successor in family ${session.family_id}.`
      );
      const err: any = new Error("Concurrent refresh detected — please retry with your latest active session.");
      err.code = "CONCURRENT_REFRESH_CONFLICT";
      err.statusCode = 401;
      throw err;
    }

    const newRawToken = buildRawToken(txResult.newSession.id, newSecret);

    logger.info(
      `[SESSION] Rotated session ${sessionId} -> ${txResult.newSession.id} for user ${session.user_id} (family ${session.family_id})`
    );

    return {
      newRawToken,
      newSessionId: txResult.newSession.id,
      expiresAt: txResult.newSession.expires_at,
      userId: session.user_id,
      userRole: session.user_role as UserRole,
    };
  },

  /**
   * Revokes a specific session owned by the given user.
   * Idempotent: already-revoked sessions are a no-op.
   * Ownership check prevents cross-user revocation.
   */
  async revokeSession(
    sessionId: string,
    userId: string,
    reason: RevokeReason = REVOKE_REASON.LOGOUT
  ): Promise<{ revokedCount: number }> {
    const result = await prisma.refresh_session.updateMany({
      where: {
        id: sessionId,
        user_id: userId, // ownership enforcement
        status: { in: [SESSION_STATUS.ACTIVE, SESSION_STATUS.ROTATED] },
      },
      data: {
        status: SESSION_STATUS.REVOKED,
        revoked_at: new Date(),
        revoked_reason: reason,
      },
    });

    if (result.count > 0) {
      logger.info(`[SESSION] Revoked session ${sessionId} (reason: ${reason}) for user ${userId}`);
    }

    return { revokedCount: result.count };
  },

  /**
   * Revokes all active/rotated sessions for a user.
   * Used for: password change, account suspension, admin action.
   */
  async revokeAllUserSessions(userId: string, reason: RevokeReason = REVOKE_REASON.ADMIN): Promise<number> {
    const result = await prisma.refresh_session.updateMany({
      where: {
        user_id: userId,
        status: { in: [SESSION_STATUS.ACTIVE, SESSION_STATUS.ROTATED] },
      },
      data: {
        status: SESSION_STATUS.REVOKED,
        revoked_at: new Date(),
        revoked_reason: reason,
      },
    });

    logger.info(`[SESSION] Revoked ${result.count} session(s) for user ${userId} (reason: ${reason})`);
    return result.count;
  },

  /**
   * Revokes all sessions in a token family.
   * Called when token reuse is detected.
   */
  async revokeFamilyByFamilyId(familyId: string, reason: RevokeReason = REVOKE_REASON.REUSE): Promise<number> {
    const result = await prisma.refresh_session.updateMany({
      where: {
        family_id: familyId,
        status: { not: SESSION_STATUS.REVOKED },
      },
      data: {
        status: SESSION_STATUS.REVOKED,
        revoked_at: new Date(),
        revoked_reason: reason,
      },
    });

    logger.warn(`[SESSION_AUDIT] Revoked ${result.count} session(s) in family ${familyId} (reason: ${reason})`);
    return result.count;
  },

  /**
   * Revokes a session by its raw token — used by logout when the
   * client presents the refresh token in the request body.
   */
  async revokeByRawToken(rawToken: string, userId: string): Promise<{ revokedCount: number }> {
    const parsed = parseRawToken(rawToken);
    if (!parsed) {
      // Graceful: invalid token format → treat as already-revoked
      return { revokedCount: 0 };
    }
    return sessionService.revokeSession(parsed.sessionId, userId, REVOKE_REASON.LOGOUT);
  },

  /**
   * Lists all ACTIVE sessions for a user, safe for display in a session management UI.
   * Does NOT include token_hash or any cryptographic material.
   */
  async listActiveSessions(userId: string): Promise<SessionDTO[]> {
    const now = new Date();
    const sessions = await prisma.refresh_session.findMany({
      where: {
        user_id: userId,
        status: SESSION_STATUS.ACTIVE,
        expires_at: { gt: now },
      },
      orderBy: { created_at: "desc" },
      select: {
        id: true,
        user_id: true,
        user_role: true,
        device_id: true,
        user_agent: true,
        ip_address: true,
        created_at: true,
        last_used_at: true,
        expires_at: true,
        status: true,
        rotated_to_id: true,
      },
    });

    return sessions;
  },

  /**
   * Cleans up expired and revoked sessions older than the retention threshold.
   * Safe to call from a background job.
   *
   * Retention policy:
   *   REVOKED/ROTATED/EXPIRED sessions are kept for `cleanupRetentionDays` to
   *   support reuse detection and security auditing.
   */
  async cleanupExpiredSessions(retentionDaysOverride?: number): Promise<{ deletedCount: number }> {
    const cfg = getRefreshSessionConfig();
    const retentionDays = retentionDaysOverride ?? cfg.refreshSessionCleanupRetentionDays;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const result = await prisma.refresh_session.deleteMany({
      where: {
        expires_at: { lt: cutoff },
      },
    });

    if (result.count > 0) {
      logger.info(`[SESSION] Cleanup: deleted ${result.count} expired refresh session(s) older than ${cutoff.toISOString()}`);
    }

    return { deletedCount: result.count };
  },
};

