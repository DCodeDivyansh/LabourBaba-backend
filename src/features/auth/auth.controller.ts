import { Request, Response } from "express";
import { authService } from "./auth.services";
import { sessionService } from "./session.service";
import { SendOtpReq, AuthVerifyOtpReq, RefreshTokenReq } from "../../type/api_req.type";
import { AuthenticatedRequest } from "../../middlewares/authMiddleware";

export const sendOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload: SendOtpReq = req.body;
    const response = await authService.sendOtp(payload.phone, payload.type);
    res.status(200).json(response);
  } catch (error: any) {
    if (error.code === "OTP_RESEND_COOLDOWN") {
      res.status(429).json({
        success: false,
        code: "OTP_RESEND_COOLDOWN",
        message: error.message,
        waitSeconds: error.waitSeconds,
      });
      return;
    }
    if (error.code === "SMS_DELIVERY_FAILED") {
      res.status(502).json({
        success: false,
        code: "SMS_DELIVERY_FAILED",
        message: error.message,
      });
      return;
    }
    res.status(500).json({ success: false, message: error.message || "Failed to send OTP" });
  }
};

export const verifyOtp = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload: AuthVerifyOtpReq = req.body;
    const response = await authService.verifyOtp(payload.phone, payload.otp, payload.type, {
      deviceId: (payload as any).device_id,
      userAgent: req.headers["user-agent"],
      ipAddress: req.ip,
    });
    res.status(200).json({ success: true, data: response });
  } catch (error: any) {
    if (error.code === "USER_NOT_FOUND") {
      res.status(404).json({ success: false, code: "USER_NOT_FOUND", message: error.message });
      return;
    }
    if (error.code === "OTP_MAX_ATTEMPTS") {
      res.status(401).json({
        success: false,
        code: "OTP_MAX_ATTEMPTS",
        message: error.message,
      });
      return;
    }
    if (error.code === "ACCOUNT_SUSPENDED") {
      res.status(401).json({
        success: false,
        code: "ACCOUNT_SUSPENDED",
        message: "Account has been suspended or deactivated",
      });
      return;
    }
    if (error.code === "ACCOUNT_INACTIVE") {
      res.status(401).json({
        success: false,
        code: "ACCOUNT_INACTIVE",
        message: "Account is inactive or has been deactivated",
      });
      return;
    }
    // Uniform safe error for invalid, expired, or already-consumed OTPs
    res.status(401).json({
      success: false,
      code: "OTP_INVALID",
      message: "Invalid OTP",
    });
  }
};

/**
 * POST /api/auth/refresh
 * Body: { token: "<opaque-refresh-token>" }
 *
 * Atomically rotates the refresh session and returns:
 *   - token: new short-lived access JWT
 *   - refreshToken: new opaque refresh token (old token is invalidated)
 *
 * Stable error codes:
 *   INVALID_REFRESH_TOKEN  — malformed or unknown token
 *   REFRESH_SESSION_EXPIRED — session past expires_at
 *   REFRESH_TOKEN_REUSE     — already-rotated token presented (security event)
 */
export const refreshToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload: RefreshTokenReq = req.body;
    const response = await authService.refreshToken(payload.token);
    res.status(200).json({ success: true, data: response });
  } catch (error: any) {
    const code = error.code || "INVALID_REFRESH_TOKEN";
    if (code === "REFRESH_TOKEN_REUSE") {
      // Security event — family has been revoked, user must re-authenticate
      res.status(401).json({
        success: false,
        code: "REFRESH_TOKEN_REUSE",
        message: "Authentication session invalidated. Please log in again.",
      });
      return;
    }
    if (code === "REFRESH_SESSION_EXPIRED") {
      res.status(401).json({
        success: false,
        code: "REFRESH_SESSION_EXPIRED",
        message: "Session expired. Please log in again.",
      });
      return;
    }
    if (code === "ACCOUNT_SUSPENDED") {
      res.status(401).json({
        success: false,
        code: "ACCOUNT_SUSPENDED",
        message: "Account has been suspended or deactivated",
      });
      return;
    }
    if (code === "ACCOUNT_INACTIVE") {
      res.status(401).json({
        success: false,
        code: "ACCOUNT_INACTIVE",
        message: "Account is inactive or has been deactivated",
      });
      return;
    }
    // All other errors → generic 401 (no oracle about token existence)
    res.status(401).json({
      success: false,
      code: "INVALID_REFRESH_TOKEN",
      message: "Invalid refresh token",
    });
  }
};

/**
 * POST /api/auth/logout
 * Body: { refresh_token: "<opaque-refresh-token>" }
 * Headers: Authorization: Bearer <access-token>  (required — identifies user)
 *
 * Revokes the server-side refresh session. Idempotent.
 * Access token is required so we can identify the calling user without
 * trusting client-supplied user IDs.
 */
export const logout = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const rawRefreshToken: string | undefined = req.body?.refresh_token;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    if (!rawRefreshToken) {
      res.status(400).json({
        success: false,
        code: "MISSING_REFRESH_TOKEN",
        message: "refresh_token is required in the request body",
      });
      return;
    }

    const response = await authService.logout(rawRefreshToken, userId);
    res.status(200).json(response);
  } catch (error: any) {
    res.status(500).json({ success: false, message: "Logout failed" });
  }
};

/**
 * GET /api/auth/sessions
 * Lists all active refresh sessions for the authenticated user.
 * Safe: token_hash and cryptographic material are never returned.
 */
export const listSessions = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const sessions = await sessionService.listActiveSessions(userId);
    res.status(200).json({ success: true, data: sessions });
  } catch (error: any) {
    res.status(500).json({ success: false, message: "Failed to list sessions" });
  }
};

/**
 * DELETE /api/auth/sessions/:sessionId
 * Revokes a specific session owned by the authenticated user.
 * Idempotent: already-revoked sessions return 200.
 */
export const revokeSession = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
    if (!sessionId) {
      res.status(400).json({ success: false, message: "sessionId is required" });
      return;
    }

    const { revokedCount } = await sessionService.revokeSession(sessionId, userId, "LOGOUT");
    res.status(200).json({
      success: true,
      data: { revokedCount },
      message: revokedCount > 0 ? "Session revoked successfully" : "Session already revoked or not found",
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: "Failed to revoke session" });
  }
};
