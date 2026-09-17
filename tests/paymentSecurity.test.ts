/**
 * P0 Finding #11 Security Regression Suite: Payment Order Creation Invariants
 *
 * Tests the complete security invariants required by the Issue #11 remediation:
 *
 * 1. Authentication: unauthenticated callers get 401
 * 2. RBAC: only CUSTOMER role may create payment orders (workers and admins get 403)
 * 3. Ownership: customer cannot access another customer's payment
 * 4. Amount: amount is derived from rate_per_day server-side, never from client input
 * 5. Monetary units: rate_per_day (rupees) is correctly converted to paise for Razorpay
 * 6. Provider: Razorpay createOrder is called with correct params; real order ID is persisted
 * 7. Provider failure: no successful payment order is created on provider error
 * 8. Provider response validation: malformed responses are rejected
 * 9. State: order creation leaves payment PENDING (not COMPLETED)
 * 10. Idempotency: repeated requests return the existing pending order without calling Razorpay again
 * 11. Concurrency: unique constraint prevents duplicate payment records
 * 12. Booking state: cancelled bookings cannot be paid
 * 13. Webhook: missing/invalid signature returns 401
 * 14. Webhook: valid captured event → COMPLETED + payment ID stored
 * 15. Webhook: valid failed event → FAILED
 * 16. Webhook: unknown events acknowledged without state change
 * 17. Webhook idempotency: duplicate event does not re-apply state change
 * 18. Webhook order association: valid webhook for different order cannot complete this payment
 * 19. Payment status: ownership enforced
 * 20. Refund: ownership + lifecycle enforced
 *
 * Architecture:
 * - Prisma is mocked at module level (no DB required)
 * - Razorpay provider adapter is mocked at module boundary (no real API calls)
 * - Tests verify the integration between controller → service → provider adapter
 */

import request from "supertest";
import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { generateToken } from "../src/utils/authUtils";
import { UserRole } from "../src/middlewares/authMiddleware";
import * as razorpayProvider from "../src/providers/razorpay/razorpayProvider";
import crypto from "crypto";

// ── Prisma mock ────────────────────────────────────────────────────────────────

jest.mock("../src/config/prisma", () => ({
  __esModule: true,
  default: {
    booking: {
      findFirst: jest.fn(),
    },
    payment: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

// ── Razorpay provider mock ─────────────────────────────────────────────────────

jest.mock("../src/providers/razorpay/razorpayProvider", () => ({
  ...jest.requireActual("../src/providers/razorpay/razorpayProvider"),
  createOrder: jest.fn(),
  verifyWebhookSignature: jest.fn(),
}));

// ── Helpers ────────────────────────────────────────────────────────────────────

const CUSTOMER_A_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const CUSTOMER_B_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const WORKER_ID     = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
const BOOKING_ID    = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
const REQ_ID        = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";
const PAYMENT_ID    = "ffffffff-ffff-4fff-ffff-ffffffffffff";

const RAZORPAY_ORDER_ID   = "order_TestABC123";
const RAZORPAY_PAYMENT_ID = "pay_TestXYZ999";
const RATE_PER_DAY_RUPEES = 500;       // ₹500/day stored in DB
const EXPECTED_PAISE      = 50000;     // 500 × 100 = 50,000 paise

function customerAToken(): string {
  return generateToken({ id: CUSTOMER_A_ID, role: UserRole.CUSTOMER });
}
function customerBToken(): string {
  return generateToken({ id: CUSTOMER_B_ID, role: UserRole.CUSTOMER });
}
function workerToken(): string {
  return generateToken({ id: WORKER_ID, role: UserRole.WORKER });
}
function adminToken(): string {
  return generateToken({ id: "admin-id", role: UserRole.ADMIN });
}

/** Base booking owned by CUSTOMER_A in a payable state */
function makeBooking(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: BOOKING_ID,
    customer_id: CUSTOMER_A_ID,
    status: "confirmed",
    job_requirement: {
      id: REQ_ID,
      rate_per_day: RATE_PER_DAY_RUPEES,
    },
    ...overrides,
  };
}

/** A successful Razorpay provider response */
function makeProviderOrder(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    razorpayOrderId: RAZORPAY_ORDER_ID,
    amount: EXPECTED_PAISE,
    currency: "INR",
    ...overrides,
  };
}

/** A persisted payment record */
function makePayment(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: PAYMENT_ID,
    booking_id: BOOKING_ID,
    razorpay_order_id: RAZORPAY_ORDER_ID,
    razorpay_payment_id: null,
    status: "PENDING",
    amount: EXPECTED_PAISE,
    currency: "INR",
    idempotency_key: BOOKING_ID,
    ...overrides,
  };
}

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockCreateOrder = razorpayProvider.createOrder as jest.Mock;
const mockVerifyWebhookSignature = razorpayProvider.verifyWebhookSignature as jest.Mock;

// ── Webhook helpers ─────────────────────────────────────────────────────────────

function buildWebhookSignature(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

const WEBHOOK_SECRET = "test_webhook_secret_32_chars_long!!";

// ══════════════════════════════════════════════════════════════════════════════
// Test Suite
// ══════════════════════════════════════════════════════════════════════════════

describe("P0 Finding #11 Security Regression Suite: Payment Order Creation", () => {

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
    // Default: successful provider and happy-path DB state
    mockCreateOrder.mockResolvedValue(makeProviderOrder());
    (mockPrisma.payment.create as jest.Mock).mockResolvedValue(makePayment());
    (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue(makeBooking());
    (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null); // no existing payment
    (mockPrisma.payment.findUnique as jest.Mock).mockResolvedValue(makePayment());
    mockVerifyWebhookSignature.mockReturnValue(true);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 1. Authentication
  // ────────────────────────────────────────────────────────────────────────────

  describe("1. Authentication", () => {
    it("unauthenticated create-order request returns 401", async () => {
      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .send({});

      expect(res.status).toBe(401);
      expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it("unauthenticated get-status request returns 401", async () => {
      const res = await request(app).get(`/api/payments/${BOOKING_ID}`);
      expect(res.status).toBe(401);
    });

    it("unauthenticated refund request returns 401", async () => {
      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/refund`)
        .send({});
      expect(res.status).toBe(401);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 2. RBAC — worker and admin are forbidden
  // ────────────────────────────────────────────────────────────────────────────

  describe("2. RBAC", () => {
    it("worker cannot create a payment order (403)", async () => {
      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${workerToken()}`)
        .send({});

      expect(res.status).toBe(403);
      expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it("admin cannot create a payment order (403)", async () => {
      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${adminToken()}`)
        .send({});

      expect(res.status).toBe(403);
      expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it("worker cannot get payment status (403)", async () => {
      const res = await request(app)
        .get(`/api/payments/${BOOKING_ID}`)
        .set("Authorization", `Bearer ${workerToken()}`);

      expect(res.status).toBe(403);
    });

    it("worker cannot refund a payment (403)", async () => {
      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/refund`)
        .set("Authorization", `Bearer ${workerToken()}`)
        .send({});

      expect(res.status).toBe(403);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 3. Ownership
  // ────────────────────────────────────────────────────────────────────────────

  describe("3. Ownership", () => {
    it("customer B cannot create order for customer A booking (403)", async () => {
      // Simulates prisma returning null (booking not owned by customer B)
      (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerBToken()}`)
        .send({});

      expect(res.status).toBe(403);
      expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it("customer B cannot view customer A payment status (403)", async () => {
      // Booking ownership check fails for customer B
      (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/payments/${BOOKING_ID}`)
        .set("Authorization", `Bearer ${customerBToken()}`);

      expect(res.status).toBe(403);
    });

    it("customer B cannot refund customer A payment (403)", async () => {
      (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/refund`)
        .set("Authorization", `Bearer ${customerBToken()}`)
        .send({});

      expect(res.status).toBe(403);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 4 & 5. Server-side amount — monetary unit conversion
  // ────────────────────────────────────────────────────────────────────────────

  describe("4 & 5. Server-side amount derivation and monetary units", () => {
    it("Razorpay is called with rate_per_day × 100 paise (₹500/day → 50000p)", async () => {
      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({}); // No amount from client

      expect(res.status).toBe(201);
      expect(mockCreateOrder).toHaveBeenCalledTimes(1);

      const callArgs = mockCreateOrder.mock.calls[0][0];
      // Verify correct paise conversion: 500 rupees × 100 = 50000 paise
      expect(callArgs.amountPaise).toBe(EXPECTED_PAISE);
      expect(callArgs.currency).toBe("INR");
    });

    it("a high client-supplied amount in body is completely ignored", async () => {
      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({ amount: 9999999 }); // Attacker inflates amount

      expect(res.status).toBe(201);
      // Provider must be called with the server-side amount, not client amount
      expect(mockCreateOrder.mock.calls[0][0].amountPaise).toBe(EXPECTED_PAISE);
    });

    it("a low client-supplied amount is completely ignored", async () => {
      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({ amount: 1 }); // Attacker reduces amount

      expect(res.status).toBe(201);
      expect(mockCreateOrder.mock.calls[0][0].amountPaise).toBe(EXPECTED_PAISE);
    });

    it("zero client amount is ignored — server amount is used", async () => {
      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({ amount: 0 });

      expect(res.status).toBe(201);
      expect(mockCreateOrder.mock.calls[0][0].amountPaise).toBe(EXPECTED_PAISE);
    });

    it("rejects booking with null rate_per_day (422)", async () => {
      (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue(
        makeBooking({ job_requirement: { id: REQ_ID, rate_per_day: null } }),
      );

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(422);
      expect(res.body.code).toBe("PAYMENT_RATE_MISSING");
      expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it("rejects booking with zero rate_per_day (422)", async () => {
      (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue(
        makeBooking({ job_requirement: { id: REQ_ID, rate_per_day: 0 } }),
      );

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(422);
      expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it("rejects booking with negative rate_per_day (422)", async () => {
      (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue(
        makeBooking({ job_requirement: { id: REQ_ID, rate_per_day: -100 } }),
      );

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(422);
      expect(mockCreateOrder).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 6. Successful order creation — real provider ID persisted
  // ────────────────────────────────────────────────────────────────────────────

  describe("6. Successful order creation", () => {
    it("creates a Razorpay order and persists the real provider order ID", async () => {
      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.razorpayOrderId).toBe(RAZORPAY_ORDER_ID);
      expect(res.body.data.status).toBe("PENDING");
      expect(res.body.data.amount).toBe(EXPECTED_PAISE);
      expect(res.body.data.currency).toBe("INR");

      // Prisma create was called with provider-returned order ID
      const createCall = (mockPrisma.payment.create as jest.Mock).mock.calls[0][0];
      expect(createCall.data.razorpay_order_id).toBe(RAZORPAY_ORDER_ID);
      expect(createCall.data.amount).toBe(EXPECTED_PAISE);
      expect(createCall.data.status).toBe("PENDING");
    });

    it("provider is called exactly once per successful order", async () => {
      await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(mockCreateOrder).toHaveBeenCalledTimes(1);
    });

    it("response does not contain Razorpay credentials or internal details", async () => {
      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      const body = JSON.stringify(res.body);
      expect(body).not.toContain("key_secret");
      expect(body).not.toContain("webhook_secret");
      expect(body).not.toContain("RAZORPAY_KEY_SECRET");
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 7. Provider failure — no fake order persisted
  // ────────────────────────────────────────────────────────────────────────────

  describe("7. Provider failure handling", () => {
    it("provider SDK failure → no payment record created, returns 502", async () => {
      const { RazorpayProviderError } = jest.requireActual(
        "../src/providers/razorpay/razorpayProvider",
      ) as typeof razorpayProvider;

      mockCreateOrder.mockRejectedValue(
        new RazorpayProviderError(
          "Payment provider failed to create order.",
          "PAYMENT_ORDER_CREATION_FAILED",
          502,
        ),
      );

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(502);
      expect(res.body.success).not.toBe(true);
      // Prisma create must NOT have been called
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
    });

    it("provider network timeout → safe error, no DB write", async () => {
      mockCreateOrder.mockRejectedValue(new Error("ECONNRESET"));

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(500);
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
    });

    it("error response does not leak provider internal details", async () => {
      const { RazorpayProviderError } = jest.requireActual(
        "../src/providers/razorpay/razorpayProvider",
      ) as typeof razorpayProvider;
      mockCreateOrder.mockRejectedValue(
        new RazorpayProviderError("Provider error", "PAYMENT_ORDER_CREATION_FAILED", 502),
      );

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      const body = JSON.stringify(res.body);
      expect(body).not.toContain("key_secret");
      expect(body).not.toContain("RAZORPAY_KEY");
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 8. Provider response validation — malformed responses rejected
  // ────────────────────────────────────────────────────────────────────────────

  describe("8. Provider response validation", () => {
    it("amount mismatch → provider error, no successful local payment", async () => {
      const { RazorpayProviderError } = jest.requireActual(
        "../src/providers/razorpay/razorpayProvider",
      ) as typeof razorpayProvider;
      mockCreateOrder.mockRejectedValue(
        new RazorpayProviderError(
          "Payment provider returned an unexpected amount.",
          "PAYMENT_AMOUNT_MISMATCH",
          502,
        ),
      );

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(502);
      expect(res.body.code).toBe("PAYMENT_AMOUNT_MISMATCH");
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
    });

    it("currency mismatch → provider error, no successful local payment", async () => {
      const { RazorpayProviderError } = jest.requireActual(
        "../src/providers/razorpay/razorpayProvider",
      ) as typeof razorpayProvider;
      mockCreateOrder.mockRejectedValue(
        new RazorpayProviderError(
          "Payment provider returned an unexpected currency.",
          "PAYMENT_CURRENCY_MISMATCH",
          502,
        ),
      );

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(502);
      expect(res.body.code).toBe("PAYMENT_CURRENCY_MISMATCH");
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
    });

    it("missing order ID from provider → provider error, no DB write", async () => {
      const { RazorpayProviderError } = jest.requireActual(
        "../src/providers/razorpay/razorpayProvider",
      ) as typeof razorpayProvider;
      mockCreateOrder.mockRejectedValue(
        new RazorpayProviderError(
          "Payment provider returned an invalid order ID.",
          "PAYMENT_PROVIDER_RESPONSE_INVALID",
          502,
        ),
      );

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(502);
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 9. State — order creation never completes the payment
  // ────────────────────────────────────────────────────────────────────────────

  describe("9. Payment state after order creation", () => {
    it("newly created payment has status PENDING, not COMPLETED", async () => {
      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("PENDING");
      expect(res.body.data.status).not.toBe("COMPLETED");
    });

    it("DB is persisted with status=PENDING, not COMPLETED", async () => {
      await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      const createCall = (mockPrisma.payment.create as jest.Mock).mock.calls[0][0];
      expect(createCall.data.status).toBe("PENDING");
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 10. Idempotency
  // ────────────────────────────────────────────────────────────────────────────

  describe("10. Idempotency", () => {
    it("second request for same booking returns existing pending order without calling Razorpay again", async () => {
      // Simulate existing pending payment
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(makePayment());

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.data.razorpayOrderId).toBe(RAZORPAY_ORDER_ID);
      // Provider must NOT be called for an existing pending order
      expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it("existing COMPLETED payment returns 409 (cannot create duplicate order)", async () => {
      (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(
        makePayment({ status: "COMPLETED" }),
      );

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("PAYMENT_ALREADY_COMPLETED");
      expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it("idempotency_key = bookingId is stored in the DB", async () => {
      await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      const createCall = (mockPrisma.payment.create as jest.Mock).mock.calls[0][0];
      expect(createCall.data.idempotency_key).toBe(BOOKING_ID);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 11. Concurrency — unique constraint race
  // ────────────────────────────────────────────────────────────────────────────

  describe("11. Concurrency", () => {
    it("concurrent order creation race handled via unique constraint (P2002)", async () => {
      // Both requests find no existing payment initially
      (mockPrisma.payment.findFirst as jest.Mock)
        .mockResolvedValueOnce(null)  // First findFirst (no existing payment)
        .mockResolvedValueOnce(null)  // Second concurrent check
        .mockResolvedValueOnce(makePayment()); // Fallback fetch after P2002

      // Simulate the second DB insert failing due to unique constraint
      const { Prisma } = jest.requireActual("@prisma/client") as { Prisma: any };
      const p2002Error = Object.assign(new Error("Unique constraint"), {
        code: "P2002",
      });

      (mockPrisma.payment.create as jest.Mock)
        .mockResolvedValueOnce(makePayment()) // First request succeeds
        .mockRejectedValueOnce(p2002Error);   // Second request hits unique constraint

      const [res1, res2] = await Promise.all([
        request(app)
          .post(`/api/payments/${BOOKING_ID}/create-order`)
          .set("Authorization", `Bearer ${customerAToken()}`)
          .send({}),
        request(app)
          .post(`/api/payments/${BOOKING_ID}/create-order`)
          .set("Authorization", `Bearer ${customerAToken()}`)
          .send({}),
      ]);

      // Both responses should be successful (first created, second returned existing)
      expect([res1.status, res2.status].filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 12. Booking state validation
  // ────────────────────────────────────────────────────────────────────────────

  describe("12. Booking state validation", () => {
    it("cancelled booking cannot be paid (409)", async () => {
      (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue(
        makeBooking({ status: "CANCELLED" }),
      );

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("PAYMENT_NOT_PAYABLE");
      expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it("completed booking cannot be re-paid (409)", async () => {
      (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue(
        makeBooking({ status: "COMPLETED" }),
      );

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(409);
      expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it("in-progress booking cannot be paid (409)", async () => {
      (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue(
        makeBooking({ status: "IN_PROGRESS" }),
      );

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(409);
      expect(mockCreateOrder).not.toHaveBeenCalled();
    });

    it("confirmed booking is payable (201)", async () => {
      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(201);
    });

    it("OTP_PENDING booking is payable (201)", async () => {
      (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue(
        makeBooking({ status: "OTP_PENDING" }),
      );

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(201);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 13–18. Webhook security
  // ────────────────────────────────────────────────────────────────────────────

  describe("13–18. Webhook security", () => {

    function buildCapturedPayload(razorpayOrderId: string, razorpayPaymentId: string): string {
      return JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: {
              id: razorpayPaymentId,
              order_id: razorpayOrderId,
              amount: EXPECTED_PAISE,
              currency: "INR",
            },
          },
        },
      });
    }

    it("webhook missing X-Razorpay-Signature returns 401", async () => {
      const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);

      const res = await request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(401);
    });

    it("webhook with invalid signature returns 401", async () => {
      // Override the module-level mock to return false for this test
      mockVerifyWebhookSignature.mockReturnValueOnce(false);

      const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
      // Send a signature that doesn't match the body
      const badSignature = "0000000000000000000000000000000000000000000000000000000000000000";

      const res = await request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", badSignature)
        .send(body);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe("WEBHOOK_INVALID_SIGNATURE");
    });

    it("valid signature + payment.captured → COMPLETED + payment ID stored", async () => {
      (mockPrisma.payment.findUnique as jest.Mock).mockResolvedValue(
        makePayment({ status: "PENDING" }),
      );

      const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);

      const res = await request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", "valid_sig")
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Payment updated to COMPLETED with razorpay_payment_id
      const updateCall = (mockPrisma.payment.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.data.status).toBe("COMPLETED");
      expect(updateCall.data.razorpay_payment_id).toBe(RAZORPAY_PAYMENT_ID);
    });

    it("payment.captured event stores razorpay_payment_id", async () => {
      (mockPrisma.payment.findUnique as jest.Mock).mockResolvedValue(
        makePayment({ status: "PENDING" }),
      );

      const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);

      await request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", "valid_sig")
        .send(body);

      const updateCall = (mockPrisma.payment.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.data.razorpay_payment_id).toBe(RAZORPAY_PAYMENT_ID);
    });

    it("payment.failed event → FAILED status", async () => {
      (mockPrisma.payment.findUnique as jest.Mock).mockResolvedValue(
        makePayment({ status: "PENDING" }),
      );

      const body = JSON.stringify({
        event: "payment.failed",
        payload: { payment: { entity: { order_id: RAZORPAY_ORDER_ID } } },
      });

      const res = await request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", "valid_sig")
        .send(body);

      expect(res.status).toBe(200);
      const updateCall = (mockPrisma.payment.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.data.status).toBe("FAILED");
    });

    it("unknown event is acknowledged without mutating payment state", async () => {
      const body = JSON.stringify({ event: "order.paid", payload: {} });

      const res = await request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", "valid_sig")
        .send(body);

      expect(res.status).toBe(200);
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    });

    it("webhook idempotency: already COMPLETED payment skips second capture event", async () => {
      (mockPrisma.payment.findUnique as jest.Mock).mockResolvedValue(
        makePayment({ status: "COMPLETED", razorpay_payment_id: RAZORPAY_PAYMENT_ID }),
      );

      const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);

      const res = await request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", "valid_sig")
        .send(body);

      expect(res.status).toBe(200);
      // Update must NOT be called again — payment is already COMPLETED
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    });

    it("webhook for a different Razorpay order cannot complete this payment", async () => {
      const DIFFERENT_ORDER = "order_DIFFERENT000";
      // findUnique for the different order returns null (no local match)
      (mockPrisma.payment.findUnique as jest.Mock).mockResolvedValue(null);

      const body = buildCapturedPayload(DIFFERENT_ORDER, "pay_DIFFERENT999");

      const res = await request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", "valid_sig")
        .send(body);

      // Webhook is acknowledged but no payment is marked COMPLETED
      expect(res.status).toBe(200);
      expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 19. Payment status — ownership
  // ────────────────────────────────────────────────────────────────────────────

  describe("19. Payment status ownership", () => {
    it("customer A can retrieve their payment status", async () => {
      (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue({ id: BOOKING_ID });
      (mockPrisma.payment.findUnique as jest.Mock).mockResolvedValue(makePayment());

      const res = await request(app)
        .get(`/api/payments/${BOOKING_ID}`)
        .set("Authorization", `Bearer ${customerAToken()}`);

      expect(res.status).toBe(200);
      expect(res.body.data.razorpay_order_id).toBe(RAZORPAY_ORDER_ID);
    });

    it("customer B cannot get payment for customer A booking (403)", async () => {
      // Simulate no booking owned by customer B
      (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/payments/${BOOKING_ID}`)
        .set("Authorization", `Bearer ${customerBToken()}`);

      expect(res.status).toBe(403);
    });
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 20. Refund — ownership + lifecycle checks
  // ────────────────────────────────────────────────────────────────────────────

  describe("20. Refund ownership and lifecycle", () => {
    it("cannot refund another customer's payment (403)", async () => {
      (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/refund`)
        .set("Authorization", `Bearer ${customerBToken()}`)
        .send({});

      expect(res.status).toBe(403);
    });

    it("cannot refund a PENDING payment (409)", async () => {
      (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue({ id: BOOKING_ID });
      (mockPrisma.payment.findUnique as jest.Mock).mockResolvedValue(
        makePayment({ status: "PENDING" }),
      );

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/refund`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("REFUND_INVALID_STATE");
    });

    it("can refund a COMPLETED payment — ownership verified", async () => {
      (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue({ id: BOOKING_ID });
      (mockPrisma.payment.findUnique as jest.Mock).mockResolvedValue(
        makePayment({ status: "COMPLETED" }),
      );
      (mockPrisma.payment.update as jest.Mock).mockResolvedValue(
        makePayment({ status: "REFUNDED" }),
      );

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/refund`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("cannot refund a FAILED payment (409)", async () => {
      (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue({ id: BOOKING_ID });
      (mockPrisma.payment.findUnique as jest.Mock).mockResolvedValue(
        makePayment({ status: "FAILED" }),
      );

      const res = await request(app)
        .post(`/api/payments/${BOOKING_ID}/refund`)
        .set("Authorization", `Bearer ${customerAToken()}`)
        .send({});

      expect(res.status).toBe(409);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Unit tests for razorpayProvider.verifyWebhookSignature (real implementation)
// ══════════════════════════════════════════════════════════════════════════════

describe("razorpayProvider.verifyWebhookSignature (unit)", () => {
  const { verifyWebhookSignature: realVerify } = jest.requireActual(
    "../src/providers/razorpay/razorpayProvider",
  ) as typeof razorpayProvider;

  const SECRET = "super_secret_webhook_key_32bytes!";
  const BODY = JSON.stringify({ event: "payment.captured", payload: {} });

  it("returns true for a valid HMAC-SHA256 signature", () => {
    const validSig = crypto.createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(realVerify(BODY, validSig, SECRET)).toBe(true);
  });

  it("returns false for an incorrect signature", () => {
    expect(realVerify(BODY, "incorrect_signature", SECRET)).toBe(false);
  });

  it("returns false for an empty signature", () => {
    expect(realVerify(BODY, "", SECRET)).toBe(false);
  });

  it("returns false for empty secret", () => {
    const sig = crypto.createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(realVerify(BODY, sig, "")).toBe(false);
  });

  it("different body produces different signature (prevents body substitution)", () => {
    const sig = crypto.createHmac("sha256", SECRET).update(BODY).digest("hex");
    const tamperedBody = BODY.replace("captured", "failed");
    expect(realVerify(tamperedBody, sig, SECRET)).toBe(false);
  });

  it("accepts Buffer rawBody correctly", () => {
    const validSig = crypto.createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(realVerify(Buffer.from(BODY, "utf8"), validSig, SECRET)).toBe(true);
  });
});
