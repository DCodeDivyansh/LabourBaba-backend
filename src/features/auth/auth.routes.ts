import express from "express";
import { sendOtp, verifyOtp, refreshToken, logout } from "./auth.controller";
import { validateBody } from "../../middlewares/validationMiddleware";
import { SendOtpReqSchema, AuthVerifyOtpReqSchema, RefreshTokenReqSchema } from "../../schemas";
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
  summary: "Verify OTP and return JWT",
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
      description: "OTP verified successfully",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            data: z.object({
              token: z.string(),
              refreshToken: z.string(),
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
  summary: "Refresh JWT",
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
      description: "Token refreshed successfully",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            data: z.object({
              token: z.string(),
            }),
          }),
        },
      },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/auth/logout",
  summary: "Invalidate token",
  tags: ["Auth"],
  responses: {
    200: {
      description: "Logged out successfully",
    },
  },
});

router.post("/send-otp", validateBody(SendOtpReqSchema), sendOtp);
router.post("/verify-otp", validateBody(AuthVerifyOtpReqSchema), verifyOtp);
router.post("/refresh", validateBody(RefreshTokenReqSchema), refreshToken);
router.post("/logout", logout);

export default router;
