import express from "express";
import {
  sendOtp,
  verifyOtp,
  refreshToken,
  logout,
  listSessions,
  revokeSession,
} from "./auth.controller";
import { validateBody } from "../../middlewares/validationMiddleware";
import { otpRequestRateLimiter, otpVerifyRateLimiter } from "../../middlewares/otpRateLimiter";
import { authenticateJWT } from "../../middlewares/authMiddleware";
import {
  SendOtpReqSchema,
  AuthVerifyOtpReqSchema,
  RefreshTokenReqSchema,
  LogoutReqSchema,
} from "../../schemas";
import { registry } from "../../config/swagger";
import { z } from "zod";

const router = express.Router();

registry.registerPath({
  method: "post",
  path: "/api/auth/send-otp",
  summary: "Send OTP to phone via SMS",
  tags: ["Auth"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: SendOtpReqSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "OTP sent successfully",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            message: z.string(),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/verify-otp",
  summary: "Verify OTP and return JWT + refresh session token",
  tags: ["Auth"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: AuthVerifyOtpReqSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "OTP verified successfully. Returns access token and opaque refresh token.",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            data: z.object({
              token: z.string().describe("Short-lived JWT access token"),
              refreshToken: z.string().describe("Opaque refresh token (<sessionId>.<secret>). Store securely."),
              role: z.string(),
            }),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/refresh",
  summary: "Rotate refresh session — returns new access + refresh token",
  description:
    "Atomically invalidates the presented refresh token and issues a replacement. " +
    "Presenting an already-rotated token revokes the entire session family (reuse detection).",
  tags: ["Auth"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: RefreshTokenReqSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Tokens refreshed successfully",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            data: z.object({
              token: z.string().describe("New short-lived JWT access token"),
              refreshToken: z.string().describe("New opaque refresh token (old token is now invalid)"),
            }),
          }),
        },
      },
    },
    401: {
      description: "Invalid, expired, or reused refresh token",
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/logout",
  summary: "Revoke refresh session (logout)",
  description:
    "Revokes the server-side refresh session. Requires access token in Authorization header " +
    "and refresh token in request body. Idempotent.",
  tags: ["Auth"],
  request: {
    body: {
      content: {
        "application/json": {
          schema: LogoutReqSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Logged out successfully",
    },
    400: {
      description: "refresh_token missing from request body",
    },
    401: {
      description: "Access token missing or invalid",
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/auth/sessions",
  summary: "List active refresh sessions for the authenticated user",
  tags: ["Auth"],
  responses: {
    200: {
      description: "Active sessions list",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            data: z.array(
              z.object({
                id: z.string().uuid(),
                device_id: z.string().nullable(),
                user_agent: z.string().nullable(),
                ip_address: z.string().nullable(),
                created_at: z.string(),
                last_used_at: z.string().nullable(),
                expires_at: z.string(),
                status: z.string(),
              })
            ),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "delete",
  path: "/api/auth/sessions/{sessionId}",
  summary: "Revoke a specific refresh session",
  tags: ["Auth"],
  responses: {
    200: {
      description: "Session revoked (or already revoked)",
    },
    401: {
      description: "Not authenticated",
    },
  },
});

// ── Routes ───────────────────────────────────────────────────────────────────

router.post("/send-otp", otpRequestRateLimiter, validateBody(SendOtpReqSchema), sendOtp);
router.post("/verify-otp", otpVerifyRateLimiter, validateBody(AuthVerifyOtpReqSchema), verifyOtp);
router.post("/refresh", validateBody(RefreshTokenReqSchema), refreshToken);

// Logout requires authentication to identify the session owner
router.post("/logout", authenticateJWT, validateBody(LogoutReqSchema), logout);

// Session management — requires authentication
router.get("/sessions", authenticateJWT, listSessions);
router.delete("/sessions/:sessionId", authenticateJWT, revokeSession);

export default router;
