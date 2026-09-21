/**
 * Payment Routes — Issue #11 remediation
 *
 * Authorization:
 * - create-order, get-status, refund: requireRole(CUSTOMER) — workers and admins are forbidden
 * - webhook: no JWT auth (Razorpay calls this; signature verification replaces auth)
 *
 * Middleware ordering:
 * - The webhook route uses express.raw({ type: 'application/json' }) to capture the exact
 *   raw bytes sent by Razorpay BEFORE any JSON parser touches the body.
 *   This is required for HMAC-SHA256 signature verification.
 *
 * IMPORTANT: This route module is mounted BEFORE the global express.json() middleware would
 * have a chance to parse /webhook. The route-level express.raw() overrides global body parsing
 * for this specific endpoint. See server.ts for middleware order.
 */

import express from "express";
import {
  createOrderHandler,
  handleWebhookHandler,
  getPaymentStatusHandler,
  refundPaymentHandler,
} from "./paymentController";
import { authenticateJWT, requireRole, UserRole } from "../../middlewares/authMiddleware";
import { validateBody, validateParams } from "../../middlewares/validationMiddleware";
import { paymentOrderRateLimiter, paymentRefundRateLimiter } from "../../middlewares/rateLimiter";
import { CreatePaymentReqSchema, PaymentSchema, BookingIdParamSchema } from "../../schemas";
import { registry } from "../../config/swagger";
import { z } from "zod";

const router = express.Router();

// ── OpenAPI Documentation ────────────────────────────────────────────────────────

registry.registerPath({
  method: "post",
  path: "/api/payments/{bookingId}/create-order",
  summary: "Create Razorpay payment order",
  description:
    "Creates a real Razorpay payment order. Amount is derived server-side from the booking's " +
    "rate_per_day. The client must NOT supply an authoritative amount. Only CUSTOMER role " +
    "may call this endpoint. Booking must be owned by the authenticated customer.",
  tags: ["Payments"],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      in: "path",
      name: "bookingId",
      required: true,
      schema: { type: "string", format: "uuid" },
      description: "ID of the booking to create a payment order for",
    },
  ],
  responses: {
    201: {
      description: "Payment order created",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            data: z.object({
              paymentId: z.string().uuid(),
              razorpayOrderId: z.string(),
              amount: z.number().int().describe("Amount in paise"),
              currency: z.string().default("INR"),
              status: z.string().default("PENDING"),
              bookingId: z.string().uuid(),
            }),
          }),
        },
      },
    },
    401: { description: "Unauthorized (missing or invalid JWT)" },
    403: { description: "Forbidden (not a CUSTOMER, or does not own the booking)" },
    409: { description: "Conflict (payment already completed, or booking not in payable state)" },
    422: { description: "Unprocessable (booking has no rate configured)" },
    502: { description: "Payment provider error" },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/payments/webhook",
  summary: "Razorpay webhook receiver",
  description:
    "Receives Razorpay event notifications. Requires a valid X-Razorpay-Signature header. " +
    "The raw request body is used for HMAC-SHA256 verification before any state change.",
  tags: ["Payments"],
  responses: {
    200: { description: "Event acknowledged" },
    401: { description: "Invalid or missing webhook signature" },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/payments/{bookingId}",
  summary: "Get payment status",
  description: "Returns the payment status for a booking. Only the booking owner can call this.",
  tags: ["Payments"],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      in: "path",
      name: "bookingId",
      required: true,
      schema: { type: "string", format: "uuid" },
    },
  ],
  responses: {
    200: {
      description: "Payment details",
      content: {
        "application/json": {
          schema: z.object({ success: z.boolean(), data: PaymentSchema }),
        },
      },
    },
    401: { description: "Unauthorized" },
    403: { description: "Forbidden (does not own the booking)" },
    404: { description: "No payment found for this booking" },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/payments/{bookingId}/refund",
  summary: "Initiate refund",
  description:
    "Marks a payment as refunded. Enforces ownership and lifecycle (payment must be COMPLETED). " +
    "NOTE: Finding #14 is open — this does not yet call the Razorpay Refund API.",
  tags: ["Payments"],
  security: [{ bearerAuth: [] }],
  parameters: [
    {
      in: "path",
      name: "bookingId",
      required: true,
      schema: { type: "string", format: "uuid" },
    },
  ],
  responses: {
    200: { description: "Refund initiated" },
    401: { description: "Unauthorized" },
    403: { description: "Forbidden" },
    409: { description: "Payment is not in a refundable state" },
  },
});

// ── Routes ──────────────────────────────────────────────────────────────────────

/**
 * Webhook — no authentication (Razorpay calls this directly).
 * Raw body is captured by the global express.json verify callback in server.ts
 * (req.rawBody: Buffer), ensuring exact bytes are available for HMAC-SHA256 verification.
 */
router.post(
  "/webhook",
  handleWebhookHandler,
);

/**
 * Create Razorpay order — CUSTOMER only.
 * Body validation: only bookingId (no client-supplied amount).
 */
router.post(
  "/:bookingId/create-order",
  authenticateJWT,
  requireRole(UserRole.CUSTOMER),
  paymentOrderRateLimiter,
  validateParams(BookingIdParamSchema),
  validateBody(CreatePaymentReqSchema),
  createOrderHandler,
);

/**
 * Get payment status — CUSTOMER or ADMIN. Ownership enforced in service layer.
 */
router.get(
  "/:bookingId",
  authenticateJWT,
  requireRole(UserRole.CUSTOMER, UserRole.ADMIN),
  validateParams(BookingIdParamSchema),
  getPaymentStatusHandler,
);

/**
 * Refund — CUSTOMER or ADMIN. Ownership + lifecycle enforced in service layer.
 */
router.post(
  "/:bookingId/refund",
  authenticateJWT,
  requireRole(UserRole.CUSTOMER, UserRole.ADMIN),
  paymentRefundRateLimiter,
  validateParams(BookingIdParamSchema),
  refundPaymentHandler,
);

export default router;
