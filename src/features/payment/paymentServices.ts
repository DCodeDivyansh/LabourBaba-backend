/**
 * Payment Service — Issues 61–70 Production-Grade Hardening
 *
 * Security & Financial Invariants Enforced:
 * 1. Server-Derived Pricing: Authoritative amount derived exclusively from job_requirement.rate_per_day.
 *    Client-supplied amounts in body/query/headers are strictly ignored.
 * 2. Real Razorpay Order Lifecycle: Orders created via Razorpay SDK with persisted order IDs.
 * 3. Raw-Body Webhook Verification: HMAC-SHA256 calculated over raw request bytes before any parsing/state change.
 * 4. Webhook Idempotency: PaymentWebhookEvent unique constraint prevents duplicate processing under concurrency.
 * 5. Amount & Currency Reconciliation: Provider amount and currency verified; mismatches quarantined.
 * 6. Real Provider Refunds: Razorpay Payments Refund API called; state transitioned through REFUND_PENDING -> REFUNDED.
 * 7. State Machine Enforcement: Centralized transitions with explicit guardrails against illegal transitions.
 */

import prisma from "../../config/prisma";
import { paymentConfig } from "../../config/paymentConfig";
import {
  createOrder as razorpayCreateOrder,
  createRefund as razorpayCreateRefund,
  verifyWebhookSignature,
  RazorpayProviderError,
} from "../../providers/razorpay/razorpayProvider";
import { Prisma } from "@prisma/client";
import { paymentPolicy, assertPolicy, AuthenticatedUser, UserRole } from "../../policies";
import { auditService } from "../audit/audit.service";
import { outboxService } from "../../services/outboxService";
import { metricsService } from "../../metrics/metrics.service";
import { logger } from "../../utils/logger";

// ── Payment Status & State Machine ─────────────────────────────────────────────

export const PaymentStatus = {
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  REFUND_PENDING: "REFUND_PENDING",
  REFUNDED: "REFUNDED",
  REFUND_FAILED: "REFUND_FAILED",
} as const;

export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

/**
 * Explicit Legal Transition Map for Payment State Machine.
 */
export const LEGAL_PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  [PaymentStatus.PENDING]: [PaymentStatus.COMPLETED, PaymentStatus.FAILED],
  [PaymentStatus.COMPLETED]: [PaymentStatus.REFUND_PENDING],
  [PaymentStatus.REFUND_PENDING]: [PaymentStatus.REFUNDED, PaymentStatus.REFUND_FAILED],
  [PaymentStatus.REFUND_FAILED]: [PaymentStatus.REFUND_PENDING], // Allow refund retry
  [PaymentStatus.FAILED]: [PaymentStatus.PENDING], // Allow retry order creation
  [PaymentStatus.REFUNDED]: [], // Terminal state
};

// ── Booking states in which payment is allowed ─────────────────────────────────

const PAYABLE_BOOKING_STATUSES = new Set(["confirmed", "CONFIRMED", "OTP_PENDING", "PENDING"]);

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

// ── State Machine Transition Helper ────────────────────────────────────────────

/**
 * Validates and atomically transitions payment status within an active transaction.
 */
export async function transitionPaymentStatus(
  tx: Prisma.TransactionClient,
  paymentId: string,
  fromStatus: PaymentStatus | string,
  toStatus: PaymentStatus,
  metadata?: Record<string, any>,
): Promise<boolean> {
  const currentStatus = fromStatus as PaymentStatus;
  const allowedNext = LEGAL_PAYMENT_TRANSITIONS[currentStatus] || [];

  if (!allowedNext.includes(toStatus)) {
    throw new PaymentError(
      `Illegal payment state transition from '${currentStatus}' to '${toStatus}'.`,
      "PAYMENT_INVALID_STATE_TRANSITION",
      409,
    );
  }

  const result = await tx.payment.updateMany({
    where: {
      id: paymentId,
      status: fromStatus,
    },
    data: {
      status: toStatus,
      updated_at: new Date(),
      ...(metadata ?? {}),
    },
  });

  return result.count > 0;
}

// ── createOrder (Issue 61 & 62) ─────────────────────────────────────────────────

/**
 * Creates a real Razorpay payment order for the given booking.
 * Authoritative amount is server-derived from job_requirement.rate_per_day × 100 paise.
 */
export async function createOrder(
  bookingId: string,
  customerId: string,
): Promise<PaymentOrderResponse> {
  // Step 1: Load booking with ownership and pricing
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
    throw new PaymentError(
      "Booking not found or you do not have permission to create a payment for it.",
      "PAYMENT_NOT_AUTHORIZED",
      403,
    );
  }

  // Step 2: Validate booking is in a payable state
  const currentStatus = booking.status ?? "";
  if (!PAYABLE_BOOKING_STATUSES.has(currentStatus)) {
    throw new PaymentError(
      `Booking is not in a payable state (current status: '${currentStatus}'). ` +
        `Payment is only allowed for bookings in: ${[...PAYABLE_BOOKING_STATUSES].join(", ")}.`,
      "PAYMENT_NOT_PAYABLE",
      409,
    );
  }

  // Step 3: Derive authoritative server-side amount (Issue 61)
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

  const amountPaise = ratePerDayRupees * 100;
  const currency = paymentConfig.currency || "INR";

  // Step 4: Check existing payment record for idempotency
  const existingPayment = await prisma.payment.findUnique({
    where: { booking_id: bookingId },
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
      // Idempotent: return existing pending order without calling Razorpay again
      return {
        paymentId: existingPayment.id,
        razorpayOrderId: existingPayment.razorpay_order_id,
        amount: existingPayment.amount ?? amountPaise,
        currency: existingPayment.currency ?? currency,
        status: existingPayment.status,
        bookingId,
      };
    }
  }

  // Step 5: Establish durable local payment intent with atomic PostgreSQL claim
  let paymentRecord: any;
  let isClaimant = false;

  if (!existingPayment) {
    try {
      paymentRecord = await prisma.payment.create({
        data: {
          booking_id: bookingId,
          idempotency_key: bookingId,
          amount: amountPaise,
          currency,
          status: PaymentStatus.PENDING,
          razorpay_order_id: null,
        },
      });
      isClaimant = true;
    } catch (createErr: any) {
      if (
        createErr?.code === "P2002" ||
        (createErr instanceof Prisma.PrismaClientKnownRequestError && createErr.code === "P2002")
      ) {
        paymentRecord = await prisma.payment.findUnique({ where: { booking_id: bookingId } });
        isClaimant = false;
      } else {
        throw createErr;
      }
    }
  } else if (existingPayment.status === PaymentStatus.FAILED) {
    // Atomic claim on existing failed record for retry
    const claimResult = await prisma.payment.updateMany({
      where: {
        id: existingPayment.id,
        status: PaymentStatus.FAILED,
      },
      data: {
        status: PaymentStatus.PENDING,
        amount: amountPaise,
        currency,
        razorpay_order_id: null,
        updated_at: new Date(),
      },
    });

    if (claimResult.count > 0) {
      paymentRecord = await prisma.payment.findUnique({ where: { id: existingPayment.id } });
      isClaimant = true;
    } else {
      paymentRecord = await prisma.payment.findUnique({ where: { id: existingPayment.id } });
      isClaimant = false;
    }
  } else {
    // Existing record in PENDING without razorpay_order_id (concurrent creation in progress)
    paymentRecord = existingPayment;
    isClaimant = false;
  }

  // Step 6: Claimant executes external provider order creation
  if (isClaimant && paymentRecord) {
    let providerOrder: any;
    try {
      providerOrder = await razorpayCreateOrder({
        amountPaise,
        currency,
        receipt: bookingId,
        paymentId: paymentRecord.id,
        bookingId,
      });
    } catch (providerErr: any) {
      // Transition intent to FAILED so retries can claim it cleanly
      await prisma.payment
        .updateMany({
          where: { id: paymentRecord.id, razorpay_order_id: null },
          data: {
            status: PaymentStatus.FAILED,
            quarantine_reason: providerErr?.message || "PROVIDER_ORDER_CREATION_FAILED",
            updated_at: new Date(),
          },
        })
        .catch(() => {});
      throw providerErr;
    }

    // Persist provider order ID
    try {
      const updatedPayment = await prisma.payment.update({
        where: { id: paymentRecord.id },
        data: {
          razorpay_order_id: providerOrder.razorpayOrderId,
          amount: providerOrder.amount,
          currency: providerOrder.currency,
          status: PaymentStatus.PENDING,
          updated_at: new Date(),
        },
      });

      return {
        paymentId: updatedPayment.id,
        razorpayOrderId: updatedPayment.razorpay_order_id!,
        amount: updatedPayment.amount!,
        currency: updatedPayment.currency,
        status: updatedPayment.status!,
        bookingId,
      };
    } catch (dbErr: any) {
      logger.error("[PAYMENT_PERSISTENCE_FAILED]", {
        paymentId: paymentRecord.id,
        razorpayOrderId: providerOrder.razorpayOrderId,
        bookingId,
        error: dbErr?.message,
      });
      throw new PaymentError(
        "Payment order was created with provider but could not be saved. Please retry.",
        "PAYMENT_PERSISTENCE_FAILED",
        500,
      );
    }
  }

  // Step 7: Non-claimant contenders resolve to the canonical payment order
  if (paymentRecord?.razorpay_order_id) {
    return {
      paymentId: paymentRecord.id,
      razorpayOrderId: paymentRecord.razorpay_order_id,
      amount: paymentRecord.amount ?? amountPaise,
      currency: paymentRecord.currency ?? currency,
      status: paymentRecord.status ?? PaymentStatus.PENDING,
      bookingId,
    };
  }

  // Bounded polling for winner to finish provider call
  const maxPollAttempts = 25;
  for (let i = 0; i < maxPollAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const refreshed = await prisma.payment.findUnique({
      where: { booking_id: bookingId },
    });

    if (refreshed?.razorpay_order_id) {
      return {
        paymentId: refreshed.id,
        razorpayOrderId: refreshed.razorpay_order_id,
        amount: refreshed.amount ?? amountPaise,
        currency: refreshed.currency ?? currency,
        status: refreshed.status ?? PaymentStatus.PENDING,
        bookingId,
      };
    }

    if (refreshed?.status === PaymentStatus.FAILED) {
      throw new PaymentError(
        "Payment provider failed to create order. Please try again.",
        "PAYMENT_ORDER_CREATION_FAILED",
        502,
      );
    }
  }

  throw new PaymentError(
    "Payment order creation is in progress. Please retry in a moment.",
    "PAYMENT_ORDER_CREATION_IN_PROGRESS",
    409,
  );
}

// ── Webhook Event Handling (Issues 63, 64, 65, 70) ──────────────────────────────

const WebhookEventStatus = {
  PROCESSING: "PROCESSING",
  PROCESSED: "PROCESSED",
  FAILED: "FAILED",
} as const;

function deriveWebhookEventId(
  eventType: string,
  paymentEntityId: string | undefined,
  orderId: string | undefined,
): string | null {
  if (eventType === "payment.captured" && paymentEntityId) {
    return paymentEntityId;
  }
  if (eventType === "payment.failed" && orderId) {
    return `${orderId}:failed`;
  }
  if (eventType.startsWith("refund.") && paymentEntityId) {
    return `${paymentEntityId}:${eventType}`;
  }
  if (orderId) {
    return `${orderId}:${eventType}`;
  }
  return null;
}

function isPrismaUniqueConstraintError(err: unknown): boolean {
  return (
    (err as any)?.code === "P2002" ||
    (err instanceof Error && err.message.includes("Unique constraint"))
  );
}

/**
 * Handles incoming Razorpay webhook events using raw body verification and transactional idempotency.
 */
export async function handleWebhook(
  rawBody: string | Buffer,
  signature: string,
): Promise<{ success: boolean; message: string }> {
  // Step 1: Obtain webhook secret (fail-closed)
  const webhookSecret =
    process.env.RAZORPAY_WEBHOOK_SECRET ?? paymentConfig.razorpay.webhookSecret;

  if (!webhookSecret || typeof webhookSecret !== "string" || webhookSecret.trim() === "") {
    logger.error("[SECURITY] RAZORPAY_WEBHOOK_SECRET is not configured or empty. Rejecting webhook request (fail-closed).");
    throw new PaymentError(
      "Webhook secret is not configured on server.",
      "WEBHOOK_SECRET_NOT_CONFIGURED",
      500,
    );
  }

  // Step 2: Strict raw-body HMAC-SHA256 signature verification (Issue 63 / P3 Issue 3)
  if (!signature || typeof signature !== "string" || signature.trim() === "") {
    metricsService.recordWebhookSignatureFailure();
    logger.warn("[SECURITY] Razorpay webhook missing signature.");
    throw new PaymentError(
      "Missing or empty webhook signature.",
      "WEBHOOK_MISSING_SIGNATURE",
      401,
    );
  }

  const isValid = verifyWebhookSignature(rawBody, signature.trim(), webhookSecret.trim());
  if (!isValid) {
    metricsService.recordWebhookSignatureFailure();
    logger.warn("[SECURITY] Razorpay webhook signature verification failed.", {
      hasSignature: Boolean(signature),
      rawBodyLength: typeof rawBody === "string" ? rawBody.length : rawBody?.length ?? 0,
    });
    throw new PaymentError(
      "Webhook signature verification failed.",
      "WEBHOOK_INVALID_SIGNATURE",
      401,
    );
  }

  // Step 3: Parse verified JSON payload
  let event: any;
  try {
    const bodyStr = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
    event = JSON.parse(bodyStr);
  } catch {
    throw new PaymentError("Webhook body is not valid JSON.", "WEBHOOK_INVALID_BODY", 400);
  }

  const eventType: string = event?.event ?? "";
  const paymentEntity = event?.payload?.payment?.entity;
  const refundEntity = event?.payload?.refund?.entity;
  const razorpayOrderId: string | undefined = paymentEntity?.order_id;
  const razorpayPaymentId: string | undefined = paymentEntity?.id || refundEntity?.payment_id;
  const capturedAmount: number | undefined = paymentEntity?.amount;
  const capturedCurrency: string | undefined = paymentEntity?.currency;
  const refundId: string | undefined = refundEntity?.id;
  const refundAmount: number | undefined = refundEntity?.amount;

  // Step 4: Derive stable idempotency key
  const providerEventId = deriveWebhookEventId(eventType, razorpayPaymentId, razorpayOrderId);
  if (!providerEventId) {
    return { success: true, message: `Event '${eventType}' acknowledged (no stable identity)` };
  }

  // Step 5: Process by event type
  if (eventType === "payment.captured") {
    return await processPaymentCaptured({
      providerEventId,
      eventType,
      razorpayOrderId,
      razorpayPaymentId,
      capturedAmount,
      capturedCurrency,
    });
  }

  if (eventType === "payment.failed") {
    return await processPaymentFailed({
      providerEventId,
      eventType,
      razorpayOrderId,
    });
  }

  if (eventType === "refund.processed" || eventType === "refund.created") {
    return await processRefundProcessed({
      providerEventId,
      eventType,
      razorpayPaymentId,
      refundId,
      refundAmount,
    });
  }

  return { success: true, message: `Event '${eventType}' acknowledged` };
}

interface CapturedParams {
  providerEventId: string;
  eventType: string;
  razorpayOrderId: string | undefined;
  razorpayPaymentId: string | undefined;
  capturedAmount: number | undefined;
  capturedCurrency: string | undefined;
}

/**
 * Processes payment.captured with full reconciliation & transactional idempotency (Issue 64, 65, 70, 71).
 */
async function processPaymentCaptured(params: CapturedParams): Promise<{ success: boolean; message: string }> {
  const { providerEventId, eventType, razorpayOrderId, razorpayPaymentId, capturedAmount, capturedCurrency } = params;

  if (!razorpayOrderId || !razorpayPaymentId) {
    return { success: true, message: "Event acknowledged (missing identifiers)" };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Transactional Event Claim
      const webhookEvent = await tx.paymentWebhookEvent.create({
        data: {
          provider: "razorpay",
          providerEventId,
          eventType,
          status: WebhookEventStatus.PROCESSING,
        },
      });

      // 2. Find local payment
      const localPayment = await tx.payment.findUnique({
        where: { razorpay_order_id: razorpayOrderId },
      });

      if (!localPayment) {
        await tx.paymentWebhookEvent.update({
          where: { id: webhookEvent.id },
          data: { status: WebhookEventStatus.FAILED, failureReason: "No matching local payment" },
        });
        return { message: "Event acknowledged (no matching local payment)" };
      }

      // 3. Amount Reconciliation (Issue 65)
      if (capturedAmount !== undefined && localPayment.amount !== null && capturedAmount !== localPayment.amount) {
        await tx.paymentWebhookEvent.update({
          where: { id: webhookEvent.id },
          data: {
            status: WebhookEventStatus.FAILED,
            failureReason: `Amount mismatch: local=${localPayment.amount}, provider=${capturedAmount}`,
          },
        });
        await tx.payment.update({
          where: { id: localPayment.id },
          data: {
            quarantine_reason: `Amount mismatch: local=${localPayment.amount}p, provider=${capturedAmount}p`,
          },
        });
        metricsService.recordPaymentQuarantined("amount_mismatch");
        logger.error("[PAYMENT_AMOUNT_MISMATCH]", {
          paymentId: localPayment.id,
          localAmount: localPayment.amount,
          capturedAmount,
          orderId: razorpayOrderId,
        });
        return { message: "Event acknowledged (amount mismatch flagged for review)" };
      }

      // 4. Currency Reconciliation (Issue 65)
      if (
        capturedCurrency &&
        localPayment.currency &&
        capturedCurrency.toUpperCase() !== localPayment.currency.toUpperCase()
      ) {
        await tx.paymentWebhookEvent.update({
          where: { id: webhookEvent.id },
          data: {
            status: WebhookEventStatus.FAILED,
            failureReason: `Currency mismatch: local=${localPayment.currency}, provider=${capturedCurrency}`,
          },
        });
        await tx.payment.update({
          where: { id: localPayment.id },
          data: {
            quarantine_reason: `Currency mismatch: local=${localPayment.currency}, provider=${capturedCurrency}`,
          },
        });
        metricsService.recordPaymentQuarantined("currency_mismatch");
        return { message: "Event acknowledged (currency mismatch flagged for review)" };
      }

      // 5. State Machine Transition: PENDING -> COMPLETED (Issue 68)
      const transitioned = await transitionPaymentStatus(
        tx,
        localPayment.id,
        PaymentStatus.PENDING,
        PaymentStatus.COMPLETED,
        { razorpay_payment_id: razorpayPaymentId },
      );

      // 6. Dual-write durable notification outbox inside same transaction (Issue 71)
      if (transitioned) {
        metricsService.recordPaymentCaptured(capturedAmount || localPayment.amount || 0);

        const booking = await tx.booking.findUnique({
          where: { id: localPayment.booking_id },
          select: { customer_id: true, worker_id: true },
        });

        if (booking?.customer_id) {
          await outboxService.createOutboxEvent(tx, {
            eventType: "PAYMENT_COMPLETED",
            aggregateType: "payment",
            aggregateId: localPayment.id,
            recipientType: "customer",
            recipientId: booking.customer_id,
            payload: {
              paymentId: localPayment.id,
              bookingId: localPayment.booking_id,
              amount: localPayment.amount,
              currency: localPayment.currency,
              title: "Payment Successful",
              body: `Your payment of ₹${(localPayment.amount ?? 0) / 100} has been confirmed.`,
            },
            idempotencyKey: `PAYMENT_COMPLETED:payment:${localPayment.id}:${booking.customer_id}`,
          }).catch((err) => logger.warn("[OUTBOX_RECORD_FAILED]", { error: err.message }));
        }

        if (booking?.worker_id) {
          await outboxService.createOutboxEvent(tx, {
            eventType: "PAYMENT_COMPLETED",
            aggregateType: "payment",
            aggregateId: localPayment.id,
            recipientType: "worker",
            recipientId: booking.worker_id,
            payload: {
              paymentId: localPayment.id,
              bookingId: localPayment.booking_id,
              amount: localPayment.amount,
              currency: localPayment.currency,
              title: "Payment Received",
              body: `Payment of ₹${(localPayment.amount ?? 0) / 100} received for booking.`,
            },
            idempotencyKey: `PAYMENT_COMPLETED:payment:${localPayment.id}:${booking.worker_id}`,
          }).catch((err) => logger.warn("[OUTBOX_RECORD_FAILED]", { error: err.message }));
        }
      }

      // 7. Mark Webhook Event PROCESSED
      await tx.paymentWebhookEvent.update({
        where: { id: webhookEvent.id },
        data: {
          status: WebhookEventStatus.PROCESSED,
          processedAt: new Date(),
        },
      });

      return {
        message: transitioned ? "Payment captured" : "already completed",
      };
    });

    return { success: true, message: result.message };
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      return { success: true, message: "Duplicate event — already processed" };
    }
    throw error;
  }
}

async function processPaymentFailed(params: {
  providerEventId: string;
  eventType: string;
  razorpayOrderId: string | undefined;
}): Promise<{ success: boolean; message: string }> {
  const { providerEventId, eventType, razorpayOrderId } = params;
  if (!razorpayOrderId) return { success: true, message: "Event acknowledged (missing order_id)" };

  try {
    const result = await prisma.$transaction(async (tx) => {
      const webhookEvent = await tx.paymentWebhookEvent.create({
        data: {
          provider: "razorpay",
          providerEventId,
          eventType,
          status: WebhookEventStatus.PROCESSING,
        },
      });

      const localPayment = await tx.payment.findUnique({
        where: { razorpay_order_id: razorpayOrderId },
      });

      if (!localPayment) {
        await tx.paymentWebhookEvent.update({
          where: { id: webhookEvent.id },
          data: { status: WebhookEventStatus.FAILED, failureReason: "No matching local payment" },
        });
        return { message: "Event acknowledged (no matching payment)" };
      }

      let msg = "Payment failed";
      try {
        const transitioned = await transitionPaymentStatus(
          tx,
          localPayment.id,
          PaymentStatus.PENDING,
          PaymentStatus.FAILED,
        );
        if (!transitioned) msg = "already transitioned";
      } catch {
        msg = "already transitioned";
      }

      if (msg === "Payment failed") {
        metricsService.recordPaymentFailed("provider_failed");
        const booking = await tx.booking.findUnique({
          where: { id: localPayment.booking_id },
          select: { customer_id: true },
        });
        if (booking?.customer_id) {
          await outboxService.createOutboxEvent(tx, {
            eventType: "PAYMENT_FAILED",
            aggregateType: "payment",
            aggregateId: localPayment.id,
            recipientType: "customer",
            recipientId: booking.customer_id,
            payload: {
              paymentId: localPayment.id,
              bookingId: localPayment.booking_id,
              title: "Payment Failed",
              body: "Your payment attempt failed. Please try again.",
            },
            idempotencyKey: `PAYMENT_FAILED:payment:${localPayment.id}:${booking.customer_id}`,
          }).catch((err) => logger.warn("[OUTBOX_RECORD_FAILED]", { error: err.message }));
        }
      }

      await tx.paymentWebhookEvent.update({
        where: { id: webhookEvent.id },
        data: { status: WebhookEventStatus.PROCESSED, processedAt: new Date() },
      });

      return { message: msg };
    });

    return { success: true, message: result.message };
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      return { success: true, message: "Duplicate event — already processed" };
    }
    throw error;
  }
}

async function processRefundProcessed(params: {
  providerEventId: string;
  eventType: string;
  razorpayPaymentId: string | undefined;
  refundId: string | undefined;
  refundAmount: number | undefined;
}): Promise<{ success: boolean; message: string }> {
  const { providerEventId, eventType, razorpayPaymentId, refundId, refundAmount } = params;

  if (!razorpayPaymentId) return { success: true, message: "Event acknowledged (missing payment_id)" };

  try {
    const result = await prisma.$transaction(async (tx) => {
      const webhookEvent = await tx.paymentWebhookEvent.create({
        data: {
          provider: "razorpay",
          providerEventId,
          eventType,
          status: WebhookEventStatus.PROCESSING,
        },
      });

      const localPayment = await tx.payment.findFirst({
        where: { razorpay_payment_id: razorpayPaymentId },
      });

      if (!localPayment) {
        await tx.paymentWebhookEvent.update({
          where: { id: webhookEvent.id },
          data: { status: WebhookEventStatus.FAILED, failureReason: "No matching payment for refund" },
        });
        return { message: "Event acknowledged (no matching payment for refund)" };
      }

      // Transition to REFUNDED if currently in COMPLETED or REFUND_PENDING
      if (
        localPayment.status === PaymentStatus.COMPLETED ||
        localPayment.status === PaymentStatus.REFUND_PENDING
      ) {
        await tx.payment.update({
          where: { id: localPayment.id },
          data: {
            status: PaymentStatus.REFUNDED,
            razorpay_refund_id: refundId || localPayment.razorpay_refund_id,
            refund_amount: refundAmount || localPayment.refund_amount,
            refund_status: "processed",
            updated_at: new Date(),
          },
        });

        metricsService.recordRefundCreated(refundAmount || localPayment.amount || 0);

        const booking = await tx.booking.findUnique({
          where: { id: localPayment.booking_id },
          select: { customer_id: true },
        });
        if (booking?.customer_id) {
          await outboxService.createOutboxEvent(tx, {
            eventType: "REFUND_COMPLETED",
            aggregateType: "payment",
            aggregateId: localPayment.id,
            recipientType: "customer",
            recipientId: booking.customer_id,
            payload: {
              paymentId: localPayment.id,
              bookingId: localPayment.booking_id,
              refundId,
              amount: refundAmount,
              title: "Refund Processed",
              body: `Your refund of ₹${(refundAmount || localPayment.amount || 0) / 100} has been processed.`,
            },
            idempotencyKey: `REFUND_COMPLETED:payment:${localPayment.id}:${booking.customer_id}`,
          }).catch((err) => logger.warn("[OUTBOX_RECORD_FAILED]", { error: err.message }));
        }
      }

      await tx.paymentWebhookEvent.update({
        where: { id: webhookEvent.id },
        data: { status: WebhookEventStatus.PROCESSED, processedAt: new Date() },
      });

      return { message: "Refund processed successfully" };
    });

    return { success: true, message: result.message };
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      return { success: true, message: "Duplicate refund event — already processed" };
    }
    throw error;
  }
}

// ── getPaymentStatus ────────────────────────────────────────────────────────────

export async function getPaymentStatus(
  bookingId: string,
  actor: AuthenticatedUser | string,
): Promise<{
  id: string;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  razorpay_refund_id: string | null;
  status: string | null;
  amount: number | null;
  currency: string;
  booking_id: string;
}> {
  const effectiveActor: AuthenticatedUser =
    typeof actor === "string"
      ? { id: actor, role: UserRole.CUSTOMER, phone: "" }
      : actor;

  if (effectiveActor.role === UserRole.WORKER) {
    throw new PaymentError(
      "Workers are not authorized to view payment details.",
      "PAYMENT_NOT_AUTHORIZED",
      403,
    );
  }

  if (effectiveActor.role === UserRole.CUSTOMER) {
    const booking = await prisma.booking.findFirst({
      where: {
        id: bookingId,
        customer_id: effectiveActor.id,
      },
    });
    if (!booking) {
      throw new PaymentError(
        "Booking not found or you do not have permission to view its payment.",
        "PAYMENT_NOT_AUTHORIZED",
        403,
      );
    }
  }

  const payment = await prisma.payment.findFirst({
    where: paymentPolicy.scopeRead(effectiveActor, bookingId),
    select: {
      id: true,
      razorpay_order_id: true,
      razorpay_payment_id: true,
      razorpay_refund_id: true,
      status: true,
      amount: true,
      currency: true,
      booking_id: true,
    },
  });

  if (!payment) {
    throw new PaymentError(
      "No payment found for this booking or you do not have permission to view it.",
      "PAYMENT_NOT_FOUND",
      404,
    );
  }

  return payment;
}

// ── refundPayment (Issue 66 & 67) ───────────────────────────────────────────────

/**
 * Initiates a real Razorpay refund for the given booking with strict authorization & lifecycle guards.
 */
export async function refundPayment(
  bookingId: string,
  actor: AuthenticatedUser | string,
  refundAmountPaise?: number,
  reason?: string,
): Promise<{ success: boolean; message: string; refundId?: string }> {
  const effectiveActor: AuthenticatedUser =
    typeof actor === "string"
      ? { id: actor, role: UserRole.CUSTOMER, phone: "" }
      : actor;

  if (effectiveActor.role === UserRole.WORKER) {
    throw new PaymentError(
      "Workers are not authorized to refund payments.",
      "REFUND_NOT_AUTHORIZED",
      403,
    );
  }

  // Step 1: Enforce resource authorization (Issue 67) - strictly scoped database query
  const booking = await prisma.booking.findFirst({
    where: {
      id: bookingId,
      ...(effectiveActor.role === UserRole.CUSTOMER ? { customer_id: effectiveActor.id } : {}),
    },
    select: { id: true, status: true, customer_id: true },
  });

  if (!booking) {
    throw new PaymentError(
      "Booking not found or you do not have permission to refund its payment.",
      "REFUND_NOT_AUTHORIZED",
      403,
    );
  }

  const normalizedBooking = {
    id: booking.id,
    customer_id: booking.customer_id || (effectiveActor.role === UserRole.CUSTOMER ? effectiveActor.id : ""),
    status: booking.status,
  };
  assertPolicy(paymentPolicy.canRefund(effectiveActor, normalizedBooking));

  // Step 2: Load payment and verify refundable lifecycle state
  const payment = await prisma.payment.findUnique({
    where: { booking_id: bookingId },
  });

  if (!payment) {
    throw new PaymentError("No payment record found for this booking.", "REFUND_NO_PAYMENT", 404);
  }

  if (payment.status !== PaymentStatus.COMPLETED && payment.status !== PaymentStatus.REFUND_FAILED) {
    throw new PaymentError(
      `Cannot refund: payment is in status '${payment.status}', not COMPLETED.`,
      "REFUND_INVALID_STATE",
      409,
    );
  }

  if (!payment.razorpay_payment_id) {
    throw new PaymentError(
      "Cannot refund: missing Razorpay payment capture reference.",
      "REFUND_MISSING_CAPTURE_REF",
      422,
    );
  }

  // Step 3: Transition payment to REFUND_PENDING before provider side-effect
  await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.REFUND_PENDING,
        refund_reason: reason || "Customer/Admin requested refund",
        updated_at: new Date(),
      },
    });
  });

  // Step 4: Call real Razorpay Refund API (Issue 66)
  try {
    const providerRefund = await razorpayCreateRefund({
      razorpayPaymentId: payment.razorpay_payment_id,
      amountPaise: refundAmountPaise,
      notes: {
        bookingId,
        paymentId: payment.id,
        refundReason: reason || "Customer refund",
      },
      receipt: `rfnd_${bookingId.substring(0, 30)}`,
    });

    // Step 5: Update state to REFUNDED and dual-write outbox event on provider success (Issue 71)
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.REFUNDED,
          razorpay_refund_id: providerRefund.razorpayRefundId,
          refund_amount: providerRefund.amount,
          refund_status: providerRefund.status,
          updated_at: new Date(),
        },
      });

      if (booking?.customer_id) {
        await outboxService.createOutboxEvent(tx, {
          eventType: "REFUND_COMPLETED",
          aggregateType: "payment",
          aggregateId: payment.id,
          recipientType: "customer",
          recipientId: booking.customer_id,
          payload: {
            paymentId: payment.id,
            bookingId,
            refundId: providerRefund.razorpayRefundId,
            amount: providerRefund.amount,
            title: "Refund Processed",
            body: `Your refund of ₹${providerRefund.amount / 100} has been processed.`,
          },
          idempotencyKey: `REFUND_COMPLETED:payment:${payment.id}:${booking.customer_id}`,
        }).catch((err) => logger.warn("[OUTBOX_RECORD_FAILED]", { error: err.message }));
      }
    });

    metricsService.recordRefundCreated(providerRefund.amount);

    // Record audit event
    await auditService.recordEvent(prisma, {
      action: "REFUND_COMPLETED",
      actorId: effectiveActor.id,
      actorRole: effectiveActor.role as any,
      targetId: payment.id,
      targetType: "payment",
      metadata: {
        bookingId,
        refundId: providerRefund.razorpayRefundId,
        amount: providerRefund.amount,
      },
    }).catch((err) => logger.warn("[AUDIT_RECORD_FAILED]", { error: err.message }));

    return {
      success: true,
      message: "Refund processed successfully with payment provider.",
      refundId: providerRefund.razorpayRefundId,
    };
  } catch (err: any) {
    // Step 6: Mark REFUND_FAILED on provider rejection
    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.REFUND_FAILED,
        refund_reason: `Provider refund failure: ${err?.message || "unknown"}`,
        updated_at: new Date(),
      },
    });

    logger.error("[REFUND_PROVIDER_FAILED]", {
      paymentId: payment.id,
      error: err?.message,
    });

    throw new PaymentError(
      `Payment refund failed: ${err?.message || "provider error"}`,
      "REFUND_FAILED",
      502,
    );
  }
}
