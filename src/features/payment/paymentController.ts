/**
 * Payment Controller — Issue #11 remediation
 *
 * Security guarantees:
 * - req.user.id (JWT principal) is the authoritative customer identity — never req.body.
 * - Amount is never accepted from the client for order creation.
 * - Raw body is passed to the webhook handler unchanged (signature verification requires this).
 */

import { Request, Response } from "express";
import {
  createOrder,
  getPaymentStatus,
  refundPayment,
  handleWebhook,
  PaymentError,
} from "./paymentServices";
import { RazorpayProviderError } from "../../providers/razorpay/razorpayProvider";
import { AuthenticatedRequest } from "../../middlewares/authMiddleware";

// ── Helper: map domain errors to HTTP responses ────────────────────────────────

function handlePaymentError(error: unknown, res: Response): void {
  if (error instanceof PaymentError) {
    res.status(error.statusCode).json({
      success: false,
      code: error.code,
      message: error.message,
    });
    return;
  }

  if (error instanceof RazorpayProviderError) {
    // Safe: never expose SDK internals
    res.status(error.statusCode).json({
      success: false,
      code: error.code,
      message: error.message,
    });
    return;
  }

  // Unknown error — log server-side, return generic message
  console.error("[paymentController] Unexpected error:", error);
  res.status(500).json({
    success: false,
    code: "PAYMENT_INTERNAL_ERROR",
    message: "An unexpected error occurred. Please try again.",
  });
}

// ── createOrder ─────────────────────────────────────────────────────────────────

/**
 * POST /api/payments/:bookingId/create-order
 *
 * Request body: { bookingId: string }  (amount is server-derived, never from client)
 * Requires: CUSTOMER role (enforced by requireRole middleware on the route)
 */
export const createOrderHandler = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    // Identity comes exclusively from the JWT principal
    const customerId = req.user!.id;
    const { bookingId } = req.params as any;

    const result = await createOrder(bookingId, customerId);

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (error) {
    handlePaymentError(error, res);
  }
};

// ── handleWebhook ───────────────────────────────────────────────────────────────

/**
 * POST /api/payments/webhook
 *
 * No authentication (Razorpay calls this endpoint directly).
 * Signature verification replaces authentication for this route.
 *
 * IMPORTANT: This route must receive the raw body buffer, not the JSON-parsed object.
 * The route is configured with express.raw() in paymentRoutes.ts.
 */
export const handleWebhookHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const rawSignature = req.headers["x-razorpay-signature"];
    const signature = Array.isArray(rawSignature) ? rawSignature[0] : rawSignature;

    if (!signature || typeof signature !== "string") {
      res.status(401).json({
        success: false,
        code: "WEBHOOK_MISSING_SIGNATURE",
        message: "Missing X-Razorpay-Signature header.",
      });
      return;
    }

    // req.rawBody is a Buffer captured by the express.json verify callback in server.ts.
    // This preserves the exact bytes Razorpay signed — required for HMAC verification.
    const rawBody: Buffer | undefined = (req as any).rawBody;
    if (!rawBody) {
      // Should not happen in production; means verify callback wasn't called
      res.status(400).json({
        success: false,
        code: "WEBHOOK_BODY_UNAVAILABLE",
        message: "Raw request body not available for signature verification.",
      });
      return;
    }

    const result = await handleWebhook(rawBody, signature);
    res.status(200).json(result);
  } catch (error) {
    handlePaymentError(error, res);
  }
};

// ── getPaymentStatus ────────────────────────────────────────────────────────────

/**
 * GET /api/payments/:bookingId
 * Requires: CUSTOMER role
 */
export const getPaymentStatusHandler = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const customerId = req.user!.id;
    const { bookingId } = req.params as any;

    const payment = await getPaymentStatus(bookingId, customerId);
    res.status(200).json({ success: true, data: payment });
  } catch (error) {
    handlePaymentError(error, res);
  }
};

// ── refundPayment ───────────────────────────────────────────────────────────────

/**
 * POST /api/payments/:bookingId/refund
 * Requires: CUSTOMER role
 */
export const refundPaymentHandler = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const customerId = req.user!.id;
    const { bookingId } = req.params as any;

    const result = await refundPayment(bookingId, customerId);
    res.status(200).json(result);
  } catch (error) {
    handlePaymentError(error, res);
  }
};
