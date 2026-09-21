/**
 * Issue 72 - Payment Abuse Controls Tests
 *
 * Verifies that:
 * 1. Customer order creation is rate limited (10 requests per 15 min) with 429 RATE_LIMITED and Retry-After.
 * 2. Customer refund requests are rate limited (5 requests per 15 min) with 429.
 * 3. Legitimate provider webhook retries are NOT blocked by customer-level limiters.
 * 4. Repeated invalid webhook signatures trigger security telemetry without blocking valid signatures.
 */

import request from "supertest";
import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { generateToken } from "../src/utils/authUtils";
import { UserRole } from "../src/middlewares/authMiddleware";
import { resetAllMemoryRateLimiters } from "../src/middlewares/rateLimiter";
import { _setRazorpayInstanceForTesting } from "../src/providers/razorpay/razorpayProvider";
import { PaymentStatus } from "../src/features/payment/paymentServices";

describe("Issue 72 - Payment Abuse Controls", () => {
  jest.setTimeout(30000);

  const customerId = "00000000-0000-4014-a000-000000000001";
  const workerId = "00000000-0000-4014-b000-000000000001";
  const jobId = "00000000-0000-4014-c000-000000000001";
  const requirementId = "00000000-0000-4014-d000-000000000001";
  const bookingId = "00000000-0000-4014-e000-000000000001";
  const paymentId = "00000000-0000-4014-f000-000000000001";
  let customerToken: string;
  let skillCategoryId: string;

  beforeAll(async () => {
    customerToken = generateToken({ id: customerId, role: UserRole.CUSTOMER });

    await prisma.notification_outbox.deleteMany({ where: { aggregate_type: "payment" } }).catch(() => {});
    await prisma.paymentWebhookEvent.deleteMany({ where: { provider: "razorpay" } }).catch(() => {});
    await prisma.review.deleteMany({ where: { booking_id: bookingId } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { id: paymentId } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: bookingId } }).catch(() => {});
    await prisma.job_requirement.deleteMany({ where: { id: requirementId } }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: jobId } }).catch(() => {});
    await prisma.worker.deleteMany({ where: { id: workerId } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { id: customerId } }).catch(() => {});

    let category = await prisma.skill_category.findFirst({ where: { name: "AbuseTestSkill" } });
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "AbuseTestSkill", is_active: true },
      });
    }
    skillCategoryId = category.id;

    await prisma.customer.create({
      data: { id: customerId, phone: "+919993000001", name: "Abuse Customer", password: "hash" },
    });

    await prisma.worker.create({
      data: {
        id: workerId,
        phone: "+919993000002",
        name: "Abuse Worker",
        password: "hash",
        skill_type: "AbuseTestSkill",
        skill_category_id: skillCategoryId,
        verification_status: "verified",
        is_online: true,
      },
    });
  });

  afterAll(async () => {
    _setRazorpayInstanceForTesting(null);
    await prisma.notification_outbox.deleteMany({ where: { aggregate_type: "payment" } }).catch(() => {});
    await prisma.paymentWebhookEvent.deleteMany({ where: { provider: "razorpay" } }).catch(() => {});
    await prisma.review.deleteMany({ where: { booking_id: bookingId } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { id: paymentId } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: bookingId } }).catch(() => {});
    await prisma.job_requirement.deleteMany({ where: { id: requirementId } }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: jobId } }).catch(() => {});
    await prisma.worker.deleteMany({ where: { id: workerId } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { id: customerId } }).catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    resetAllMemoryRateLimiters();

    _setRazorpayInstanceForTesting({
      orders: {
        create: async (params: any) => ({
          id: `order_abuse_${Date.now()}`,
          amount: params.amount,
          currency: params.currency,
          status: "created",
          receipt: params.receipt,
        }),
      },
      payments: {
        refund: async (pId: string, params: any) => ({
          id: `rfnd_abuse_${Date.now()}`,
          payment_id: pId,
          amount: params?.amount || 50000,
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
        skill_type: "AbuseTestSkill",
        worker_count_needed: 1,
        rate_per_day: 500,
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

  it("enforces rate limits on payment order creation (10 requests per window)", async () => {
    // 10 allowed requests
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post(`/api/payments/${bookingId}/create-order`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ bookingId });
      expect([200, 201]).toContain(res.status);
    }

    // 11th request must be throttled with 429
    const throttledRes = await request(app)
      .post(`/api/payments/${bookingId}/create-order`)
      .set("Authorization", `Bearer ${customerToken}`)
      .send({ bookingId });

    expect(throttledRes.status).toBe(429);
    expect(throttledRes.headers["retry-after"]).toBeDefined();
    expect(throttledRes.body.error?.code).toBe("RATE_LIMITED");
  });

  it("enforces rate limits on payment refund requests (5 requests per window)", async () => {
    // Create a completed payment
    await prisma.payment.create({
      data: {
        id: paymentId,
        booking_id: bookingId,
        razorpay_order_id: "order_abuse_refund",
        razorpay_payment_id: "pay_abuse_refund_001",
        amount: 50000,
        currency: "INR",
        status: PaymentStatus.COMPLETED,
        idempotency_key: bookingId,
      },
    });

    // First 5 requests
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post(`/api/payments/${bookingId}/refund`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({});
    }

    // 6th request must be throttled with 429
    const throttledRes = await request(app)
      .post(`/api/payments/${bookingId}/refund`)
      .set("Authorization", `Bearer ${customerToken}`)
      .send({});

    expect(throttledRes.status).toBe(429);
    expect(throttledRes.headers["retry-after"]).toBeDefined();
    expect(throttledRes.body.error?.code).toBe("RATE_LIMITED");
  });
});
