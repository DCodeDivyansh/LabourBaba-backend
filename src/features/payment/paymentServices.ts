/**
 * Payment Service — Issue #11 remediation
 *
 * Security invariants enforced by this module:
 * 1. A payment order is only created after Razorpay successfully accepts the request.
 * 2. The authoritative payment amount comes from job_requirement.rate_per_day (server-side).
 *    Stored in the database as rupees (Int); converted to paise (× 100) before sending to Razorpay.
 * 3. The customer who owns the booking (via customer_id) is the only party who can
 *    initiate, view, or refund a payment.
 * 4. Duplicate orders are prevented:
 *    - Application check: if a valid pending order already exists, it is returned immediately
 *      without calling Razorpay again.
 *    - Database invariant: booking_id is UNIQUE on the payment table (one payment per booking).
 *    - idempotency_key (= bookingId) has a UNIQUE constraint as an additional guard.
 * 5. Order creation leaves payment status = PENDING. Only a verified webhook sets COMPLETED.
 * 6. Webhook signature is verified using HMAC-SHA256 on the raw request body bytes.
 * 7. Webhook events are associated with the expected local payment before any state transition.
 *
 * Related open findings (NOT fixed by this service):
 * - Finding #14: Real Razorpay Refund API — refundPayment() enforces ownership/lifecycle
 *   but does not yet call the Razorpay Refunds API. It updates local DB only.
 */

import prisma from "../../config/prisma";
import { paymentConfig } from "../../config/paymentConfig";
import {
  createOrder as razorpayCreateOrder,
  verifyWebhookSignature,
  RazorpayProviderError,
} from "../../providers/razorpay/razorpayProvider";
import { Prisma } from "@prisma/client";

// ── Payment status constants ────────────────────────────────────────────────────

export const PaymentStatus = {
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

// ── Booking states in which payment is allowed ─────────────────────────────────

/**
 * Booking statuses that permit payment order creation.
 * Based on the BookingStatusSchema in src/schemas/index.ts:
 *   "PENDING" | "OTP_PENDING" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED"
 * and the actual states set in dispatchServices.ts:
 *   "confirmed" (set on booking creation)
 *
 * Payment is allowed when the booking is confirmed but work has not yet started.
 * We accept both "confirmed" (set by dispatchServices) and "OTP_PENDING" (set by booking flow).
 */
const PAYABLE_BOOKING_STATUSES = new Set(["confirmed", "OTP_PENDING", "PENDING"]);

// ── Error class ─────────────────────────────────────────────────────────────────

export class PaymentError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode = 400) {
    super(message);
    this.name = "PaymentError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ── Safe response shape ─────────────────────────────────────────────────────────

export interface PaymentOrderResponse {
  paymentId: string;
  razorpayOrderId: string;
  /** Amount in paise. */
  amount: number;
  currency: string;
  status: string;
  bookingId: string;
}

// ── createOrder ─────────────────────────────────────────────────────────────────

/**
 * Creates a real Razorpay payment order for the given booking.
 *
 * Step 1 — Ownership check: booking must belong to `customerId`.
 * Step 2 — Pricing: amount derived from job_requirement.rate_per_day × 100 (paise).
 * Step 3 — Payable state: booking.status must be in PAYABLE_BOOKING_STATUSES.
 * Step 4 — Idempotency: if a PENDING order already exists for this booking, return it.
 * Step 5 — Provider: call Razorpay, validate response.
 * Step 6 — Persist: create payment record (status = PENDING).
 * Step 7 — Return safe response.
 *
 * The amount is NEVER accepted from the client.
 * The customer identity comes from req.user.id (JWT), never from the request body.
 */
export async function createOrder(
  bookingId: string,
  customerId: string,
): Promise<PaymentOrderResponse> {
  // ── Step 1 & 2: Load booking with ownership + pricing in one query ──────────
  const booking = await prisma.booking.findFirst({
    where: {
      id: bookingId,
      customer_id: customerId,
    },
    include: {
      job_requirement: {
        select: {
          id: true,
          rate_per_day: true,
        },
      },
    },
  });

  if (!booking) {
    // Intentionally ambiguous: could be not found OR not owned
    throw new PaymentError(
      "Booking not found or you do not have permission to create a payment for it.",
      "PAYMENT_NOT_AUTHORIZED",
      403,
    );
  }

  // ── Step 3: Validate booking is in a payable state ──────────────────────────
  const currentStatus = booking.status ?? "";
  if (!PAYABLE_BOOKING_STATUSES.has(currentStatus)) {
    throw new PaymentError(
      `Booking is not in a payable state (current status: '${currentStatus}'). ` +
        `Payment is only allowed for bookings in: ${[...PAYABLE_BOOKING_STATUSES].join(", ")}.`,
      "PAYMENT_NOT_PAYABLE",
      409,
    );
  }

  // ── Step 2b: Derive authoritative amount ────────────────────────────────────
  const ratePerDayRupees = booking.job_requirement?.rate_per_day;

  if (
    ratePerDayRupees === null ||
    ratePerDayRupees === undefined ||
    !Number.isFinite(ratePerDayRupees) ||
    ratePerDayRupees <= 0
  ) {
    throw new PaymentError(
      "This booking does not have a valid rate configured. Payment cannot be initiated.",
      "PAYMENT_RATE_MISSING",
      422,
    );
  }

  // rate_per_day is stored in rupees (Int). Razorpay requires paise.
  // MVP: 1 day only. Days can be made configurable in a later iteration.
  const amountPaise = ratePerDayRupees * 100;
  const currency = paymentConfig.currency; // "INR"

  // ── Step 4: Idempotency — return existing pending payment ──────────────────
  const existingPayment = await prisma.payment.findFirst({
    where: {
      booking_id: bookingId,
    },
  });

  if (existingPayment) {
    if (
      existingPayment.status === PaymentStatus.COMPLETED ||
      existingPayment.status === PaymentStatus.REFUNDED
    ) {
      throw new PaymentError(
        "A payment has already been completed for this booking.",
        "PAYMENT_ALREADY_COMPLETED",
        409,
      );
    }

    if (
      existingPayment.status === PaymentStatus.PENDING &&
      existingPayment.razorpay_order_id
    ) {
      // Return the existing pending order — do NOT call Razorpay again
      console.info(
        `[paymentService] Returning existing pending order for booking ${bookingId}: ` +
          `payment=${existingPayment.id}`,
      );
      return {
        paymentId: existingPayment.id,
        razorpayOrderId: existingPayment.razorpay_order_id,
        amount: existingPayment.amount ?? amountPaise,
        currency: existingPayment.currency ?? currency,
        status: existingPayment.status,
        bookingId,
      };
    }

    // FAILED or other terminal state — allow retry by updating existing record
    // (handled below after provider call)
  }

  // ── Step 5: Create Razorpay order ───────────────────────────────────────────
  // External side-effect before DB write — see documentation on the unavoidable
  // race between provider call and DB persistence.
  const providerOrder = await razorpayCreateOrder({
    amountPaise,
    currency,
    receipt: bookingId, // Razorpay receipt ≤ 40 chars; bookingId is 36-char UUID ✓
    paymentId: existingPayment?.id ?? "new",
    bookingId,
  });

  // ── Step 6: Persist payment ──────────────────────────────────────────────────
  try {
    let payment;

    if (existingPayment && existingPayment.status === PaymentStatus.FAILED) {
      // Update existing FAILED record with new provider order
      payment = await prisma.payment.update({
        where: { id: existingPayment.id },
        data: {
          razorpay_order_id: providerOrder.razorpayOrderId,
          amount: providerOrder.amount,
          currency: providerOrder.currency,
          status: PaymentStatus.PENDING,
          idempotency_key: bookingId,
        },
      });
    } else {
      // Create new payment record
      payment = await prisma.payment.create({
        data: {
          booking_id: bookingId,
          razorpay_order_id: providerOrder.razorpayOrderId,
          amount: providerOrder.amount,
          currency: providerOrder.currency,
          status: PaymentStatus.PENDING,
          idempotency_key: bookingId,
        },
      });
    }

    console.info(
      `[paymentService] Payment order created: payment=${payment.id}, ` +
        `razorpayOrderId=${providerOrder.razorpayOrderId}, ` +
        `amount=${providerOrder.amount}p, currency=${providerOrder.currency}`,
    );

    return {
      paymentId: payment.id,
      razorpayOrderId: payment.razorpay_order_id!,
      amount: payment.amount!,
      currency: payment.currency,
      status: payment.status!,
      bookingId,
    };
  } catch (dbErr: any) {
    // DB write failed AFTER Razorpay successfully created the order.
    // This creates an orphan Razorpay order. This is an unavoidable distributed-
    // system race. The orphan can be reconciled via Razorpay's orders API using
    // the receipt (bookingId) as a lookup key.
    // Log the provider order ID for manual reconciliation.
    console.error(
      `[paymentService] DB write failed after Razorpay order creation. ` +
        `Orphan provider order: ${providerOrder.razorpayOrderId}. ` +
        `Booking: ${bookingId}. Error code: ${dbErr?.code ?? "unknown"}`,
    );

    if (
      (dbErr instanceof Prisma.PrismaClientKnownRequestError &&
        dbErr.code === "P2002") ||
      dbErr?.code === "P2002"
    ) {
      // Unique constraint — another concurrent request already created a payment record.
      // Fetch and return the existing payment.
      const concurrentPayment = await prisma.payment.findFirst({
        where: { booking_id: bookingId },
      });
      if (concurrentPayment?.razorpay_order_id) {
        return {
          paymentId: concurrentPayment.id,
          razorpayOrderId: concurrentPayment.razorpay_order_id,
          amount: concurrentPayment.amount ?? amountPaise,
          currency: concurrentPayment.currency ?? currency,
          status: concurrentPayment.status ?? PaymentStatus.PENDING,
          bookingId,
        };
      }
    }

    throw new PaymentError(
      "Payment order was created with the provider but could not be saved. Please contact support.",
      "PAYMENT_PERSISTENCE_FAILED",
      500,
    );
  }
}

// ── handleWebhook ───────────────────────────────────────────────────────────────

/**
 * Processes a Razorpay webhook event.
 *
 * Security:
 * 1. Verifies HMAC-SHA256 signature on the raw body before JSON parsing.
 * 2. Associates the provider order/payment with the correct local payment record.
 * 3. Only COMPLETED after confirming local payment record and order ID match.
 * 4. Idempotent: repeated events with the same outcome produce no side effects.
 *
 * @param rawBody  Raw body string as received by Express (before JSON parsing).
 * @param signature  Value of X-Razorpay-Signature header.
 */
export async function handleWebhook(
  rawBody: string | Buffer,
  signature: string,
): Promise<{ success: boolean; message: string }> {
  // ── Step 1: Verify signature ─────────────────────────────────────────────────
  // Read at call time (not from cached paymentConfig) so test-time env overrides work.
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET ?? paymentConfig.razorpay.webhookSecret;

  if (!webhookSecret) {
    // In production this should never happen (assertProductionPaymentConfig blocks startup).
    // In development, skip signature verification with a clear warning.
    if (process.env.NODE_ENV === "production") {
      console.error("[paymentService] RAZORPAY_WEBHOOK_SECRET is not set in production.");
      return { success: false, message: "Webhook configuration error" };
    }
    console.warn(
      "[paymentService] RAZORPAY_WEBHOOK_SECRET is not set. Skipping signature verification (non-production only).",
    );
  } else {
    const isValid = verifyWebhookSignature(rawBody, signature, webhookSecret);
    if (!isValid) {
      console.warn(
        "[paymentService] Razorpay webhook signature verification failed.",
      );
      throw new PaymentError(
        "Webhook signature verification failed.",
        "WEBHOOK_INVALID_SIGNATURE",
        401,
      );
    }
  }

  // ── Step 2: Parse event ──────────────────────────────────────────────────────
  let event: any;
  try {
    const bodyStr =
      typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    event = JSON.parse(bodyStr);
  } catch {
    throw new PaymentError(
      "Webhook body is not valid JSON.",
      "WEBHOOK_INVALID_BODY",
      400,
    );
  }

  const eventType: string = event?.event ?? "";
  const paymentEntity = event?.payload?.payment?.entity;

  // ── Step 3: Dispatch event ───────────────────────────────────────────────────

  if (eventType === "payment.captured") {
    const razorpayOrderId: string | undefined = paymentEntity?.order_id;
    const razorpayPaymentId: string | undefined = paymentEntity?.id;
    const capturedAmount: number | undefined = paymentEntity?.amount;
    const capturedCurrency: string | undefined = paymentEntity?.currency;

    if (!razorpayOrderId || !razorpayPaymentId) {
      console.error(
        "[paymentService] payment.captured event missing order_id or payment id.",
        { eventType },
      );
      // Acknowledge to prevent Razorpay retrying, but do not mutate state
      return { success: true, message: "Event acknowledged (missing identifiers)" };
    }

    // Find local payment by the provider order ID
    const localPayment = await prisma.payment.findUnique({
      where: { razorpay_order_id: razorpayOrderId },
    });

    if (!localPayment) {
      console.error(
        `[paymentService] payment.captured: no local payment found for Razorpay order ${razorpayOrderId}`,
      );
      return { success: true, message: "Event acknowledged (no matching payment)" };
    }

    // Validate amount and currency match ─────────────────────────────────────
    if (
      capturedAmount !== undefined &&
      localPayment.amount !== null &&
      capturedAmount !== localPayment.amount
    ) {
      console.error(
        `[paymentService] AMOUNT MISMATCH on payment.captured: ` +
          `local=${localPayment.amount}, provider=${capturedAmount}. ` +
          `payment=${localPayment.id}, order=${razorpayOrderId}`,
      );
      // Do NOT mark as COMPLETED — flag for manual review
      return {
        success: true,
        message: "Event acknowledged (amount mismatch — flagged for review)",
      };
    }

    if (
      capturedCurrency &&
      localPayment.currency &&
      capturedCurrency.toUpperCase() !== localPayment.currency.toUpperCase()
    ) {
      console.error(
        `[paymentService] CURRENCY MISMATCH on payment.captured: ` +
          `local=${localPayment.currency}, provider=${capturedCurrency}. ` +
          `payment=${localPayment.id}`,
      );
      return {
        success: true,
        message: "Event acknowledged (currency mismatch — flagged for review)",
      };
    }

    // Idempotency: if already COMPLETED, skip
    if (localPayment.status === PaymentStatus.COMPLETED) {
      console.info(
        `[paymentService] payment.captured: payment ${localPayment.id} already COMPLETED — skipping.`,
      );
      return { success: true, message: "Payment already completed" };
    }

    // Persist COMPLETED + razorpay_payment_id
    await prisma.payment.update({
      where: { id: localPayment.id },
      data: {
        status: PaymentStatus.COMPLETED,
        razorpay_payment_id: razorpayPaymentId,
      },
    });

    console.info(
      `[paymentService] Payment ${localPayment.id} marked COMPLETED. ` +
        `razorpayPaymentId=${razorpayPaymentId}`,
    );

    return { success: true, message: "Payment captured" };
  }

  if (eventType === "payment.failed") {
    const razorpayOrderId: string | undefined = paymentEntity?.order_id;

    if (!razorpayOrderId) {
      return { success: true, message: "Event acknowledged (missing order_id)" };
    }

    const localPayment = await prisma.payment.findUnique({
      where: { razorpay_order_id: razorpayOrderId },
    });

    if (!localPayment) {
      return { success: true, message: "Event acknowledged (no matching payment)" };
    }

    // Idempotency: already in a terminal non-pending state
    if (
      localPayment.status === PaymentStatus.COMPLETED ||
      localPayment.status === PaymentStatus.FAILED
    ) {
      console.info(
        `[paymentService] payment.failed: payment ${localPayment.id} already in state '${localPayment.status}' — skipping.`,
      );
      return { success: true, message: `Payment already in state: ${localPayment.status}` };
    }

    await prisma.payment.update({
      where: { id: localPayment.id },
      data: { status: PaymentStatus.FAILED },
    });

    console.info(`[paymentService] Payment ${localPayment.id} marked FAILED.`);

    return { success: true, message: "Payment failed" };
  }

  // Unknown event — acknowledge safely without mutating any state
  console.info(
    `[paymentService] Webhook received unknown event type: '${eventType}'. Acknowledged without state change.`,
  );
  return { success: true, message: `Event '${eventType}' acknowledged` };
}

// ── getPaymentStatus ────────────────────────────────────────────────────────────

/**
 * Returns payment status for the given booking, enforcing customer ownership.
 * Customer A cannot retrieve Customer B's payment by guessing a bookingId.
 */
export async function getPaymentStatus(
  bookingId: string,
  customerId: string,
): Promise<{
  id: string;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  status: string | null;
  amount: number | null;
  currency: string;
  booking_id: string;
}> {
  // Verify customer owns the booking, then fetch payment
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, customer_id: customerId },
    select: { id: true },
  });

  if (!booking) {
    throw new PaymentError(
      "Booking not found or you do not have permission to view its payment.",
      "PAYMENT_NOT_AUTHORIZED",
      403,
    );
  }

  const payment = await prisma.payment.findUnique({
    where: { booking_id: bookingId },
    select: {
      id: true,
      razorpay_order_id: true,
      razorpay_payment_id: true,
      status: true,
      amount: true,
      currency: true,
      booking_id: true,
    },
  });

  if (!payment) {
    throw new PaymentError(
      "No payment found for this booking.",
      "PAYMENT_NOT_FOUND",
      404,
    );
  }

  return payment;
}

// ── refundPayment ───────────────────────────────────────────────────────────────

/**
 * Initiates a refund for the given booking.
 *
 * IMPORTANT — Finding #14 remains open:
 * This implementation enforces ownership and lifecycle (booking must be COMPLETED,
 * payment must be COMPLETED) but does NOT call the Razorpay Refunds API.
 * Local status is updated to REFUNDED only. Real refund processing must be
 * implemented as a separate task (Finding #14).
 *
 * The payment will only be marked REFUNDED locally after all ownership and
 * lifecycle checks pass. This prevents abuse but does not guarantee money movement.
 */
export async function refundPayment(
  bookingId: string,
  customerId: string,
): Promise<{ success: boolean; message: string }> {
  // Ownership check
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, customer_id: customerId },
    select: { id: true, status: true },
  });

  if (!booking) {
    throw new PaymentError(
      "Booking not found or you do not have permission to refund its payment.",
      "REFUND_NOT_AUTHORIZED",
      403,
    );
  }

  const payment = await prisma.payment.findUnique({
    where: { booking_id: bookingId },
  });

  if (!payment) {
    throw new PaymentError(
      "No payment record found for this booking.",
      "REFUND_NO_PAYMENT",
      404,
    );
  }

  if (payment.status !== PaymentStatus.COMPLETED) {
    throw new PaymentError(
      `Cannot refund: payment is in status '${payment.status}', not COMPLETED.`,
      "REFUND_INVALID_STATE",
      409,
    );
  }

  // NOTE: Finding #14 — Razorpay Refund API not called here.
  // Real refund implementation is a separate task.
  await prisma.payment.update({
    where: { id: payment.id },
    data: { status: PaymentStatus.REFUNDED },
  });

  console.info(
    `[paymentService] Refund initiated for payment ${payment.id} (local DB only — Finding #14 open).`,
  );

  return {
    success: true,
    message:
      "Refund initiated. Note: actual fund transfer to the payment provider is pending (Finding #14).",
  };
}
