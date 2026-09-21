/**
 * P3 Issue 5 — Payment Order Creation Concurrency & Distributed Idempotency Tests
 *
 * Requirements:
 * 1. 50 concurrent createOrder requests against real PostgreSQL produce EXACTLY ONE provider call
 *    and EXACTLY ONE local payment record.
 * 2. All 50 concurrent requests resolve to the identical canonical payment order.
 * 3. Sequential retries return the existing pending order without duplicate provider calls.
 * 4. Provider failure transitions local intent to FAILED, allowing clean subsequent retry.
 * 5. Amount and currency are strictly server-derived.
 * 6. Cross-customer access is denied (403).
 */

import prisma from "../src/config/prisma";
import {
  createOrder,
  PaymentStatus,
} from "../src/features/payment/paymentServices";
import { _setRazorpayInstanceForTesting } from "../src/providers/razorpay/razorpayProvider";

describe("P3 Issue 5 — Payment Order Creation Real PostgreSQL Concurrency", () => {
  jest.setTimeout(45000);

  const customerA = "00000000-0000-4009-a000-000000000001";
  const customerB = "00000000-0000-4009-a000-000000000002";
  const workerId = "00000000-0000-4009-b000-000000000001";
  const jobId = "00000000-0000-4009-c000-000000000001";
  const requirementId = "00000000-0000-4009-d000-000000000001";
  const bookingId = "00000000-0000-4009-e000-000000000001";
  let skillCategoryId: string;
  let providerCreateCount = 0;

  beforeAll(async () => {
    // Clean any prior state
    await prisma.review.deleteMany({ where: { booking_id: bookingId } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { booking_id: bookingId } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: bookingId } }).catch(() => {});
    await prisma.job_requirement.deleteMany({ where: { id: requirementId } }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: jobId } }).catch(() => {});
    await prisma.worker.deleteMany({ where: { id: workerId } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { id: { in: [customerA, customerB] } } }).catch(() => {});

    let category = await prisma.skill_category.findFirst({ where: { name: "ConcurrencyPaymentSkill" } });
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "ConcurrencyPaymentSkill", is_active: true },
      });
    }
    skillCategoryId = category.id;

    await prisma.customer.create({
      data: { id: customerA, phone: "+919998000011", name: "Customer A", password: "hash" },
    });
    await prisma.customer.create({
      data: { id: customerB, phone: "+919998000012", name: "Customer B", password: "hash" },
    });

    await prisma.worker.create({
      data: {
        id: workerId,
        phone: "+919998000013",
        name: "Worker 1",
        password: "hash",
        skill_type: "ConcurrencyPaymentSkill",
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
    await prisma.customer.deleteMany({ where: { id: { in: [customerA, customerB] } } }).catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    providerCreateCount = 0;

    _setRazorpayInstanceForTesting({
      orders: {
        create: async (params: any) => {
          providerCreateCount++;
          // Simulate slight network latency (20ms) to ensure race condition occurs in callers
          await new Promise((res) => setTimeout(res, 20));
          return {
            id: `order_concurrent_${Date.now()}`,
            amount: params.amount,
            currency: params.currency,
            status: "created",
            receipt: params.receipt,
          };
        },
        fetch: async () => ({ id: "order_123", amount: 80000, currency: "INR", status: "paid" }),
      },
    } as any);

    await prisma.payment.deleteMany({ where: { booking_id: bookingId } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: bookingId } }).catch(() => {});
    await prisma.job_requirement.deleteMany({ where: { id: requirementId } }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: jobId } }).catch(() => {});

    await prisma.job.create({
      data: { id: jobId, customer_id: customerA, status: "OPEN" },
    });

    await prisma.job_requirement.create({
      data: {
        id: requirementId,
        job_id: jobId,
        skill_id: skillCategoryId,
        skill_type: "ConcurrencyPaymentSkill",
        worker_count_needed: 1,
        rate_per_day: 800, // 800 rupees -> 80000 paise
        status: "OPEN",
      },
    });

    await prisma.booking.create({
      data: {
        id: bookingId,
        job_id: jobId,
        requirement_id: requirementId,
        worker_id: workerId,
        customer_id: customerA,
        status: "CONFIRMED",
      },
    });
  });

  describe("1. Real PostgreSQL 50-Request Concurrency Test", () => {
    it("50 simultaneous requests produce EXACTLY 1 local payment intent and EXACTLY 1 provider call", async () => {
      const CONCURRENCY = 50;

      // Launch 50 simultaneous createOrder requests
      const promises = Array.from({ length: CONCURRENCY }, () =>
        createOrder(bookingId, customerA)
      );

      const results = await Promise.all(promises);

      // Invariant 1: Exactly 50 successful results
      expect(results).toHaveLength(CONCURRENCY);

      // Invariant 2: Exactly ONE provider order creation call occurred
      expect(providerCreateCount).toBe(1);

      // Invariant 3: All 50 responses share the exact same paymentId and razorpayOrderId
      const canonicalPaymentId = results[0].paymentId;
      const canonicalOrderId = results[0].razorpayOrderId;

      for (const res of results) {
        expect(res.paymentId).toBe(canonicalPaymentId);
        expect(res.razorpayOrderId).toBe(canonicalOrderId);
        expect(res.amount).toBe(80000);
        expect(res.currency).toBe("INR");
        expect(res.status).toBe(PaymentStatus.PENDING);
      }

      // Invariant 4: Exactly ONE record in PostgreSQL payment table
      const paymentCount = await prisma.payment.count({
        where: { booking_id: bookingId },
      });
      expect(paymentCount).toBe(1);

      const dbPayment = await prisma.payment.findUnique({
        where: { booking_id: bookingId },
      });
      expect(dbPayment?.id).toBe(canonicalPaymentId);
      expect(dbPayment?.razorpay_order_id).toBe(canonicalOrderId);
      expect(dbPayment?.amount).toBe(80000);
      expect(dbPayment?.currency).toBe("INR");
    });
  });

  describe("2. Sequential Retries & Idempotency", () => {
    it("Sequential retry returns existing order with ZERO additional provider calls", async () => {
      const first = await createOrder(bookingId, customerA);
      expect(providerCreateCount).toBe(1);

      const second = await createOrder(bookingId, customerA);
      expect(providerCreateCount).toBe(1); // No new provider call

      const third = await createOrder(bookingId, customerA);
      expect(providerCreateCount).toBe(1); // Still 1

      expect(second.razorpayOrderId).toBe(first.razorpayOrderId);
      expect(third.razorpayOrderId).toBe(first.razorpayOrderId);
    });
  });

  describe("3. Provider Failure & Subsequent Retry Recovery", () => {
    it("Failed provider call transitions local intent to FAILED and subsequent retry succeeds", async () => {
      // Configure mock to fail on first attempt
      let failFirst = true;
      _setRazorpayInstanceForTesting({
        orders: {
          create: async () => {
            if (failFirst) {
              failFirst = false;
              throw new Error("Razorpay gateway temporary 502 timeout");
            }
            return {
              id: "order_recovered_123",
              amount: 80000,
              currency: "INR",
              status: "created",
            };
          },
        },
      } as any);

      // Attempt 1: Fails
      await expect(createOrder(bookingId, customerA)).rejects.toThrow();

      // Verify DB record is in FAILED status
      const failedPayment = await prisma.payment.findUnique({
        where: { booking_id: bookingId },
      });
      expect(failedPayment).toBeDefined();
      expect(failedPayment?.status).toBe(PaymentStatus.FAILED);
      expect(failedPayment?.razorpay_order_id).toBeNull();

      // Attempt 2: Retry succeeds and claims the failed record
      const recovered = await createOrder(bookingId, customerA);
      expect(recovered.razorpayOrderId).toBe("order_recovered_123");
      expect(recovered.status).toBe(PaymentStatus.PENDING);

      // Verify DB record is now PENDING with provider order ID
      const activePayment = await prisma.payment.findUnique({
        where: { booking_id: bookingId },
      });
      expect(activePayment?.status).toBe(PaymentStatus.PENDING);
      expect(activePayment?.razorpay_order_id).toBe("order_recovered_123");

      // Verify total count is still 1
      const count = await prisma.payment.count({
        where: { booking_id: bookingId },
      });
      expect(count).toBe(1);
    });
  });

  describe("4. Security & Authorization Matrix", () => {
    it("Customer B cannot create order for Customer A's booking (403)", async () => {
      await expect(createOrder(bookingId, customerB)).rejects.toThrow(
        /Booking not found or you do not have permission/
      );

      const count = await prisma.payment.count({
        where: { booking_id: bookingId },
      });
      expect(count).toBe(0);
    });

    it("Order creation is rejected if booking is in non-payable state", async () => {
      await prisma.booking.update({
        where: { id: bookingId },
        data: { status: "COMPLETED" },
      });

      await expect(createOrder(bookingId, customerA)).rejects.toThrow(
        /Booking is not in a payable state/
      );
    });
  });
});
