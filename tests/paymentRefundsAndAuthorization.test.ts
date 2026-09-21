/**
 * Issues 66 & 67 - Real Provider Refunds & Authorization Hardening Tests
 *
 * Verifies that:
 * 1. Real provider refund lifecycle: Razorpay refund API invoked, provider refund ID & status persisted.
 * 2. Authorization guards: Only the customer who owns the booking or an ADMIN can initiate refunds.
 *    Workers and unrelated customers are strictly blocked.
 * 3. Lifecycle guards: Only COMPLETED (or retryable REFUND_FAILED) payments can be refunded.
 * 4. Provider failure handling: Provider rejection transitions state to REFUND_FAILED and does NOT mark REFUNDED.
 */

import prisma from "../src/config/prisma";
import {
  refundPayment,
  PaymentStatus,
} from "../src/features/payment/paymentServices";
import { _setRazorpayInstanceForTesting } from "../src/providers/razorpay/razorpayProvider";
import { UserRole } from "../src/policies";

describe("Issues 66 & 67 - Real Provider Refunds & Authorization Hardening", () => {
  jest.setTimeout(30000);

  const customerId = "00000000-0000-4010-a000-000000000001";
  const otherCustomerId = "00000000-0000-4010-a000-000000000002";
  const workerId = "00000000-0000-4010-b000-000000000001";
  const adminId = "00000000-0000-4010-c000-000000000001";
  const jobId = "00000000-0000-4010-d000-000000000001";
  const requirementId = "00000000-0000-4010-e000-000000000001";
  const bookingId = "00000000-0000-4010-f000-000000000001";
  const paymentId = "00000000-0000-4010-9000-000000000001";
  let skillCategoryId: string;

  beforeAll(async () => {
    // Clean test records
    await prisma.review.deleteMany({ where: { booking_id: bookingId } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { id: paymentId } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: bookingId } }).catch(() => {});
    await prisma.job_requirement.deleteMany({ where: { id: requirementId } }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: jobId } }).catch(() => {});
    await prisma.worker.deleteMany({ where: { id: workerId } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { OR: [{ id: { in: [customerId, otherCustomerId] } }, { phone: { in: ["+919997000001", "+919997000002"] } }] } }).catch(() => {});
    await prisma.worker.deleteMany({ where: { OR: [{ id: workerId }, { phone: "+919997000003" }] } }).catch(() => {});

    let category = await prisma.skill_category.findFirst({ where: { name: "RefundTestSkill" } });
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "RefundTestSkill", is_active: true },
      });
    }
    skillCategoryId = category.id;

    await prisma.customer.create({
      data: { id: customerId, phone: "+919997000001", name: "Refund Customer", password: "hash" },
    });

    await prisma.customer.create({
      data: { id: otherCustomerId, phone: "+919997000002", name: "Other Customer", password: "hash" },
    });

    await prisma.worker.create({
      data: {
        id: workerId,
        phone: "+919997000003",
        name: "Refund Worker",
        password: "hash",
        skill_type: "RefundTestSkill",
        skill_category_id: skillCategoryId,
        verification_status: "verified",
        is_online: true,
      },
    });
  });

  afterAll(async () => {
    _setRazorpayInstanceForTesting(null);
    await prisma.review.deleteMany({ where: { booking_id: bookingId } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { id: paymentId } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: bookingId } }).catch(() => {});
    await prisma.job_requirement.deleteMany({ where: { id: requirementId } }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: jobId } }).catch(() => {});
    await prisma.worker.deleteMany({ where: { id: workerId } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { id: { in: [customerId, otherCustomerId] } } }).catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    _setRazorpayInstanceForTesting({
      payments: {
        refund: async (paymentId: string, params: any) => ({
          id: `rfnd_${Date.now()}`,
          payment_id: paymentId,
          amount: params?.amount || 80000,
          currency: "INR",
          status: "processed",
        }),
      },
    } as any);

    await prisma.payment.deleteMany({ where: { id: paymentId } }).catch(() => {});
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
        skill_type: "RefundTestSkill",
        worker_count_needed: 1,
        rate_per_day: 800,
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

    await prisma.payment.create({
      data: {
        id: paymentId,
        booking_id: bookingId,
        razorpay_order_id: "order_refund_test_001",
        razorpay_payment_id: "pay_captured_refund_001",
        amount: 80000, // 80000 paise = 800 INR
        currency: "INR",
        status: PaymentStatus.COMPLETED,
        idempotency_key: bookingId,
      },
    });
  });

  describe("1. Issue 66 — Real Provider Refund Lifecycle", () => {
    it("successfully calls Razorpay refund API and transitions payment to REFUNDED", async () => {
      const actor = { id: customerId, role: UserRole.CUSTOMER, phone: "+919997000001" };

      const res = await refundPayment(bookingId, actor, 80000, "Customer requested cancellation refund");

      expect(res.success).toBe(true);
      expect(res.refundId).toMatch(/^rfnd_/);

      const updated = await prisma.payment.findUnique({ where: { id: paymentId } });
      expect(updated?.status).toBe(PaymentStatus.REFUNDED);
      expect(updated?.razorpay_refund_id).toBe(res.refundId);
      expect(updated?.refund_amount).toBe(80000);
      expect(updated?.refund_status).toBe("processed");
    });

    it("transitions state to REFUND_FAILED on provider error and never marks REFUNDED", async () => {
      _setRazorpayInstanceForTesting({
        payments: {
          refund: async () => {
            const err: any = new Error("Gateway timeout from bank");
            err.statusCode = 504;
            throw err;
          },
        },
      } as any);

      const actor = { id: customerId, role: UserRole.CUSTOMER, phone: "+919997000001" };

      await expect(
        refundPayment(bookingId, actor, 80000, "Testing provider failure")
      ).rejects.toThrow(/Payment refund failed/);

      const updated = await prisma.payment.findUnique({ where: { id: paymentId } });
      expect(updated?.status).toBe(PaymentStatus.REFUND_FAILED);
      expect(updated?.refund_reason).toContain("Gateway timeout");
    });
  });

  describe("2. Issue 67 — Refund Authorization & Lifecycle Guards", () => {
    it("blocks an unrelated customer from requesting a refund (403)", async () => {
      const intruderActor = { id: otherCustomerId, role: UserRole.CUSTOMER, phone: "+919997000002" };

      await expect(
        refundPayment(bookingId, intruderActor, 80000, "Unauthorized attempt")
      ).rejects.toThrow(/do not have permission/);

      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
      expect(payment?.status).toBe(PaymentStatus.COMPLETED);
    });

    it("blocks a worker from requesting a refund (403)", async () => {
      const workerActor = { id: workerId, role: UserRole.WORKER, phone: "+919997000003" };

      await expect(
        refundPayment(bookingId, workerActor, 80000, "Worker attempt")
      ).rejects.toThrow();

      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
      expect(payment?.status).toBe(PaymentStatus.COMPLETED);
    });

    it("permits an ADMIN user to refund a payment", async () => {
      const adminActor = { id: adminId, role: UserRole.ADMIN, phone: "" };

      const res = await refundPayment(bookingId, adminActor, 80000, "Admin approved refund");

      expect(res.success).toBe(true);
      const updated = await prisma.payment.findUnique({ where: { id: paymentId } });
      expect(updated?.status).toBe(PaymentStatus.REFUNDED);
    });

    it("rejects refund attempt when payment is in PENDING state", async () => {
      await prisma.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.PENDING },
      });

      const actor = { id: customerId, role: UserRole.CUSTOMER, phone: "+919997000001" };

      await expect(
        refundPayment(bookingId, actor, 80000, "Early refund")
      ).rejects.toThrow(/payment is in status 'PENDING', not COMPLETED/);
    });
  });
});
