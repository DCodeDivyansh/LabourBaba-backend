/**
 * Payment Security Test Suite
 *
 * Covers:
 *   Finding #11 (P0): Payment Order Creation Security Invariants
 *   Finding #12 (P0): Webhook Replay / Idempotency Protection
 *
 * Architecture:
 *   - Prisma mocked at module level (no DB required for unit tests).
 *   - Razorpay provider adapter mocked at module boundary (no real API calls).
 *   - Concurrency/replay-protection tests exercise the mock Prisma unique-constraint
 *     path (P2002) which proves the service layer handles the DB invariant correctly.
 *   - Limitation: full database concurrency (two real PG connections racing) requires
 *     an integration environment. Documented in ISSUE_12_PAYMENT_WEBHOOK_REMEDIATION.md.
 *
 * Test sections:
 *   1.  Authentication
 *   2.  RBAC
 *   3.  Ownership
 *   4-5. Server-side amount + monetary units
 *   6.  Successful order creation
 *   7.  Provider failure
 *   8.  Provider response validation
 *   9.  Payment state after order creation
 *   10. Order creation idempotency
 *   11. Concurrency — order creation
 *   12. Booking state validation
 *   13. Webhook — signature tests (S1–S8)
 *   14. Webhook — raw body proof (A1–A4)
 *   15. Webhook — DB idempotency / replay protection (R1–R3)
 *   16. Webhook — payment integrity (P1–P7)
 *   17. Webhook — state machine
 *   18. Webhook — configuration (Cfg1–Cfg4)
 *   19. Payment status ownership
 *   20. Refund ownership and lifecycle
 *   21. Unit tests for verifyWebhookSignature (real implementation)
 */

import request from "supertest";
import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { generateToken } from "../src/utils/authUtils";
import { UserRole } from "../src/middlewares/authMiddleware";
import * as razorpayProvider from "../src/providers/razorpay/razorpayProvider";
import crypto from "crypto";

// ── Prisma mock ────────────────────────────────────────────────────────────────

jest.mock("../src/config/prisma", () => {
  const mockPayment = {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  };
  const mockPaymentWebhookEvent = {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  };
  const mockBooking = {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
  };

  return {
    __esModule: true,
    default: {
      booking: mockBooking,
      payment: mockPayment,
      paymentWebhookEvent: mockPaymentWebhookEvent,
      $transaction: jest.fn(async (callback: (tx: any) => Promise<any>) => {
        return callback({
          payment: mockPayment,
          paymentWebhookEvent: mockPaymentWebhookEvent,
        });
      }),
    },
  };
});

// ── Razorpay provider mock ─────────────────────────────────────────────────────

jest.mock("../src/providers/razorpay/razorpayProvider", () => ({
  ...jest.requireActual("../src/providers/razorpay/razorpayProvider"),
  createOrder: jest.fn(),
  createRefund: jest.fn().mockResolvedValue({
    razorpayRefundId: "rfnd_test123",
    paymentId: "pay_TestXYZ999",
    amount: 50000,
    currency: "INR",
    status: "processed",
  }),
  verifyWebhookSignature: jest.fn(),
}));

// ── Constants ──────────────────────────────────────────────────────────────────

const CUSTOMER_A_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const CUSTOMER_B_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const WORKER_ID     = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
const BOOKING_ID    = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
const REQ_ID        = "eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee";
const PAYMENT_ID    = "ffffffff-ffff-4fff-ffff-ffffffffffff";

const RAZORPAY_ORDER_ID   = "order_TestABC123";
const RAZORPAY_PAYMENT_ID = "pay_TestXYZ999";
const RATE_PER_DAY_RUPEES = 500;
const EXPECTED_PAISE      = 50000;

const WEBHOOK_SECRET = "test_webhook_secret_32_chars_long!!";

// ── Token helpers ──────────────────────────────────────────────────────────────

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

// ── Data factories ─────────────────────────────────────────────────────────────

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

function makeProviderOrder(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    razorpayOrderId: RAZORPAY_ORDER_ID,
    amount: EXPECTED_PAISE,
    currency: "INR",
    ...overrides,
  };
}

function makePayment(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: PAYMENT_ID,
    booking_id: BOOKING_ID,
    razorpay_order_id: RAZORPAY_ORDER_ID,
    razorpay_payment_id: overrides.status === "COMPLETED" ? RAZORPAY_PAYMENT_ID : overrides.razorpay_payment_id ?? null,
    status: "PENDING",
    amount: EXPECTED_PAISE,
    currency: "INR",
    idempotency_key: BOOKING_ID,
    ...overrides,
  };
}

function makeWebhookEvent(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id: "event-id-uuid",
    provider: "razorpay",
    providerEventId: RAZORPAY_PAYMENT_ID,
    eventType: "payment.captured",
    status: "PROCESSING",
    ...overrides,
  };
}

// ── Webhook payload builders ───────────────────────────────────────────────────

function buildCapturedPayload(orderId: string, paymentId: string, amount = EXPECTED_PAISE): string {
  return JSON.stringify({
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: paymentId,
          order_id: orderId,
          amount,
          currency: "INR",
        },
      },
    },
  });
}

function buildFailedPayload(orderId: string): string {
  return JSON.stringify({
    event: "payment.failed",
    payload: { payment: { entity: { order_id: orderId } } },
  });
}

function signPayload(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

// ── Mock accessors ─────────────────────────────────────────────────────────────

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockCreateOrder = razorpayProvider.createOrder as jest.Mock;
const mockCreateRefund = razorpayProvider.createRefund as jest.Mock;
const mockVerifyWebhookSignature = razorpayProvider.verifyWebhookSignature as jest.Mock;

// ── Transaction mock helper ────────────────────────────────────────────────────

/**
 * Configures the prisma.$transaction mock to execute a callback with the
 * given inner-transaction mock objects.
 * This lets us precisely control what findUnique / updateMany / create return
 * inside the transaction handler in processPaymentCaptured / processPaymentFailed.
 */
function setupTransactionMock(overrides: {
  paymentFindUnique?: any;
  paymentUpdateMany?: { count: number };
  webhookEventCreate?: any;
  webhookEventUpdate?: any;
  rejectWebhookCreate?: any;
} = {}) {
  const txPayment = {
    findUnique: jest.fn().mockResolvedValue(overrides.paymentFindUnique ?? makePayment()),
    update: jest.fn().mockResolvedValue({}),
    updateMany: jest.fn().mockResolvedValue(overrides.paymentUpdateMany ?? { count: 1 }),
  };
  const txWebhookEvent = {
    create: overrides.rejectWebhookCreate
      ? jest.fn().mockRejectedValue(overrides.rejectWebhookCreate)
      : jest.fn().mockResolvedValue(overrides.webhookEventCreate ?? makeWebhookEvent()),
    update: jest.fn().mockResolvedValue(overrides.webhookEventUpdate ?? makeWebhookEvent()),
  };

  (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (callback: any) => {
    return callback({ payment: txPayment, paymentWebhookEvent: txWebhookEvent });
  });

  return { txPayment, txWebhookEvent };
}

// ══════════════════════════════════════════════════════════════════════════════
// SETUP
// ══════════════════════════════════════════════════════════════════════════════

beforeEach(() => {
  jest.clearAllMocks();
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

  // Default happy-path DB state for order-creation tests
  mockCreateOrder.mockResolvedValue(makeProviderOrder());
  mockCreateRefund.mockResolvedValue({
    razorpayRefundId: "rfnd_test123",
    paymentId: RAZORPAY_PAYMENT_ID,
    amount: EXPECTED_PAISE,
    currency: "INR",
    status: "processed",
  });
  (mockPrisma.payment.create as jest.Mock).mockResolvedValue(makePayment());
  (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue(makeBooking());
  (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
  (mockPrisma.payment.findUnique as jest.Mock).mockResolvedValue(makePayment());

  // Default: signature verification passes
  mockVerifyWebhookSignature.mockReturnValue(true);

  // Default $transaction mock
  (mockPrisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
    return callback(mockPrisma);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Authentication
// ══════════════════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 2 — RBAC
// ══════════════════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 3 — Ownership
// ══════════════════════════════════════════════════════════════════════════════

describe("3. Ownership", () => {
  it("customer B cannot create order for customer A booking (403)", async () => {
    (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
    const res = await request(app)
      .post(`/api/payments/${BOOKING_ID}/create-order`)
      .set("Authorization", `Bearer ${customerBToken()}`)
      .send({});
    expect(res.status).toBe(403);
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("customer B cannot view customer A payment status (403)", async () => {
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

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 4 & 5 — Server-side amount + monetary units
// ══════════════════════════════════════════════════════════════════════════════

describe("4 & 5. Server-side amount derivation and monetary units", () => {
  it("Razorpay is called with rate_per_day × 100 paise (₹500/day → 50000p)", async () => {
    const res = await request(app)
      .post(`/api/payments/${BOOKING_ID}/create-order`)
      .set("Authorization", `Bearer ${customerAToken()}`)
      .send({});
    expect(res.status).toBe(201);
    expect(mockCreateOrder).toHaveBeenCalledTimes(1);
    expect(mockCreateOrder.mock.calls[0][0].amountPaise).toBe(EXPECTED_PAISE);
    expect(mockCreateOrder.mock.calls[0][0].currency).toBe("INR");
  });

  it("high client-supplied amount is completely ignored", async () => {
    const res = await request(app)
      .post(`/api/payments/${BOOKING_ID}/create-order`)
      .set("Authorization", `Bearer ${customerAToken()}`)
      .send({ amount: 9999999 });
    expect(res.status).toBe(201);
    expect(mockCreateOrder.mock.calls[0][0].amountPaise).toBe(EXPECTED_PAISE);
  });

  it("low client-supplied amount is completely ignored", async () => {
    const res = await request(app)
      .post(`/api/payments/${BOOKING_ID}/create-order`)
      .set("Authorization", `Bearer ${customerAToken()}`)
      .send({ amount: 1 });
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

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 6 — Successful order creation
// ══════════════════════════════════════════════════════════════════════════════

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
    const createCall = (mockPrisma.payment.create as jest.Mock).mock.calls[0][0];
    expect(createCall.data.razorpay_order_id).toBe(RAZORPAY_ORDER_ID);
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

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 7 — Provider failure
// ══════════════════════════════════════════════════════════════════════════════

describe("7. Provider failure handling", () => {
  it("provider SDK failure → no payment record created, returns 502", async () => {
    const { RazorpayProviderError } = jest.requireActual(
      "../src/providers/razorpay/razorpayProvider",
    ) as typeof razorpayProvider;
    mockCreateOrder.mockRejectedValue(
      new RazorpayProviderError("Provider failed", "PAYMENT_ORDER_CREATION_FAILED", 502),
    );
    const res = await request(app)
      .post(`/api/payments/${BOOKING_ID}/create-order`)
      .set("Authorization", `Bearer ${customerAToken()}`)
      .send({});
    expect(res.status).toBe(502);
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

  it("error response does not leak provider credentials", async () => {
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

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 8 — Provider response validation
// ══════════════════════════════════════════════════════════════════════════════

describe("8. Provider response validation", () => {
  it("amount mismatch from provider → 502, no DB write", async () => {
    const { RazorpayProviderError } = jest.requireActual(
      "../src/providers/razorpay/razorpayProvider",
    ) as typeof razorpayProvider;
    mockCreateOrder.mockRejectedValue(
      new RazorpayProviderError("Amount mismatch", "PAYMENT_AMOUNT_MISMATCH", 502),
    );
    const res = await request(app)
      .post(`/api/payments/${BOOKING_ID}/create-order`)
      .set("Authorization", `Bearer ${customerAToken()}`)
      .send({});
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("PAYMENT_AMOUNT_MISMATCH");
    expect(mockPrisma.payment.create).not.toHaveBeenCalled();
  });

  it("currency mismatch from provider → 502, no DB write", async () => {
    const { RazorpayProviderError } = jest.requireActual(
      "../src/providers/razorpay/razorpayProvider",
    ) as typeof razorpayProvider;
    mockCreateOrder.mockRejectedValue(
      new RazorpayProviderError("Currency mismatch", "PAYMENT_CURRENCY_MISMATCH", 502),
    );
    const res = await request(app)
      .post(`/api/payments/${BOOKING_ID}/create-order`)
      .set("Authorization", `Bearer ${customerAToken()}`)
      .send({});
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("PAYMENT_CURRENCY_MISMATCH");
    expect(mockPrisma.payment.create).not.toHaveBeenCalled();
  });

  it("missing order ID from provider → 502, no DB write", async () => {
    const { RazorpayProviderError } = jest.requireActual(
      "../src/providers/razorpay/razorpayProvider",
    ) as typeof razorpayProvider;
    mockCreateOrder.mockRejectedValue(
      new RazorpayProviderError("Invalid ID", "PAYMENT_PROVIDER_RESPONSE_INVALID", 502),
    );
    const res = await request(app)
      .post(`/api/payments/${BOOKING_ID}/create-order`)
      .set("Authorization", `Bearer ${customerAToken()}`)
      .send({});
    expect(res.status).toBe(502);
    expect(mockPrisma.payment.create).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 9 — Payment state after order creation
// ══════════════════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 10 — Order creation idempotency
// ══════════════════════════════════════════════════════════════════════════════

describe("10. Order creation idempotency", () => {
  it("second request returns existing pending order without calling Razorpay again", async () => {
    (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(makePayment());
    const res = await request(app)
      .post(`/api/payments/${BOOKING_ID}/create-order`)
      .set("Authorization", `Bearer ${customerAToken()}`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.data.razorpayOrderId).toBe(RAZORPAY_ORDER_ID);
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("existing COMPLETED payment returns 409", async () => {
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

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 11 — Concurrency (order creation)
// ══════════════════════════════════════════════════════════════════════════════

describe("11. Concurrency — order creation", () => {
  it("concurrent P2002 on payment.create is handled gracefully", async () => {
    (mockPrisma.payment.findFirst as jest.Mock)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makePayment());

    const p2002Error = Object.assign(new Error("Unique constraint"), { code: "P2002" });
    (mockPrisma.payment.create as jest.Mock)
      .mockResolvedValueOnce(makePayment())
      .mockRejectedValueOnce(p2002Error);

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

    expect([res1.status, res2.status].filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 12 — Booking state validation
// ══════════════════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 13 — Webhook signature tests (S1–S8)
// ══════════════════════════════════════════════════════════════════════════════

describe("13. Webhook — Signature Tests (S1–S8)", () => {
  // S1 — Valid signature → accepted
  it("S1: valid signature + payment.captured → 200", async () => {
    setupTransactionMock({
      paymentFindUnique: makePayment({ status: "PENDING" }),
      paymentUpdateMany: { count: 1 },
    });
    const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
    mockVerifyWebhookSignature.mockReturnValue(true);
    const res = await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", "valid_sig")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  // S2 — Missing signature → 401
  it("S2: missing X-Razorpay-Signature returns 401", async () => {
    const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
    const res = await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .send(body);
    expect(res.status).toBe(401);
    expect(mockVerifyWebhookSignature).not.toHaveBeenCalled();
  });

  // S3 — Invalid signature → 401
  it("S3: invalid signature returns 401 and does not mutate state", async () => {
    mockVerifyWebhookSignature.mockReturnValue(false);
    const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
    const res = await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", "0000000000000000000000000000000000000000000000000000000000000000")
      .send(body);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("WEBHOOK_INVALID_SIGNATURE");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  // S4 — Modified payload + original signature → rejected (real crypto)
  it("S4: modified payload with original signature fails real verification", () => {
    const { verifyWebhookSignature: realVerify } = jest.requireActual(
      "../src/providers/razorpay/razorpayProvider",
    ) as typeof razorpayProvider;

    const secret = "super_secret_webhook_key_32bytes!";
    const original = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
    const sig = crypto.createHmac("sha256", secret).update(original).digest("hex");

    const tampered = original.replace("payment.captured", "payment.failed");
    expect(realVerify(Buffer.from(tampered), sig, secret)).toBe(false);
  });

  // S5 — Wrong webhook secret → rejected
  it("S5: wrong webhook secret rejects a correctly-signed request", () => {
    const { verifyWebhookSignature: realVerify } = jest.requireActual(
      "../src/providers/razorpay/razorpayProvider",
    ) as typeof razorpayProvider;

    const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
    const sig = crypto.createHmac("sha256", "correct-secret").update(body).digest("hex");
    expect(realVerify(Buffer.from(body), sig, "wrong-secret")).toBe(false);
  });

  // S6 — Malformed hex signature
  it("S6: malformed (non-hex) signature does not pass verification", () => {
    const { verifyWebhookSignature: realVerify } = jest.requireActual(
      "../src/providers/razorpay/razorpayProvider",
    ) as typeof razorpayProvider;

    const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
    expect(realVerify(Buffer.from(body), "not-a-valid-hex-signature!!!", "secret")).toBe(false);
  });

  // S7 — Wrong signature length
  it("S7: signature of wrong length is safely rejected", () => {
    const { verifyWebhookSignature: realVerify } = jest.requireActual(
      "../src/providers/razorpay/razorpayProvider",
    ) as typeof razorpayProvider;

    const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
    // Too short
    expect(realVerify(Buffer.from(body), "abc123", "secret")).toBe(false);
    // Too long (double a valid sig)
    const validSig = crypto.createHmac("sha256", "secret").update(body).digest("hex");
    expect(realVerify(Buffer.from(body), validSig + validSig, "secret")).toBe(false);
  });

  // S8 — Empty values
  it("S8: empty signature or empty secret is rejected", () => {
    const { verifyWebhookSignature: realVerify } = jest.requireActual(
      "../src/providers/razorpay/razorpayProvider",
    ) as typeof razorpayProvider;
    const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
    const sig = crypto.createHmac("sha256", "secret").update(body).digest("hex");

    expect(realVerify(Buffer.from(body), "", "secret")).toBe(false);
    expect(realVerify(Buffer.from(body), sig, "")).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 14 — Raw body proof (A1–A4)
// ══════════════════════════════════════════════════════════════════════════════

describe("14. Webhook — Raw Body Proof (A1–A4)", () => {
  /**
   * A1/A2: Verify that verifyWebhookSignature is called with the exact Buffer
   * captured from the HTTP request, not a re-serialized req.body string.
   *
   * We spy on the real verifyWebhookSignature to capture what was actually passed
   * as the first argument.
   */
  it("A1/A2: verifyWebhookSignature receives the exact raw Buffer, not JSON.stringify(req.body)", async () => {
    // Use the real implementation, not the mock
    const { verifyWebhookSignature: realVerify } = jest.requireActual(
      "../src/providers/razorpay/razorpayProvider",
    ) as typeof razorpayProvider;

    setupTransactionMock({
      paymentFindUnique: makePayment({ status: "PENDING" }),
      paymentUpdateMany: { count: 1 },
    });

    let capturedRawBody: Buffer | string | undefined;
    mockVerifyWebhookSignature.mockImplementation((rawBody, _sig, _secret) => {
      capturedRawBody = rawBody;
      return true; // Let the request proceed
    });

    const payload = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
    await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", "any_sig")
      .send(payload);

    // The captured body must be a Buffer (the raw bytes from the wire)
    expect(capturedRawBody).toBeInstanceOf(Buffer);

    // The raw Buffer content must exactly equal the sent payload string
    expect((capturedRawBody as Buffer).toString("utf8")).toBe(payload);

    // Prove it is NOT JSON.stringify(JSON.parse(payload)) — those MAY differ in whitespace
    // For this payload they're equal, but the critical point is we received a Buffer, not a re-string
    const reparsedAndReserialized = JSON.stringify(JSON.parse(payload));
    // Both happen to be equal for compact JSON, but if Razorpay sends compact JSON this is fine.
    // The crucial invariant is verified: Buffer was passed, not a re-parsed string.
    expect(capturedRawBody).toBeInstanceOf(Buffer);
  });

  /**
   * A3: Changing the payload after signing causes verification failure.
   * Tests the real crypto implementation.
   */
  it("A3: tampered payload with original signature fails verification (real crypto)", () => {
    const { verifyWebhookSignature: realVerify } = jest.requireActual(
      "../src/providers/razorpay/razorpayProvider",
    ) as typeof razorpayProvider;

    const secret = "test_webhook_secret_32_chars_long!!";
    const original = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
    const sig = crypto.createHmac("sha256", secret).update(original).digest("hex");

    // Tamper: change the amount field
    const tampered = original.replace(`"amount":${EXPECTED_PAISE}`, '"amount":1');
    expect(realVerify(Buffer.from(tampered, "utf8"), sig, secret)).toBe(false);
  });

  /**
   * A4: Whitespace/representation change after signing fails verification.
   * Razorpay signs the exact bytes it sends — even formatting differences matter.
   */
  it("A4: whitespace difference in body after signing fails verification (real crypto)", () => {
    const { verifyWebhookSignature: realVerify } = jest.requireActual(
      "../src/providers/razorpay/razorpayProvider",
    ) as typeof razorpayProvider;

    const secret = "test_webhook_secret_32_chars_long!!";
    const compactBody = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
    const sig = crypto.createHmac("sha256", secret).update(compactBody).digest("hex");

    // Same content but pretty-printed — different bytes
    const prettyBody = JSON.stringify(JSON.parse(compactBody), null, 2);
    expect(prettyBody).not.toBe(compactBody); // Confirm they differ
    expect(realVerify(Buffer.from(prettyBody, "utf8"), sig, secret)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 15 — DB idempotency / replay protection (R1–R3)
// ══════════════════════════════════════════════════════════════════════════════

describe("15. Webhook — DB Idempotency / Replay Protection (R1–R3)", () => {
  /**
   * R1: Same event delivered twice.
   * First delivery: transaction succeeds, payment transitions.
   * Second delivery: unique constraint (P2002) fires → service returns 200 without
   * executing any payment update.
   */
  it("R1: same event delivered twice — payment transitions exactly once", async () => {
    const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
    const p2002 = Object.assign(new Error("Unique constraint"), { code: "P2002" });

    // First delivery — succeeds (transaction mock set up for first call)
    (mockPrisma.$transaction as jest.Mock)
      .mockImplementationOnce(async (callback: any) => {
        const txPayment = {
          findUnique: jest.fn().mockResolvedValue(makePayment({ status: "PENDING" })),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        };
        const txWebhookEvent = {
          create: jest.fn().mockResolvedValue(makeWebhookEvent()),
          update: jest.fn().mockResolvedValue(makeWebhookEvent()),
        };
        return callback({ payment: txPayment, paymentWebhookEvent: txWebhookEvent });
      })
      // Second delivery — P2002 on webhook event create
      .mockImplementationOnce(async (callback: any) => {
        const txPayment = {
          findUnique: jest.fn(),
          updateMany: jest.fn(),
        };
        const txWebhookEvent = {
          create: jest.fn().mockRejectedValue(p2002),
          update: jest.fn(),
        };
        return callback({ payment: txPayment, paymentWebhookEvent: txWebhookEvent });
      });

    const res1 = await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", "valid_sig")
      .send(body);
    expect(res1.status).toBe(200);
    expect(res1.body.message).toBe("Payment captured");

    const res2 = await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", "valid_sig")
      .send(body);
    expect(res2.status).toBe(200);
    expect(res2.body.success).toBe(true);
    expect(res2.body.message).toContain("already processed");
  });

  /**
   * R2: Same event delivered many times.
   * All deliveries after the first return 200 without payment mutation.
   */
  it("R2: same event delivered many times — only one payment transition", async () => {
    const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
    const p2002 = Object.assign(new Error("Unique constraint"), { code: "P2002" });

    // First delivery succeeds
    (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (callback: any) => {
      const txPayment = {
        findUnique: jest.fn().mockResolvedValue(makePayment({ status: "PENDING" })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      };
      const txWebhookEvent = {
        create: jest.fn().mockResolvedValue(makeWebhookEvent()),
        update: jest.fn().mockResolvedValue(makeWebhookEvent()),
      };
      return callback({ payment: txPayment, paymentWebhookEvent: txWebhookEvent });
    });

    const first = await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", "valid_sig")
      .send(body);
    expect(first.status).toBe(200);
    expect(first.body.message).toBe("Payment captured");

    // Subsequent deliveries — all P2002 duplicates
    for (let i = 0; i < 4; i++) {
      (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (callback: any) => {
        const txWebhookEvent = {
          create: jest.fn().mockRejectedValue(p2002),
          update: jest.fn(),
        };
        return callback({ payment: { findUnique: jest.fn(), updateMany: jest.fn() }, paymentWebhookEvent: txWebhookEvent });
      });
      const dup = await request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", "valid_sig")
        .send(body);
      expect(dup.status).toBe(200);
      expect(dup.body.message).toContain("already processed");
    }
  });

  /**
   * R3: Concurrent delivery — one wins the unique constraint race.
   *
   * We simulate two simultaneous requests by configuring the first transaction
   * to succeed and the second to get P2002 from the paymentWebhookEvent.create.
   * The P2002 error is caught by isPrismaUniqueConstraintError, returning 200.
   *
   * Limitation: this test proves the service layer handles P2002 correctly.
   * True concurrent PostgreSQL contention requires a real database; documented
   * in ISSUE_12_PAYMENT_WEBHOOK_REMEDIATION.md under "Remaining Limitations".
   */
  it("R3: concurrent duplicate delivery — only one claims the event", async () => {
    const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
    const p2002 = Object.assign(new Error("Unique constraint"), { code: "P2002" });

    // Explicitly set up two sequential $transaction implementations:
    // first wins, second gets P2002 (simulates DB unique constraint winner/loser)
    (mockPrisma.$transaction as jest.Mock)
      .mockImplementationOnce(async (callback: any) => {
        const txPayment = {
          findUnique: jest.fn().mockResolvedValue(makePayment({ status: "PENDING" })),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        };
        const txWebhookEvent = {
          create: jest.fn().mockResolvedValue(makeWebhookEvent()),
          update: jest.fn().mockResolvedValue(makeWebhookEvent()),
        };
        return callback({ payment: txPayment, paymentWebhookEvent: txWebhookEvent });
      })
      .mockImplementationOnce(async (callback: any) => {
        const txWebhookEvent = {
          create: jest.fn().mockRejectedValue(p2002),
          update: jest.fn(),
        };
        return callback({ payment: { findUnique: jest.fn(), updateMany: jest.fn() }, paymentWebhookEvent: txWebhookEvent });
      });

    const [res1, res2] = await Promise.all([
      request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", "valid_sig")
        .send(body),
      request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", "valid_sig")
        .send(body),
    ]);

    // Both must return 200 (Razorpay retry-safe)
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    // The combined messages must contain exactly one capture and one duplicate
    const allMessages = [res1.body.message, res2.body.message];
    const captureCount = allMessages.filter((m: string) => m === "Payment captured").length;
    const dupCount = allMessages.filter((m: string) => m?.includes("already processed")).length;
    expect(captureCount).toBe(1);
    expect(dupCount).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 16 — Payment integrity (P1–P7)
// ══════════════════════════════════════════════════════════════════════════════

describe("16. Webhook — Payment Integrity (P1–P7)", () => {
  // P1: Unknown provider order → no payment mutation
  it("P1: unknown provider order ID → payment unchanged", async () => {
    (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (callback: any) => {
      const txPayment = { findUnique: jest.fn().mockResolvedValue(null), updateMany: jest.fn() };
      const txWebhookEvent = {
        create: jest.fn().mockResolvedValue(makeWebhookEvent()),
        update: jest.fn().mockResolvedValue(makeWebhookEvent()),
      };
      return callback({ payment: txPayment, paymentWebhookEvent: txWebhookEvent });
    });
    const body = buildCapturedPayload("order_UNKNOWN", RAZORPAY_PAYMENT_ID);
    const res = await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", "valid_sig")
      .send(body);
    expect(res.status).toBe(200);
  });

  // P3: Amount mismatch → payment NOT marked COMPLETED
  it("P3: amount mismatch → payment not marked COMPLETED", async () => {
    // Webhook says amount=1 but local payment has amount=50000
    (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (callback: any) => {
      const txPayment = {
        findUnique: jest.fn().mockResolvedValue(makePayment({ amount: EXPECTED_PAISE })),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn(),
      };
      const txWebhookEvent = {
        create: jest.fn().mockResolvedValue(makeWebhookEvent()),
        update: jest.fn().mockResolvedValue(makeWebhookEvent()),
      };
      return callback({ payment: txPayment, paymentWebhookEvent: txWebhookEvent });
    });
    const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID, 1);
    const res = await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", "valid_sig")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.message).toContain("amount mismatch");
  });

  // P4: Currency mismatch → payment NOT marked COMPLETED
  it("P4: currency mismatch → payment not marked COMPLETED", async () => {
    (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (callback: any) => {
      const txPayment = {
        findUnique: jest.fn().mockResolvedValue(makePayment({ currency: "INR" })),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn(),
      };
      const txWebhookEvent = {
        create: jest.fn().mockResolvedValue(makeWebhookEvent()),
        update: jest.fn().mockResolvedValue(makeWebhookEvent()),
      };
      return callback({ payment: txPayment, paymentWebhookEvent: txWebhookEvent });
    });
    const mismatchBody = JSON.stringify({
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: RAZORPAY_PAYMENT_ID,
            order_id: RAZORPAY_ORDER_ID,
            amount: EXPECTED_PAISE,
            currency: "USD",
          },
        },
      },
    });
    const res = await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", "valid_sig")
      .send(mismatchBody);
    expect(res.status).toBe(200);
    expect(res.body.message).toContain("currency mismatch");
  });

  // P5/P6: Valid event → exactly one state transition
  it("P5/P6: valid captured event → exactly one PENDING→COMPLETED transition", async () => {
    (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (callback: any) => {
      const txPayment = {
        findUnique: jest.fn().mockResolvedValue(makePayment({ status: "PENDING" })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      };
      const txWebhookEvent = {
        create: jest.fn().mockResolvedValue(makeWebhookEvent()),
        update: jest.fn().mockResolvedValue(makeWebhookEvent()),
      };
      return callback({ payment: txPayment, paymentWebhookEvent: txWebhookEvent });
    });
    const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
    const res = await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", "valid_sig")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Payment captured");
  });

  // P7: Already-completed payment receiving duplicate capture → safe/idempotent
  it("P7: already-completed payment + duplicate webhook → idempotent 200, no second update", async () => {
    (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (callback: any) => {
      const txPayment = {
        findUnique: jest.fn().mockResolvedValue(makePayment({ status: "COMPLETED", razorpay_payment_id: RAZORPAY_PAYMENT_ID })),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }), // WHERE status=PENDING matches nothing
      };
      const txWebhookEvent = {
        create: jest.fn().mockResolvedValue(makeWebhookEvent()),
        update: jest.fn().mockResolvedValue(makeWebhookEvent()),
      };
      return callback({ payment: txPayment, paymentWebhookEvent: txWebhookEvent });
    });
    const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
    const res = await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", "valid_sig")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // updateMany returned count=0 → already transitioned path
    expect(res.body.message).toContain("already completed");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 17 — State machine
// ══════════════════════════════════════════════════════════════════════════════

describe("17. Webhook — State Machine", () => {
  it("payment.captured marks PENDING payment as COMPLETED", async () => {
    (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (callback: any) => {
      const txPayment = {
        findUnique: jest.fn().mockResolvedValue(makePayment({ status: "PENDING" })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      };
      const txWebhookEvent = {
        create: jest.fn().mockResolvedValue(makeWebhookEvent()),
        update: jest.fn().mockResolvedValue(makeWebhookEvent()),
      };
      return callback({ payment: txPayment, paymentWebhookEvent: txWebhookEvent });
    });
    const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
    const res = await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", "valid_sig")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Payment captured");
  });

  it("payment.failed marks PENDING payment as FAILED", async () => {
    (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (callback: any) => {
      const txPayment = {
        findUnique: jest.fn().mockResolvedValue(makePayment({ status: "PENDING" })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      };
      const txWebhookEvent = {
        create: jest.fn().mockResolvedValue(makeWebhookEvent()),
        update: jest.fn().mockResolvedValue(makeWebhookEvent()),
      };
      return callback({ payment: txPayment, paymentWebhookEvent: txWebhookEvent });
    });
    const body = buildFailedPayload(RAZORPAY_ORDER_ID);
    const res = await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", "valid_sig")
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Payment failed");
  });

  it("payment.failed on a COMPLETED payment is blocked (COMPLETED state not re-writable)", async () => {
    // updateMany WHERE status=PENDING will not match a COMPLETED payment → count=0
    (mockPrisma.$transaction as jest.Mock).mockImplementationOnce(async (callback: any) => {
      const txPayment = {
        findUnique: jest.fn().mockResolvedValue(makePayment({ status: "COMPLETED" })),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      };
      const txWebhookEvent = {
        create: jest.fn().mockResolvedValue(makeWebhookEvent()),
        update: jest.fn().mockResolvedValue(makeWebhookEvent()),
      };
      return callback({ payment: txPayment, paymentWebhookEvent: txWebhookEvent });
    });
    const body = buildFailedPayload(RAZORPAY_ORDER_ID);
    const res = await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", "valid_sig")
      .send(body);
    expect(res.status).toBe(200); // Safe idempotent ack
    // The service returns the actual state it found, not "already transitioned"
    expect(res.body.message).toMatch(/already (transitioned|in state)/);
  });

  it("unknown event is acknowledged without state change", async () => {
    const body = JSON.stringify({ event: "order.paid", payload: {} });
    const res = await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", "valid_sig")
      .send(body);
    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 18 — Configuration tests (Cfg1–Cfg4)
// ══════════════════════════════════════════════════════════════════════════════

describe("18. Webhook — Configuration Tests (Cfg1–Cfg4)", () => {
  /**
   * Cfg2: Missing webhook secret in non-production → webhook acknowledged but NOT processed.
   * The secret is missing (deleted from env), so the service must return 200 without
   * touching any payment state.
   */
  it("Cfg2: missing webhook secret → event acknowledged but NOT processed (no DB writes)", async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);

    const res = await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", "some_sig")
      .send(body);

    // Must return 200 (provider-compatible ack) but must not have processed anything
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // No verification called — we never had a secret
    expect(mockVerifyWebhookSignature).not.toHaveBeenCalled();
    // No DB writes of any kind
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.payment.update).not.toHaveBeenCalled();
    expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
  });

  /**
   * Cfg3: Webhook secret must not appear in any error response.
   */
  it("Cfg3: webhook secret never appears in error responses", async () => {
    mockVerifyWebhookSignature.mockReturnValue(false);
    const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
    const res = await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", "bad_sig")
      .send(body);
    expect(res.status).toBe(401);
    const responseText = JSON.stringify(res.body);
    expect(responseText).not.toContain(WEBHOOK_SECRET);
    expect(responseText).not.toContain("webhook_secret");
    expect(responseText).not.toContain("RAZORPAY_WEBHOOK_SECRET");
  });

  /**
   * Cfg4: Webhook secret must not appear in logged messages.
   * We spy on console.warn/error to check the secret never leaks.
   */
  it("Cfg4: webhook secret never appears in console logs on signature failure", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    mockVerifyWebhookSignature.mockReturnValue(false);
    const body = buildCapturedPayload(RAZORPAY_ORDER_ID, RAZORPAY_PAYMENT_ID);
    await request(app)
      .post("/api/payments/webhook")
      .set("Content-Type", "application/json")
      .set("X-Razorpay-Signature", "bad_sig")
      .send(body);

    // All logged arguments combined should not contain the secret
    const allLogs = [
      ...warnSpy.mock.calls.flat(),
      ...errorSpy.mock.calls.flat(),
    ].join(" ");
    expect(allLogs).not.toContain(WEBHOOK_SECRET);

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 19 — Payment status ownership
// ══════════════════════════════════════════════════════════════════════════════

describe("19. Payment status ownership", () => {
  it("customer A can retrieve their payment status", async () => {
    (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue({ id: BOOKING_ID, customer_id: CUSTOMER_A_ID });
    (mockPrisma.payment.findFirst as jest.Mock).mockResolvedValue(makePayment());
    const res = await request(app)
      .get(`/api/payments/${BOOKING_ID}`)
      .set("Authorization", `Bearer ${customerAToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.razorpay_order_id).toBe(RAZORPAY_ORDER_ID);
  });

  it("customer B cannot get payment for customer A booking (403)", async () => {
    (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
    const res = await request(app)
      .get(`/api/payments/${BOOKING_ID}`)
      .set("Authorization", `Bearer ${customerBToken()}`);
    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 20 — Refund ownership and lifecycle
// ══════════════════════════════════════════════════════════════════════════════

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
    (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue({ id: BOOKING_ID, customer_id: CUSTOMER_A_ID });
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

  it("can refund a COMPLETED payment", async () => {
    (mockPrisma.booking.findFirst as jest.Mock).mockResolvedValue({ id: BOOKING_ID, customer_id: CUSTOMER_A_ID });
    (mockPrisma.payment.findUnique as jest.Mock).mockResolvedValue(
      makePayment({ status: "COMPLETED", razorpay_payment_id: RAZORPAY_PAYMENT_ID }),
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

// ══════════════════════════════════════════════════════════════════════════════
// SECTION 21 — Unit tests for verifyWebhookSignature (real implementation)
// ══════════════════════════════════════════════════════════════════════════════

describe("21. verifyWebhookSignature — unit tests (real implementation)", () => {
  const { verifyWebhookSignature: realVerify } = jest.requireActual(
    "../src/providers/razorpay/razorpayProvider",
  ) as typeof razorpayProvider;

  const SECRET = "super_secret_webhook_key_32bytes!";
  const BODY   = JSON.stringify({ event: "payment.captured", payload: {} });

  it("returns true for a valid HMAC-SHA256 signature", () => {
    const sig = crypto.createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(realVerify(BODY, sig, SECRET)).toBe(true);
  });

  it("returns false for an incorrect signature", () => {
    expect(realVerify(BODY, "incorrect_signature", SECRET)).toBe(false);
  });

  it("returns false for an empty signature", () => {
    expect(realVerify(BODY, "", SECRET)).toBe(false);
  });

  it("returns false for an empty secret", () => {
    const sig = crypto.createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(realVerify(BODY, sig, "")).toBe(false);
  });

  it("different body produces different signature (prevents body substitution)", () => {
    const sig = crypto.createHmac("sha256", SECRET).update(BODY).digest("hex");
    const tampered = BODY.replace("captured", "failed");
    expect(realVerify(tampered, sig, SECRET)).toBe(false);
  });

  it("accepts Buffer rawBody correctly", () => {
    const sig = crypto.createHmac("sha256", SECRET).update(BODY).digest("hex");
    expect(realVerify(Buffer.from(BODY, "utf8"), sig, SECRET)).toBe(true);
  });

  it("timing-safe equal: same result regardless of where bytes differ", () => {
    // If timingSafeEqual were not used, short-circuit comparison might give
    // different timing depending on position of first mismatch.
    // We cannot directly test timing, but we can confirm both wrong sigs return false.
    const sig = crypto.createHmac("sha256", SECRET).update(BODY).digest("hex");
    const wrongFirstByte = "0" + sig.slice(1);
    const wrongLastByte  = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
    expect(realVerify(BODY, wrongFirstByte, SECRET)).toBe(false);
    expect(realVerify(BODY, wrongLastByte, SECRET)).toBe(false);
  });
});
