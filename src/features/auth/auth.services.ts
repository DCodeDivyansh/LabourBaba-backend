import prisma from "../../config/prisma";
import { UserRole } from "../../type/userRole";
import { toAuthUserDTO } from "../../shared/prismaSelects";
import {
  generateOTP,
  hashOTP,
  comparePassword,
  normalizePhone,
  maskPhone,
  signAccessToken,
  verifyRefreshToken,
} from "../../utils/authUtils";
import { authConfig } from "../../config/authConfig";
import { getSmsProvider } from "../../providers/sms/smsProviderFactory";
import { sessionService } from "./session.service";
import { REVOKE_REASON } from "./session.types";

export const authService = {
  /**
   * Generates and dispatches a cryptographically secure, hashed OTP challenge.
   * Enforces resend cooldown and invalidates any previous active challenges for (phone, purpose).
   */
  async sendOtp(rawPhone: string, type: "login" | "register") {
    const phone = normalizePhone(rawPhone);

    // 1. Check for active unconsumed challenge to enforce resend cooldown
    const existingActive = await prisma.otp_challenge.findFirst({
      where: {
        phone,
        purpose: type,
        status: "ACTIVE",
        consumed_at: null,
        expires_at: { gt: new Date() },
      },
      orderBy: { created_at: "desc" },
    });

    if (existingActive) {
      const elapsedSeconds = Math.floor((Date.now() - existingActive.created_at.getTime()) / 1000);
      if (elapsedSeconds < authConfig.otpResendCooldownSeconds) {
        const waitSeconds = authConfig.otpResendCooldownSeconds - elapsedSeconds;
        const error: any = new Error("Please wait before requesting another OTP.");
        error.code = "OTP_RESEND_COOLDOWN";
        error.waitSeconds = waitSeconds;
        throw error;
      }
    }

    // 2. Cryptographically secure random 6-digit OTP
    const plainOtp = generateOTP();
    const otp_hash = await hashOTP(plainOtp);
    const expires_at = new Date(Date.now() + authConfig.otpTtlSeconds * 1000);

    // 3. Atomically invalidate prior challenges and create new ACTIVE challenge
    const challenge = await prisma.$transaction(async (tx) => {
      // Invalidate any existing active challenges for this phone & purpose
      await tx.otp_challenge.updateMany({
        where: {
          phone,
          purpose: type,
          status: "ACTIVE",
        },
        data: {
          status: "INVALIDATED",
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
          status: "ACTIVE",
          attempt_count: 0,
        },
      });
    });

    // 4. Dispatch OTP via SMS Provider
    try {
      const provider = getSmsProvider();
      await provider.sendOtp(phone, plainOtp, type);
    } catch (smsError: any) {
      // Mark challenge as DELIVERY_FAILED so it cannot be verified if delivery failed
      await prisma.otp_challenge.update({
        where: { id: challenge.id },
        data: {
          status: "DELIVERY_FAILED",
          consumed_at: new Date(),
        },
      });

      console.error(`[AUTH] SMS delivery failed for recipient ${maskPhone(phone)}:`, smsError.message);
      const deliveryErr: any = new Error("Failed to deliver verification code. Please try again later.");
      deliveryErr.code = "SMS_DELIVERY_FAILED";
      throw deliveryErr;
    }

    console.log(`[AUTH_AUDIT] OTP challenge issued for purpose '${type}' to recipient ${maskPhone(phone)}`);
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
    const phone = normalizePhone(rawPhone);

    return await prisma.$transaction(async (tx) => {
      // 1. Locate active challenge
      const whereClause: any = {
        phone,
        status: "ACTIVE",
        consumed_at: null,
        expires_at: { gt: new Date() },
      };

      if (type) {
        whereClause.purpose = type;
      }

      const challenge = await tx.otp_challenge.findFirst({
        where: whereClause,
        orderBy: { created_at: "desc" },
      });

      if (!challenge) {
        console.warn(`[AUTH_AUDIT] Verification failed: No active challenge found for ${maskPhone(phone)}`);
        const error: any = new Error("Invalid or expired OTP");
        error.code = "OTP_INVALID";
        throw error;
      }

      // 2. Check attempt limits
      if (challenge.attempt_count >= authConfig.otpMaxAttempts) {
        await tx.otp_challenge.update({
          where: { id: challenge.id },
          data: { status: "LOCKED", consumed_at: new Date() },
        });
        console.warn(`[AUTH_AUDIT] Challenge locked due to attempt limit for ${maskPhone(phone)}`);
        const error: any = new Error("Maximum verification attempts exceeded. Please request a new OTP.");
        error.code = "OTP_MAX_ATTEMPTS";
        throw error;
      }

      // 3. Verify OTP hash with bcrypt
      const isMatch = await comparePassword(otp, challenge.otp_hash);

      if (!isMatch) {
        const nextAttempts = challenge.attempt_count + 1;
        const reachedLimit = nextAttempts >= authConfig.otpMaxAttempts;

        await tx.otp_challenge.update({
          where: { id: challenge.id },
          data: {
            attempt_count: nextAttempts,
            status: reachedLimit ? "LOCKED" : "ACTIVE",
            ...(reachedLimit ? { consumed_at: new Date() } : {}),
          },
        });

        console.warn(
          `[AUTH_AUDIT] Incorrect OTP attempt (${nextAttempts}/${authConfig.otpMaxAttempts}) for ${maskPhone(phone)}`
        );

        const error: any = new Error(
          reachedLimit
            ? "Maximum verification attempts exceeded. Please request a new OTP."
            : "Invalid or expired OTP"
        );
        error.code = reachedLimit ? "OTP_MAX_ATTEMPTS" : "OTP_INVALID";
        throw error;
      }

      // 4. Concurrency Guard: Atomic claim to prevent double-consumption
      const claimResult = await tx.otp_challenge.updateMany({
        where: {
          id: challenge.id,
          status: "ACTIVE",
          consumed_at: null,
        },
        data: {
          status: "CONSUMED",
          consumed_at: new Date(),
        },
      });

      if (claimResult.count === 0) {
        console.warn(`[AUTH_AUDIT] Race condition detected: Challenge already consumed for ${maskPhone(phone)}`);
        const error: any = new Error("Invalid or expired OTP");
        error.code = "OTP_ALREADY_USED";
        throw error;
      }

      console.log(`[AUTH_AUDIT] OTP challenge successfully verified & consumed for ${maskPhone(phone)}`);

      // 5. User lookup after valid challenge consumption
      let user = await tx.customer.findUnique({ where: { phone } });
      let role: UserRole = UserRole.CUSTOMER;

      if (!user) {
        user = (await tx.worker.findUnique({ where: { phone } })) as any;
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

      // 6. Issue access token (short-lived JWT)
      const token = signAccessToken({ id: user.id, role, phone: user.phone });

      // 7. Create server-side refresh session and return opaque token
      //    (outside the OTP transaction to avoid long-running bcrypt inside tx)
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
    });
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
      // If it failed due to security events (reuse, expiration), rethrow immediately
      if (
        sessionErr.code === "REFRESH_TOKEN_REUSE" ||
        sessionErr.code === "REFRESH_SESSION_EXPIRED"
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
   *
   * The caller must supply userId from the authenticated context (access token),
   * so the client cannot revoke another user's session.
   */
  async logout(rawRefreshToken: string, userId: string) {
    const { revokedCount } = await sessionService.revokeByRawToken(rawRefreshToken, userId);

    if (revokedCount > 0) {
      console.log(`[SESSION] Logout: revoked session for user ${userId}`);
    } else {
      // Token not found or already revoked — treat as idempotent success
      console.log(`[SESSION] Logout: session already revoked or not found for user ${userId}`);
    }

    return { success: true, message: "Logged out successfully" };
  },

  /**
   * Periodic hygiene cleanup for expired challenges older than retention threshold.
   */
  async cleanupExpiredOtpChallenges() {
    const cutoff = new Date(Date.now() - authConfig.otpCleanupRetentionDays * 24 * 60 * 60 * 1000);
    return await prisma.otp_challenge.deleteMany({
      where: {
        expires_at: { lt: cutoff },
      },
    });
  },
};
