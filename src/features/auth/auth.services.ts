import prisma from "../../config/prisma";
import { UserRole } from "../../type/userRole";
import { toAuthUserDTO } from "../../shared/prismaSelects";
import {
  generateOTP,
  hashOTP,
  comparePassword,
  normalizePhoneToE164,
  maskPhone,
  signAccessToken,
  verifyRefreshToken,
} from "../../utils/authUtils";
import { authConfig } from "../../config/authConfig";
import { getSmsProvider } from "../../providers/sms/smsProviderFactory";
import { sessionService } from "./session.service";
import { REVOKE_REASON } from "./session.types";
import { OTP_STATUS } from "./auth.types";
import { logger } from "../../utils/logger";
import { metricsService } from "../../metrics/metrics.service";

export const authService = {
  /**
   * Generates and dispatches a cryptographically secure, hashed OTP challenge.
   * Atomically enforces resend cooldown and invalidates any previous active challenges for (phone, purpose).
   */
  async sendOtp(rawPhone: string, type: "login" | "register") {
    const phone = normalizePhoneToE164(rawPhone);

    // 1. Cryptographically secure random 6-digit OTP
    const plainOtp = generateOTP();
    const otp_hash = await hashOTP(plainOtp);
    const expires_at = new Date(Date.now() + authConfig.otpTtlSeconds * 1000);
    const cooldownThreshold = new Date(Date.now() - authConfig.otpResendCooldownSeconds * 1000);

    // 2. Atomically verify cooldown, invalidate prior challenges, and create new ACTIVE challenge
    const challenge = await prisma.$transaction(async (tx) => {
      // Check for any challenge created within cooldown window for this (phone, purpose)
      const recentChallenge = await tx.otp_challenge.findFirst({
        where: {
          phone,
          purpose: type,
          created_at: { gt: cooldownThreshold },
        },
        orderBy: { created_at: "desc" },
      });

      if (recentChallenge) {
        const elapsedSeconds = Math.floor((Date.now() - recentChallenge.created_at.getTime()) / 1000);
        const waitSeconds = Math.max(1, authConfig.otpResendCooldownSeconds - elapsedSeconds);
        const error: any = new Error("Please wait before requesting another OTP.");
        error.code = "OTP_RESEND_COOLDOWN";
        error.waitSeconds = waitSeconds;
        throw error;
      }

      // Expire any existing active challenges for this phone & purpose
      await tx.otp_challenge.updateMany({
        where: {
          phone,
          purpose: type,
          status: OTP_STATUS.ACTIVE,
        },
        data: {
          status: OTP_STATUS.EXPIRED,
          consumed_at: new Date(),
        },
      });

      // Insert new challenge
      return await tx.otp_challenge.create({
        data: {
          phone,
          purpose: type,
          otp_hash,
          expires_at,
          status: OTP_STATUS.ACTIVE,
          attempt_count: 0,
        },
      });
    });

    // 3. Dispatch OTP via SMS Provider
    try {
      const provider = getSmsProvider();
      await provider.sendOtp(phone, plainOtp, type);
    } catch (smsError: any) {
      // Mark challenge as EXPIRED so it cannot be verified if delivery failed
      await prisma.otp_challenge.update({
        where: { id: challenge.id },
        data: {
          status: OTP_STATUS.EXPIRED,
          consumed_at: new Date(),
        },
      });

      logger.error(`[AUTH] SMS delivery failed for recipient ${maskPhone(phone)}:`, { error: smsError.message });
      metricsService.incrementCounter("otp_delivery_failed_total", 1, { purpose: type });
      const deliveryErr: any = new Error("Failed to deliver verification code. Please try again later.");
      deliveryErr.code = "SMS_DELIVERY_FAILED";
      throw deliveryErr;
    }

    logger.info(`[AUTH_AUDIT] OTP challenge issued for purpose '${type}' to recipient ${maskPhone(phone)}`);
    metricsService.incrementCounter("otp_challenges_created_total", 1, { purpose: type });
    return { success: true, message: "OTP sent successfully." };
  },

  /**
   * Atomically verifies an OTP challenge and issues JWT credentials + server-side
   * refresh session upon success.
   *
   * Guarantees single-use semantics under concurrency, bounds verification attempts,
   * and isolates authentication purposes.
   */
  async verifyOtp(
    rawPhone: string,
    otp: string,
    type?: "login" | "register",
    opts?: { deviceId?: string; userAgent?: string; ipAddress?: string }
  ) {
    const phone = normalizePhoneToE164(rawPhone);

    // 1. Find active challenge
    const whereClause: any = {
      phone,
      status: OTP_STATUS.ACTIVE,
      expires_at: { gt: new Date() },
      consumed_at: null,
    };

    if (type) {
      whereClause.purpose = type;
    }

    const challenge = await prisma.otp_challenge.findFirst({
      where: whereClause,
      orderBy: { created_at: "desc" },
    });

    if (!challenge) {
      logger.warn(`[AUTH_AUDIT] Verification failed: No active challenge found for ${maskPhone(phone)}`);
      const error: any = new Error("Invalid or expired OTP");
      error.code = "OTP_INVALID";
      throw error;
    }

    // 2. Check attempt limits
    if (challenge.attempt_count >= authConfig.otpMaxAttempts || challenge.status === OTP_STATUS.LOCKED) {
      if (challenge.status !== OTP_STATUS.LOCKED) {
        await prisma.otp_challenge.update({
          where: { id: challenge.id },
          data: { status: OTP_STATUS.LOCKED, consumed_at: new Date() },
        });
      }
      logger.warn(`[AUTH_AUDIT] Challenge locked due to attempt limit for ${maskPhone(phone)}`);
      const error: any = new Error("Maximum verification attempts exceeded. Please request a new OTP.");
      error.code = "OTP_MAX_ATTEMPTS";
      throw error;
    }

    // 3. Verify OTP hash with bcrypt
    const isMatch = await comparePassword(otp, challenge.otp_hash);

    if (!isMatch) {
      // Atomic database-level increment to prevent concurrent attempt bypass
      const updated = await prisma.otp_challenge.update({
        where: { id: challenge.id },
        data: {
          attempt_count: { increment: 1 },
        },
      });

      const reachedLimit = updated.attempt_count >= authConfig.otpMaxAttempts;
      if (reachedLimit) {
        await prisma.otp_challenge.update({
          where: { id: challenge.id },
          data: {
            status: OTP_STATUS.LOCKED,
            consumed_at: new Date(),
          },
        });
      }

      logger.warn(
        `[AUTH_AUDIT] Incorrect OTP attempt (${updated.attempt_count}/${authConfig.otpMaxAttempts}) for ${maskPhone(phone)}`
      );

      const error: any = new Error(
        reachedLimit
          ? "Maximum verification attempts exceeded. Please request a new OTP."
          : "Invalid or expired OTP"
      );
      error.code = reachedLimit ? "OTP_MAX_ATTEMPTS" : "OTP_INVALID";
      throw error;
    }

    // 4. Concurrency Guard: Atomic conditional claim directly in PostgreSQL
    // PostgreSQL row lock guarantees exactly ONE concurrent request updates the row
    const claimResult = await prisma.otp_challenge.updateMany({
      where: {
        id: challenge.id,
        status: OTP_STATUS.ACTIVE,
        consumed_at: null,
      },
      data: {
        status: OTP_STATUS.CONSUMED,
        consumed_at: new Date(),
      },
    });

    if (claimResult.count === 0) {
      logger.warn(`[AUTH_AUDIT] Race condition detected: Challenge already consumed for ${maskPhone(phone)}`);
      const error: any = new Error("Invalid or expired OTP");
      error.code = "OTP_ALREADY_USED";
      throw error;
    }

    logger.info(`[AUTH_AUDIT] OTP challenge successfully verified & consumed for ${maskPhone(phone)}`);

    // 5. User lookup after valid challenge consumption
    let user = await prisma.customer.findUnique({ where: { phone } });
    let role: UserRole = UserRole.CUSTOMER;

    if (!user) {
      user = (await prisma.worker.findUnique({ where: { phone } })) as any;
      role = UserRole.WORKER;
    }

    if (!user) {
      // If this was a registration purpose OTP, return verified status
      if (type === "register" || challenge.purpose === "register") {
        return {
          verified: true,
          phone,
          message: "Phone verified successfully. Please proceed with registration.",
        };
      }
      const error: any = new Error("User not found");
      error.code = "USER_NOT_FOUND";
      throw error;
    }

    // 5.5 Authoritative Account State Check (Issue #11)
    // A suspended or deleted account MUST NOT be allowed to log in via OTP
    if (role === UserRole.WORKER) {
      const worker = user as any;
      if (worker.deleted_at != null || worker.verification_status === "suspended") {
        logger.warn(`[AUTH_AUDIT] OTP login rejected: Worker ${worker.id} is suspended or deleted`);
        const error: any = new Error("Account has been suspended or deactivated");
        error.code = "ACCOUNT_SUSPENDED";
        throw error;
      }
    } else if (role === UserRole.CUSTOMER) {
      const customer = user as any;
      if (customer.deleted_at != null) {
        logger.warn(`[AUTH_AUDIT] OTP login rejected: Customer ${customer.id} is inactive or deleted`);
        const error: any = new Error("Account is inactive or has been deactivated");
        error.code = "ACCOUNT_INACTIVE";
        throw error;
      }
    }

    // 6. Issue access token (short-lived JWT)
    const token = signAccessToken({ id: user.id, role, phone: user.phone });

    // 7. Create server-side refresh session and return opaque token
    const sessionResult = await sessionService.createSession({
      userId: user.id,
      userRole: role,
      deviceId: opts?.deviceId,
      userAgent: opts?.userAgent,
      ipAddress: opts?.ipAddress,
    });

    return {
      user: toAuthUserDTO(user),
      role,
      token,
      refreshToken: sessionResult.rawToken,
      sessionExpiresAt: sessionResult.expiresAt,
    };
  },

  /**
   * Atomically rotates a refresh session and returns a new access token +
   * a new rotated refresh token.
   *
   * Reuse detection: presenting an already-rotated token revokes the entire
   * token family and returns REFRESH_TOKEN_REUSE.
   */
  async refreshToken(rawToken: string) {
    try {
      const rotated = await sessionService.rotateSession(rawToken);

      // Issue a fresh access token for the session owner
      const newAccessToken = signAccessToken({
        id: rotated.userId,
        role: rotated.userRole,
      });

      return {
        token: newAccessToken,
        refreshToken: rotated.newRawToken,
      };
    } catch (sessionErr: any) {
      // If it failed due to security events (reuse, expiration, suspension), rethrow immediately
      if (
        sessionErr.code === "REFRESH_TOKEN_REUSE" ||
        sessionErr.code === "REFRESH_SESSION_EXPIRED" ||
        sessionErr.code === "ACCOUNT_SUSPENDED" ||
        sessionErr.code === "ACCOUNT_INACTIVE"
      ) {
        throw sessionErr;
      }

      // Backward compatibility during migration: check if caller presented a valid legacy JWT refresh token
      const decoded = verifyRefreshToken(rawToken);
      if (decoded && decoded.id && decoded.role) {
        // Upgrade legacy JWT into a server-side session
        const sessionResult = await sessionService.createSession({
          userId: decoded.id,
          userRole: decoded.role,
        });

        const newAccessToken = signAccessToken({
          id: decoded.id,
          role: decoded.role,
          phone: decoded.phone,
        });

        return {
          token: newAccessToken,
          refreshToken: sessionResult.rawToken,
        };
      }

      // Neither a valid session token nor a valid legacy JWT
      throw sessionErr;
    }
  },

  /**
   * Revokes the server-side refresh session identified by the opaque refresh token.
   * Idempotent: already-revoked sessions return success silently.
   */
  async logout(rawRefreshToken: string, userId: string) {
    const { revokedCount } = await sessionService.revokeByRawToken(rawRefreshToken, userId);

    if (revokedCount > 0) {
      logger.info(`[SESSION] Logout: revoked session for user ${userId}`);
    } else {
      logger.info(`[SESSION] Logout: session already revoked or not found for user ${userId}`);
    }

    return { success: true, message: "Logged out successfully" };
  },

  /**
   * Periodic hygiene cleanup for expired and consumed/invalidated challenges older than retention threshold.
   */
  async cleanupExpiredOtpChallenges() {
    const cutoff = new Date(Date.now() - authConfig.otpCleanupRetentionDays * 24 * 60 * 60 * 1000);
    const result = await prisma.otp_challenge.deleteMany({
      where: {
        OR: [
          { expires_at: { lt: cutoff } },
          {
            status: { in: [OTP_STATUS.CONSUMED, OTP_STATUS.EXPIRED, OTP_STATUS.LOCKED] },
            created_at: { lt: cutoff },
          },
        ],
      },
    });
    logger.info(`[AUTH_CLEANUP] Purged ${result.count} stale OTP challenge records older than ${authConfig.otpCleanupRetentionDays} days`);
    return result;
  },
};
