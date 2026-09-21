/**
 * Razorpay Provider Adapter
 *
 * This module is the sole integration point with the Razorpay SDK.
 * All interactions with the Razorpay API go through this module.
 *
 * Design:
 * - Thin wrapper — no business logic, only provider interaction.
 * - Validates provider responses before returning them.
 * - Exposes a stable interface that paymentServices.ts depends on.
 * - The Razorpay instance is initialised lazily to allow the rest of
 *   the application to start without crashing in test environments where
 *   Razorpay credentials are intentionally absent.
 *
 * Monetary units:
 * - All amounts are in PAISE (smallest INR unit). 1 rupee = 100 paise.
 * - rate_per_day is stored in the database as whole rupees (Int).
 * - Callers are responsible for the rupees → paise conversion before
 *   calling createOrder().
 */

import Razorpay from "razorpay";
import crypto from "crypto";
import { paymentConfig } from "../../config/paymentConfig";

// ── Error types ────────────────────────────────────────────────────────────────

export class RazorpayProviderError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode = 502) {
    super(message);
    this.name = "RazorpayProviderError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ── Razorpay instance (lazy) ───────────────────────────────────────────────────

let _razorpayInstance: Razorpay | null = null;

/**
 * Returns the Razorpay SDK instance.
 * Throws a clear configuration error if credentials are not set.
 * In test environments the instance may be replaced with a mock.
 */
export function getRazorpayInstance(): Razorpay {
  if (_razorpayInstance) return _razorpayInstance;

  const { keyId, keySecret } = paymentConfig.razorpay;

  if (!keyId || !keySecret) {
    throw new RazorpayProviderError(
      "Razorpay credentials are not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.",
      "PAYMENT_NOT_CONFIGURED",
      503,
    );
  }

  _razorpayInstance = new Razorpay({ key_id: keyId, key_secret: keySecret });
  return _razorpayInstance;
}

/**
 * Allows test suites to inject a mock Razorpay instance.
 * Do NOT call this from production code.
 */
export function _setRazorpayInstanceForTesting(instance: Razorpay | null): void {
  _razorpayInstance = instance;
}

// ── createOrder ────────────────────────────────────────────────────────────────

export interface CreateOrderParams {
  /** Amount in paise. Must be a positive integer. */
  amountPaise: number;
  /** ISO 4217 currency code, must be "INR" for LabourBaba. */
  currency: string;
  /**
   * Unique receipt reference. Maximum 40 chars per Razorpay.
   * We use the first 40 chars of the bookingId.
   */
  receipt: string;
  /** Internal payment record ID for notes (not used as provider order ID). */
  paymentId: string;
  /** Booking ID stored in Razorpay notes for reconciliation. */
  bookingId: string;
}

export interface RazorpayOrderResult {
  /** Real Razorpay provider order ID (e.g. "order_abc123"). */
  razorpayOrderId: string;
  /** Amount confirmed by Razorpay in paise. */
  amount: number;
  /** Currency confirmed by Razorpay. */
  currency: string;
}

/**
 * Creates a real Razorpay order via the Razorpay API.
 *
 * Validates that the provider returned:
 *  - a non-empty order ID
 *  - the exact amount we requested
 *  - the exact currency we requested
 *
 * Throws RazorpayProviderError on:
 *  - network/SDK failure
 *  - missing/malformed order ID in response
 *  - amount mismatch
 *  - currency mismatch
 *
 * NEVER fabricates an order ID locally.
 */
export async function createOrder(
  params: CreateOrderParams,
): Promise<RazorpayOrderResult> {
  const { amountPaise, currency, receipt, paymentId, bookingId } = params;

  // Basic pre-flight sanity guards (callers should validate too, but belt-and-suspenders)
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new RazorpayProviderError(
      "Invalid payment amount: must be a positive integer in paise.",
      "PAYMENT_AMOUNT_INVALID",
      422,
    );
  }
  if (currency !== "INR") {
    throw new RazorpayProviderError(
      `Unsupported currency '${currency}'. Only INR is supported.`,
      "PAYMENT_CURRENCY_UNSUPPORTED",
      422,
    );
  }

  const razorpay = getRazorpayInstance();

  let order: any;
  try {
    order = await razorpay.orders.create({
      amount: amountPaise,
      currency,
      // Razorpay receipt must be ≤ 40 characters
      receipt: receipt.substring(0, 40),
      notes: {
        paymentId,
        bookingId,
      },
    });
  } catch (sdkErr: any) {
    // Log the error code/description but never the raw SDK error (may contain credentials)
    const safeCode = sdkErr?.error?.code ?? sdkErr?.statusCode ?? "UNKNOWN";
    const safeDesc = sdkErr?.error?.description ?? sdkErr?.message ?? "Unknown error";
    console.error(
      `[razorpayProvider] Razorpay order creation failed: code=${safeCode}, description=${safeDesc}`,
    );
    throw new RazorpayProviderError(
      "Payment provider failed to create order. Please try again.",
      "PAYMENT_ORDER_CREATION_FAILED",
      502,
    );
  }

  // Validate provider response ─────────────────────────────────────────────────

  if (!order || typeof order.id !== "string" || order.id.trim() === "") {
    console.error(
      "[razorpayProvider] Razorpay returned missing or invalid order ID.",
      { orderId: order?.id },
    );
    throw new RazorpayProviderError(
      "Payment provider returned an invalid order ID.",
      "PAYMENT_PROVIDER_RESPONSE_INVALID",
      502,
    );
  }

  const returnedAmount = Number(order.amount);
  if (returnedAmount !== amountPaise) {
    console.error(
      `[razorpayProvider] Amount mismatch: expected ${amountPaise} paise, provider returned ${returnedAmount} paise.`,
    );
    throw new RazorpayProviderError(
      "Payment provider returned an unexpected amount.",
      "PAYMENT_AMOUNT_MISMATCH",
      502,
    );
  }

  const returnedCurrency = (order.currency ?? "").toUpperCase();
  if (returnedCurrency !== currency.toUpperCase()) {
    console.error(
      `[razorpayProvider] Currency mismatch: expected ${currency}, provider returned ${returnedCurrency}.`,
    );
    throw new RazorpayProviderError(
      "Payment provider returned an unexpected currency.",
      "PAYMENT_CURRENCY_MISMATCH",
      502,
    );
  }

  return {
    razorpayOrderId: order.id,
    amount: returnedAmount,
    currency: returnedCurrency,
  };
}

// ── verifyWebhookSignature ─────────────────────────────────────────────────────

/**
 * Verifies a Razorpay webhook signature using HMAC-SHA256.
 *
 * @param rawBody   The raw request body as received — must NOT be JSON-parsed first.
 * @param signature The value of the X-Razorpay-Signature header.
 * @param secret    The RAZORPAY_WEBHOOK_SECRET.
 * @returns true if the signature is valid, false otherwise.
 *
 * Uses a timing-safe comparison to prevent timing attacks.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signature: string,
  secret: string,
): boolean {
  if (!secret || typeof secret !== "string" || secret.trim() === "") return false;
  if (!signature || typeof signature !== "string" || signature.trim() === "") return false;
  if (!rawBody || (typeof rawBody !== "string" && !Buffer.isBuffer(rawBody))) return false;

  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");

  try {
    const expectedSignature = crypto
      .createHmac("sha256", secret.trim())
      .update(body)
      .digest("hex");

    // Timing-safe comparison
    const expectedBuf = Buffer.from(expectedSignature, "hex");
    const receivedBuf = Buffer.from(signature.trim(), "hex");

    if (expectedBuf.length !== receivedBuf.length || expectedBuf.length === 0) return false;

    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  } catch {
    return false;
  }
}

// ── createRefund ───────────────────────────────────────────────────────────────

export interface CreateRefundParams {
  /** Real Razorpay payment ID (pay_xxx) to refund. */
  razorpayPaymentId: string;
  /** Optional refund amount in paise. If omitted, Razorpay executes a full refund. */
  amountPaise?: number;
  /** Notes metadata for reconciliation. */
  notes?: Record<string, string>;
  /** Optional receipt reference identifier. */
  receipt?: string;
}

export interface RazorpayRefundResult {
  /** Real Razorpay refund ID (e.g. "rfnd_abc123"). */
  razorpayRefundId: string;
  paymentId: string;
  amount: number;
  currency: string;
  status: string; // "processed" | "pending" | "failed"
}

/**
 * Executes a real provider refund via the Razorpay API.
 */
export async function createRefund(
  params: CreateRefundParams,
): Promise<RazorpayRefundResult> {
  const { razorpayPaymentId, amountPaise, notes, receipt } = params;

  if (!razorpayPaymentId || typeof razorpayPaymentId !== "string" || razorpayPaymentId.trim() === "") {
    throw new RazorpayProviderError(
      "Valid Razorpay payment ID is required for refund.",
      "REFUND_INVALID_PAYMENT_ID",
      422,
    );
  }

  if (amountPaise !== undefined && (!Number.isInteger(amountPaise) || amountPaise <= 0)) {
    throw new RazorpayProviderError(
      "Refund amount must be a positive integer in paise.",
      "REFUND_AMOUNT_INVALID",
      422,
    );
  }

  const razorpay = getRazorpayInstance();

  try {
    const refundPayload: any = {
      notes: notes ?? {},
    };
    if (amountPaise !== undefined) {
      refundPayload.amount = amountPaise;
    }
    if (receipt) {
      refundPayload.receipt = receipt.substring(0, 40);
    }

    const refund = await (razorpay.payments as any).refund(
      razorpayPaymentId,
      refundPayload,
    );

    if (!refund || typeof refund.id !== "string" || refund.id.trim() === "") {
      throw new RazorpayProviderError(
        "Payment provider returned an invalid refund ID.",
        "REFUND_PROVIDER_RESPONSE_INVALID",
        502,
      );
    }

    return {
      razorpayRefundId: refund.id,
      paymentId: refund.payment_id || razorpayPaymentId,
      amount: Number(refund.amount || amountPaise || 0),
      currency: (refund.currency || "INR").toUpperCase(),
      status: refund.status || "processed",
    };
  } catch (sdkErr: any) {
    if (sdkErr instanceof RazorpayProviderError) throw sdkErr;
    const safeCode = sdkErr?.error?.code ?? sdkErr?.statusCode ?? "UNKNOWN";
    const safeDesc = sdkErr?.error?.description ?? sdkErr?.message ?? "Refund provider failure";
    console.error(
      `[razorpayProvider] Razorpay refund failed: code=${safeCode}, description=${safeDesc}`,
    );
    throw new RazorpayProviderError(
      `Payment provider failed to process refund: ${safeDesc}`,
      "REFUND_PROVIDER_FAILED",
      502,
    );
  }
}

// ── fetchOrder & fetchPayment (Reconciliation) ────────────────────────────────

/**
 * Fetches order details directly from Razorpay for reconciliation.
 */
export async function fetchOrder(orderId: string): Promise<{
  id: string;
  amount: number;
  currency: string;
  status: string; // "created" | "attempted" | "paid"
  attempts: number;
}> {
  const razorpay = getRazorpayInstance();
  try {
    const order = await razorpay.orders.fetch(orderId);
    return {
      id: order.id,
      amount: Number(order.amount),
      currency: (order.currency || "INR").toUpperCase(),
      status: order.status,
      attempts: Number(order.attempts || 0),
    };
  } catch (err: any) {
    throw new RazorpayProviderError(
      `Failed to fetch provider order: ${err?.message || "unknown"}`,
      "FETCH_ORDER_FAILED",
      502,
    );
  }
}

/**
 * Fetches payment details directly from Razorpay for reconciliation.
 */
export async function fetchPayment(paymentId: string): Promise<{
  id: string;
  orderId: string;
  amount: number;
  currency: string;
  status: string; // "created" | "authorized" | "captured" | "refunded" | "failed"
}> {
  const razorpay = getRazorpayInstance();
  try {
    const payment = await razorpay.payments.fetch(paymentId);
    return {
      id: payment.id,
      orderId: (payment as any).order_id,
      amount: Number(payment.amount),
      currency: (payment.currency || "INR").toUpperCase(),
      status: payment.status,
    };
  } catch (err: any) {
    throw new RazorpayProviderError(
      `Failed to fetch provider payment: ${err?.message || "unknown"}`,
      "FETCH_PAYMENT_FAILED",
      502,
    );
  }
}

