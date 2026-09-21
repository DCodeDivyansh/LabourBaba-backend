/**
 * Issues 61, 62 & 68 - Payment Pricing, Razorpay Order Lifecycle & State Machine Tests
 *
 * Verifies that:
 * 1. Server-derived pricing: client cannot alter the payable amount (rate_per_day * 100).
 * 2. Real Razorpay order lifecycle: provider order creation persists order ID and PENDING status.
 * 3. Idempotency: duplicate order creation returns the existing PENDING order.
 * 4. Explicit state machine: legal transitions succeed; illegal transitions are strictly rejected.
 */

import prisma from "../src/config/prisma";
import {
  createOrder,
  PaymentStatus,
  transitionPaymentStatus,
} from "../src/features/payment/paymentServices";
import { _setRazorpayInstanceForTesting } from "../src/providers/razorpay/razorpayProvider";

describe("Issues 61, 62, 68 - Payment Pricing, Order Lifecycle & State Machine", () => {
  jest.setTimeout(30000);

  const customerId = "00000000-0000-4008-a000-000000000001";
  const workerId = "00000000-0000-4008-b000-000000000001";
  const jobId = "00000000-0000-4008-c000-000000000001";
  const requirementId = "00000000-0000-4008-d000-000000000001";
  const bookingId = "00000000-0000-4008-e000-000000000001";
  let skillCategoryId: string;

  beforeAll(async () => {
    // Clean test records
    await prisma.review.deleteMany({ where: { booking_id: bookingId } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_id: bookingId } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: bookingId } }).catch(() => {});
    await prisma.job_requirement.deleteMany({ where: { id: requirementId } }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: jobId } }).catch(() => {});
    await prisma.worker.deleteMany({ where: { id: workerId } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { id: customerId } }).catch(() => {});

    let category = await prisma.skill_category.findFirst({ where: { name: "PaymentTestSkill" } });
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "PaymentTestSkill", is_active: true },
      });
    }
    skillCategoryId = category.id;

    await prisma.customer.create({
      data: { id: customerId, phone: "+919998000001", name: "Payment Customer", password: "hash" },
    });

    await prisma.worker.create({
      data: {
        id: workerId,
        phone: "+919998000002",
        name: "Payment Worker",
        password: "hash",
        skill_type: "PaymentTestSkill",
        skill_category_id: skillCategoryId,
        verification_status: "verified",
        is_online: true,
      },
    });
  });

  afterAll(async () => {
    _setRazorpayInstanceForTesting(null);
    await prisma.review.deleteMany({ where: { booking_id: bookingId } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_id: bookingId } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: bookingId } }).catch(() => {});
    await prisma.job_requirement.deleteMany({ where: { id: requirementId } }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: jobId } }).catch(() => {});
    await prisma.worker.deleteMany({ where: { id: workerId } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { id: customerId } }).catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Inject mock Razorpay instance in beforeEach because jest resets mocks
    _setRazorpayInstanceForTesting({
      orders: {
        create: async (params: any) => ({
          id: `order_test_${Date.now()}`,
          amount: params.amount,
          currency: params.currency,
          status: "created",
          receipt: params.receipt,
        }),
        fetch: async () => ({ id: "order_123", amount: 50000, currency: "INR", status: "paid" }),
      },
      payments: {
        refund: async (paymentId: string, params: any) => ({
          id: `rfnd_test_${Date.now()}`,
          payment_id: paymentId,
          amount: params.amount || 50000,
          currency: "INR",
          status: "processed",
        }),
        fetch: async () => ({ id: "pay_123", order_id: "order_123", amount: 50000, currency: "INR", status: "captured" }),
      },
    } as any);

    await prisma.payment.deleteMany({ where: { booking_id: bookingId } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: bookingId } }).catch(() => {});
    await prisma.job_requirement.deleteMany({ where: { id: requirementId } }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: jobId } }).catch(() => {});

    await prisma.job.create({
      data: { id: jobId, customer_id: customerId, status: "OPEN" },
    });

    await prisma.job_requirement.create({
      data: {
        id: requirementId,
        job_id: jobId,
        skill_id: skillCategoryId,
        skill_type: "PaymentTestSkill",
        worker_count_needed: 1,
        rate_per_day: 750, // 750 rupees -> 75000 paise
        status: "OPEN",
      },
    });

    await prisma.booking.create({
      data: {
        id: bookingId,
        job_id: jobId,
        requirement_id: requirementId,
        worker_id: workerId,
        customer_id: customerId,
        status: "CONFIRMED",
      },
    });
  });

  describe("1. Issue 61 — Server-Derived Payment Amount", () => {
    it("strictly calculates payable amount from rate_per_day (750 * 100 = 75000 paise)", async () => {
      const order = await createOrder(bookingId, customerId);

      expect(order).toBeDefined();
      expect(order.amount).toBe(75000);
      expect(order.currency).toBe("INR");
      expect(order.status).toBe(PaymentStatus.PENDING);
      expect(order.razorpayOrderId).toMatch(/^order_/);

      // Verify persisted state in PostgreSQL
      const persisted = await prisma.payment.findUnique({
        where: { booking_id: bookingId },
      });
      expect(persisted).toBeDefined();
      expect(persisted?.amount).toBe(75000);
      expect(persisted?.currency).toBe("INR");
      expect(persisted?.status).toBe(PaymentStatus.PENDING);
    });

    it("rejects order creation if rate_per_day is missing or zero", async () => {
      await prisma.job_requirement.update({
        where: { id: requirementId },
        data: { rate_per_day: 0 },
      });

      await expect(createOrder(bookingId, customerId)).rejects.toThrow(
        /does not have a valid rate/
      );
    });
  });

  describe("2. Issue 62 — Real Razorpay Order Lifecycle & Idempotency", () => {
    it("returns existing pending order idempotently without creating duplicate provider orders", async () => {
      const firstOrder = await createOrder(bookingId, customerId);
      const secondOrder = await createOrder(bookingId, customerId);

      expect(secondOrder.paymentId).toBe(firstOrder.paymentId);
      expect(secondOrder.razorpayOrderId).toBe(firstOrder.razorpayOrderId);
      expect(secondOrder.amount).toBe(firstOrder.amount);

      const count = await prisma.payment.count({
        where: { booking_id: bookingId },
      });
      expect(count).toBe(1);
    });
  });

  describe("3. Issue 68 — Payment State Machine Guardrails", () => {
    it("permits legal transitions: PENDING -> COMPLETED and COMPLETED -> REFUND_PENDING", async () => {
      const order = await createOrder(bookingId, customerId);

      // Transition PENDING -> COMPLETED
      await prisma.$transaction(async (tx) => {
        const ok = await transitionPaymentStatus(
          tx,
          order.paymentId,
          PaymentStatus.PENDING,
          PaymentStatus.COMPLETED
        );
        expect(ok).toBe(true);
      });

      const completed = await prisma.payment.findUnique({ where: { id: order.paymentId } });
      expect(completed?.status).toBe(PaymentStatus.COMPLETED);

      // Transition COMPLETED -> REFUND_PENDING
      await prisma.$transaction(async (tx) => {
        const ok = await transitionPaymentStatus(
          tx,
          order.paymentId,
          PaymentStatus.COMPLETED,
          PaymentStatus.REFUND_PENDING
        );
        expect(ok).toBe(true);
      });

      const refundPending = await prisma.payment.findUnique({ where: { id: order.paymentId } });
      expect(refundPending?.status).toBe(PaymentStatus.REFUND_PENDING);
    });

    it("strictly blocks illegal transitions such as COMPLETED -> FAILED", async () => {
      const order = await createOrder(bookingId, customerId);

      // Move to COMPLETED
      await prisma.payment.update({
        where: { id: order.paymentId },
        data: { status: PaymentStatus.COMPLETED },
      });

      // Attempt illegal COMPLETED -> FAILED
      await expect(
        prisma.$transaction(async (tx) => {
          await transitionPaymentStatus(
            tx,
            order.paymentId,
            PaymentStatus.COMPLETED,
            PaymentStatus.FAILED
          );
        })
      ).rejects.toThrow(/Illegal payment state transition/);
    });
  });
});
