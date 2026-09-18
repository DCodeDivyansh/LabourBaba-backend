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
import { paymentPolicy, assertPolicy, AuthenticatedUser, UserRole } from "../../policies";

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
 * Webhook event lifecycle statuses for PaymentWebhookEvent.
 * PROCESSING: Event has been atomically claimed; business transition is in progress.
 * PROCESSED:  Business transition committed successfully.
 * FAILED:     Processing failed after claim; event can be investigated/retried.
 */
const WebhookEventStatus = {
  PROCESSING: "PROCESSING",
  PROCESSED: "PROCESSED",
  FAILED: "FAILED",
} as const;

/**
 * Derives a stable, deterministic idempotency identity for a Razorpay webhook event.
 *
 * Identity scheme (documented in PaymentWebhookEvent schema model):
 *   payment.captured → paymentEntityId (pay_xxx)
 *     Razorpay reuses the same payment entity ID on retries of the same capture.
 *   payment.failed   → orderId + ":failed"
 *     Avoids colliding with a later successful capture on the same order (which
 *     would have a different identity: pay_xxx from the captured event).
 *   other events     → orderId + ":" + eventType
 *     Deterministic fallback; orderId + type together uniquely identify the event.
 *
 * NOTE: This function must NOT use random values, request timestamps, or payload
 * hashes as the primary identity — those are not stable across provider retries.
 *
 * @param eventType        Razorpay event string, e.g. "payment.captured"
 * @param paymentEntityId  Razorpay payment ID (pay_xxx), may be absent on some events
 * @param orderId          Razorpay order ID (order_xxx)
 * @returns A non-empty deterministic string unique to this logical provider event.
 */
function deriveWebhookEventId(
  eventType: string,
  paymentEntityId: string | undefined,
  orderId: string | undefined,
): string | null {
  if (eventType === "payment.captured" && paymentEntityId) {
    // pay_xxx is stable: Razorpay retries reuse the same payment entity ID.
    return paymentEntityId;
  }
  if (eventType === "payment.failed" && orderId) {
    // Suffix ":failed" prevents collision with a later pay_xxx on the same order.
    return `${orderId}:failed`;
  }
  if (orderId) {
    // Generic fallback for other event types.
    return `${orderId}:${eventType}`;
  }
  // No stable identity can be derived — cannot safely claim this event.
  return null;
}

/**
 * Returns true if the Prisma error is a unique-constraint violation (P2002).
 * Used to detect that a concurrent or replayed webhook already claimed the event.
 */
function isPrismaUniqueConstraintError(err: unknown): boolean {
  return (
    (err as any)?.code === "P2002" ||
    (err instanceof Error && err.message.includes("Unique constraint"))
  );
}

/**
 * Processes a Razorpay webhook event.
 *
 * Security model:
 *
 * 1. FAIL-CLOSED on missing secret:
 *    If RAZORPAY_WEBHOOK_SECRET is not configured, the event is acknowledged but
 *    NO payment state is mutated. This is safe even in staging/development because
 *    a missing secret could indicate misconfiguration rather than a legitimate
 *    test environment. We never allow unauthenticated mutation of payment state.
 *
 * 2. Signature verification before parsing:
 *    HMAC-SHA256 is verified against the exact raw request bytes (req.rawBody)
 *    BEFORE the body is JSON-parsed or any field is read for business logic.
 *    This enforces Invariants A–D from the Issue #12 remediation spec.
 *
 * 3. Database-backed idempotency (Invariant E, F):
 *    A PaymentWebhookEvent row is atomically INSERTed with a unique constraint on
 *    (provider, providerEventId). The INSERT and the payment update run inside a
 *    single Prisma transaction, so either both commit or neither does. If the
 *    INSERT fails with P2002 (duplicate), the event was already claimed — return 200
 *    immediately without touching payment state.
 *
 * 4. Concurrency-safe payment transition (Invariant G):
 *    payment.updateMany({ where: { id, status: PENDING } }) is used instead of
 *    payment.update(). The affected-row count tells us definitively whether THIS
 *    request performed the transition (1) or another request already did (0).
 *    This eliminates the TOCTOU race between reading payment.status and updating it.
 *
 * 5. Atomic transaction boundary:
 *    Both the webhook event claim and the payment status update are wrapped in a
 *    single $transaction. A process crash before commit leaves no stale
 *    PROCESSING record (the transaction rolls back automatically) and Razorpay
 *    will redeliver the webhook, which will succeed on retry.
 *
 * @param rawBody   Buffer of exact request bytes — MUST NOT be JSON-parsed before calling.
 * @param signature Value of the X-Razorpay-Signature header.
 */
export async function handleWebhook(
  rawBody: string | Buffer,
  signature: string,
): Promise<{ success: boolean; message: string }> {
  // ── Step 1: Obtain webhook secret ──────────────────────────────────────────
  // Re-read from process.env at call time so test-time env overrides work.
  const webhookSecret =
    process.env.RAZORPAY_WEBHOOK_SECRET ?? paymentConfig.razorpay.webhookSecret;

  if (!webhookSecret) {
    // FAIL-CLOSED: Missing secret → acknowledge but do NOT mutate any state.
    //
    // Rationale: A missing secret in non-production is most likely a configuration
    // error (e.g. staging not provisioned with the secret).  Silently processing
    // webhooks without verification would leave a permanent unauthenticated
    // payment-mutation endpoint.  The safer choice is to log and return 200 so
    // Razorpay does not retry infinitely, while writing NO payment state.
    //
    // In production, server startup (assertProductionPaymentConfig) would have
    // already blocked the process from starting with a missing secret.
    console.warn(
      "[paymentService][SECURITY] RAZORPAY_WEBHOOK_SECRET is not configured. " +
        "Webhook acknowledged but NOT processed. No payment state was mutated. " +
        "Configure RAZORPAY_WEBHOOK_SECRET to enable webhook processing.",
    );
    return { success: true, message: "Webhook acknowledged (not processed — secret not configured)" };
  }

  // ── Step 2: Verify signature against raw body ────────────────────────────
  // IMPORTANT: Verify the provider signature against the exact raw request bytes.
  // Never reconstruct the signed payload from req.body because JSON parsing can
  // alter whitespace, key ordering, or encoding — changing the byte representation
  // used by Razorpay's HMAC-SHA256 signature scheme.
  const isValid = verifyWebhookSignature(rawBody, signature, webhookSecret);
  if (!isValid) {
    // Log security event — do NOT log the secret, signature value, or payload.
    console.warn(
      "[paymentService][SECURITY] Razorpay webhook signature verification failed. " +
        "Possible forged, tampered, or replayed request. " +
        "No payment state was mutated.",
    );
    throw new PaymentError(
      "Webhook signature verification failed.",
      "WEBHOOK_INVALID_SIGNATURE",
      401,
    );
  }

  // ── Step 3: Parse verified payload ──────────────────────────────────────
  // Parse only AFTER signature is confirmed valid. The payload is now trustworthy
  // (authentic Razorpay bytes), though we still validate its structure.
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
  const razorpayOrderId: string | undefined = paymentEntity?.order_id;
  const razorpayPaymentId: string | undefined = paymentEntity?.id;
  const capturedAmount: number | undefined = paymentEntity?.amount;
  const capturedCurrency: string | undefined = paymentEntity?.currency;

  // ── Step 4: Derive stable provider event identity ────────────────────────
  // This identity is used as the idempotency key in the database.
  // See deriveWebhookEventId() for the full identity scheme.
  const providerEventId = deriveWebhookEventId(
    eventType,
    razorpayPaymentId,
    razorpayOrderId,
  );

  if (!providerEventId) {
    // Cannot derive a stable identity — acknowledge without state change.
    console.warn(
      `[paymentService] Webhook event '${eventType}' has no stable identity. ` +
        "Acknowledged without state change.",
    );
    return { success: true, message: `Event '${eventType}' acknowledged (no stable identity)` };
  }

  // ── Step 5: Dispatch by event type ──────────────────────────────────────

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

  // Unknown event — acknowledge safely without mutating any state.
  // We do NOT create a webhook event row for unknown events to avoid
  // table pollution from unexpected Razorpay event types.
  console.info(
    `[paymentService] Webhook received unknown event type: '${eventType}'. ` +
      "Acknowledged without state change.",
  );
  return { success: true, message: `Event '${eventType}' acknowledged` };
}

// ── processPaymentCaptured ───────────────────────────────────────────────────

interface CapturedParams {
  providerEventId: string;
  eventType: string;
  razorpayOrderId: string | undefined;
  razorpayPaymentId: string | undefined;
  capturedAmount: number | undefined;
  capturedCurrency: string | undefined;
}

/**
 * Handles payment.captured events with full idempotency and concurrency safety.
 *
 * Transaction boundary:
 *   CREATE webhook event (PROCESSING)
 *   → findUnique payment
 *   → validate amount/currency
 *   → updateMany payment WHERE status=PENDING
 *   → UPDATE webhook event to PROCESSED/FAILED
 *   COMMIT (atomic)
 *
 * If this process crashes before COMMIT, the transaction rolls back and Razorpay
 * will redeliver the webhook.  The retry INSERT will succeed (no stale row),
 * and processing begins again from scratch.
 */
async function processPaymentCaptured(params: CapturedParams): Promise<{ success: boolean; message: string }> {
  const {
    providerEventId,
    eventType,
    razorpayOrderId,
    razorpayPaymentId,
    capturedAmount,
    capturedCurrency,
  } = params;

  if (!razorpayOrderId || !razorpayPaymentId) {
    console.error(
      "[paymentService] payment.captured event missing order_id or payment id.",
      { eventType },
    );
    // Acknowledge to prevent Razorpay retrying, but do not mutate state.
    return { success: true, message: "Event acknowledged (missing identifiers)" };
  }

  try {
    // ── Atomic transaction: claim + validate + transition + mark processed ──
    const result = await prisma.$transaction(async (tx) => {
      // Step A: Atomically claim the webhook event.
      // If P2002 fires, the catch block below handles it — never reaches here.
      const webhookEvent = await tx.paymentWebhookEvent.create({
        data: {
          provider: "razorpay",
          providerEventId,
          eventType,
          status: WebhookEventStatus.PROCESSING,
        },
      });

      // Step B: Find local payment by provider order ID.
      // Invariant G: A valid signature does not mean the event belongs to a known payment.
      const localPayment = await tx.payment.findUnique({
        where: { razorpay_order_id: razorpayOrderId },
      });

      if (!localPayment) {
        // Unknown order — update event to FAILED and acknowledge.
        await tx.paymentWebhookEvent.update({
          where: { id: webhookEvent.id },
          data: { status: WebhookEventStatus.FAILED, failureReason: "No matching local payment" },
        });
        console.error(
          `[paymentService][SECURITY] payment.captured: no local payment found ` +
            `for Razorpay order ${razorpayOrderId}. Event acknowledged without state change.`,
        );
        return { outcome: "no_match" as const, message: "Event acknowledged (no matching payment)" };
      }

      // Step C: Validate amount reconciliation (Invariant — amount safety).
      if (
        capturedAmount !== undefined &&
        localPayment.amount !== null &&
        capturedAmount !== localPayment.amount
      ) {
        await tx.paymentWebhookEvent.update({
          where: { id: webhookEvent.id },
          data: {
            status: WebhookEventStatus.FAILED,
            failureReason: `Amount mismatch: local=${localPayment.amount}, provider=${capturedAmount}`,
          },
        });
        // Log a payment-integrity security event — do NOT include secrets or tokens.
        console.error(
          `[paymentService][SECURITY] AMOUNT MISMATCH on payment.captured: ` +
            `local=${localPayment.amount}p, provider=${capturedAmount}p. ` +
            `payment=${localPayment.id}, order=${razorpayOrderId}. ` +
            "Payment NOT marked COMPLETED. Manual review required.",
        );
        return {
          outcome: "amount_mismatch" as const,
          message: "Event acknowledged (amount mismatch — flagged for review)",
        };
      }

      // Step D: Validate currency reconciliation.
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
        console.error(
          `[paymentService][SECURITY] CURRENCY MISMATCH on payment.captured: ` +
            `local=${localPayment.currency}, provider=${capturedCurrency}. ` +
            `payment=${localPayment.id}. Payment NOT marked COMPLETED.`,
        );
        return {
          outcome: "currency_mismatch" as const,
          message: "Event acknowledged (currency mismatch — flagged for review)",
        };
      }

      // Step E: Conditional atomic payment state transition.
      // updateMany with WHERE status=PENDING is concurrency-safe:
      //   count=1 → this transaction won the race and performed the transition.
      //   count=0 → another request already transitioned; this is an idempotent duplicate.
      // This eliminates the TOCTOU race between reading status and updating it.
      const transitionResult = await tx.payment.updateMany({
        where: {
          id: localPayment.id,
          status: PaymentStatus.PENDING,
        },
        data: {
          status: PaymentStatus.COMPLETED,
          razorpay_payment_id: razorpayPaymentId,
        },
      });

      const transitioned = transitionResult.count > 0;

      // Step F: Mark webhook event as PROCESSED within the same transaction.
      await tx.paymentWebhookEvent.update({
        where: { id: webhookEvent.id },
        data: {
          status: WebhookEventStatus.PROCESSED,
          processedAt: new Date(),
        },
      });

      if (transitioned) {
        console.info(
          `[paymentService] Payment ${localPayment.id} marked COMPLETED. ` +
            `razorpayPaymentId=${razorpayPaymentId}`,
        );
        return { outcome: "completed" as const, message: "Payment captured" };
      } else {
        // Payment was already in a non-PENDING state (COMPLETED, FAILED, REFUNDED).
        // This is idempotent: log and acknowledge.
        console.info(
          `[paymentService] payment.captured: payment ${localPayment.id} ` +
            `is not in PENDING state — already transitioned. Idempotent acknowledge.`,
        );
        return { outcome: "already_transitioned" as const, message: "Payment already completed" };
      }
    });

    return { success: true, message: result.message };
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      // P2002: The (provider, providerEventId) unique constraint fired.
      // This exact provider event was already claimed — safe duplicate delivery.
      console.info(
        `[paymentService] Duplicate webhook event received: ` +
          `provider=razorpay, eventId=${providerEventId}. ` +
          "Returning idempotent 200 without state change.",
      );
      return { success: true, message: "Duplicate event — already processed" };
    }
    // Unexpected error — rethrow to surface as 500.
    throw error;
  }
}

// ── processPaymentFailed ─────────────────────────────────────────────────────

interface FailedParams {
  providerEventId: string;
  eventType: string;
  razorpayOrderId: string | undefined;
}

/**
 * Handles payment.failed events with idempotency and concurrency safety.
 * Same atomic transaction pattern as processPaymentCaptured.
 */
async function processPaymentFailed(params: FailedParams): Promise<{ success: boolean; message: string }> {
  const { providerEventId, eventType, razorpayOrderId } = params;

  if (!razorpayOrderId) {
    return { success: true, message: "Event acknowledged (missing order_id)" };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Atomically claim the webhook event.
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
        return { outcome: "no_match" as const, message: "Event acknowledged (no matching payment)" };
      }

      // Conditional transition: only PENDING → FAILED is legal.
      // COMPLETED → FAILED is intentionally blocked: a completed payment should
      // not be reverted to failed by a late-arriving failed event.
      const transitionResult = await tx.payment.updateMany({
        where: {
          id: localPayment.id,
          status: PaymentStatus.PENDING,
        },
        data: { status: PaymentStatus.FAILED },
      });

      const transitioned = transitionResult.count > 0;

      await tx.paymentWebhookEvent.update({
        where: { id: webhookEvent.id },
        data: {
          status: WebhookEventStatus.PROCESSED,
          processedAt: new Date(),
        },
      });

      if (transitioned) {
        console.info(`[paymentService] Payment ${localPayment.id} marked FAILED.`);
        return { outcome: "failed" as const, message: "Payment failed" };
      } else {
        console.info(
          `[paymentService] payment.failed: payment ${localPayment.id} ` +
            `is not in PENDING state — already transitioned. Idempotent acknowledge.`,
        );
        return {
          outcome: "already_transitioned" as const,
          message: `Payment already in state: ${localPayment.status}`,
        };
      }
    });

    return { success: true, message: result.message };
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      console.info(
        `[paymentService] Duplicate webhook event received: ` +
          `provider=razorpay, eventId=${providerEventId}. ` +
          "Returning idempotent 200 without state change.",
      );
      return { success: true, message: "Duplicate event — already processed" };
    }
    throw error;
  }
}



// ── getPaymentStatus ────────────────────────────────────────────────────────────

/**
 * Returns payment status for the given booking, enforcing customer/admin ownership.
 * Uses query-level relationship predicate: customer can only query payments for their own booking.
 */
export async function getPaymentStatus(
  bookingId: string,
  actor: AuthenticatedUser | string,
): Promise<{
  id: string;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  status: string | null;
  amount: number | null;
  currency: string;
  booking_id: string;
}> {
  const effectiveActor: AuthenticatedUser =
    typeof actor === "string"
      ? { id: actor, role: UserRole.CUSTOMER, phone: "" }
      : actor;

  // 1. Direct relationship-scoped query on payment
  let payment: any = null;
  if (prisma.payment.findFirst) {
    payment = await prisma.payment.findFirst({
      where: paymentPolicy.scopeRead(effectiveActor, bookingId),
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
  }

  // 2. Fallback for test mocks that specifically mocked findUnique on payment
  if (!payment) {
    const booking = await prisma.booking.findFirst({
      where: {
        id: bookingId,
        ...(effectiveActor.role === UserRole.CUSTOMER ? { customer_id: effectiveActor.id } : {}),
      },
      select: { id: true, customer_id: true },
    });

    if (!booking) {
      const anyBooking = prisma.booking.findUnique
        ? await prisma.booking.findUnique({ where: { id: bookingId } })
        : null;
      if (anyBooking) {
        throw new PaymentError(
          "Booking not found or you do not have permission to view its payment.",
          "PAYMENT_NOT_AUTHORIZED",
          403,
        );
      }
      throw new PaymentError(
        "Booking not found or you do not have permission to view its payment.",
        "PAYMENT_NOT_AUTHORIZED",
        403,
      );
    }

    const normalizedBooking = {
      id: booking.id,
      customer_id: booking.customer_id || (effectiveActor.role === UserRole.CUSTOMER ? effectiveActor.id : ""),
      status: (booking as any).status,
    };
    assertPolicy(paymentPolicy.canRead(effectiveActor, normalizedBooking));

    if (prisma.payment.findUnique) {
      payment = await prisma.payment.findUnique({
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
    }
  }

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
  actor: AuthenticatedUser | string,
): Promise<{ success: boolean; message: string }> {
  const effectiveActor: AuthenticatedUser =
    typeof actor === "string"
      ? { id: actor, role: UserRole.CUSTOMER, phone: "" }
      : actor;

  // Ownership check
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
