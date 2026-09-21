/**
 * Issue 70 - Real Webhook Concurrency & Replay Tests
 *
 * Verifies under real PostgreSQL concurrency:
 * 1. 10 genuinely concurrent identical webhook deliveries via Promise.all.
 * 2. Database uniqueness constraint prevents duplicate PaymentWebhookEvent rows.
 * 3. Exactly one logical payment transition occurs (PENDING -> COMPLETED).
 * 4. Zero deadlocks or uncaught exceptions.
 * 5. Replay after PROCESSED returns a clean idempotent success response.
 */

import crypto from "crypto";
import prisma from "../src/config/prisma";
import {
  handleWebhook,
  PaymentStatus,
} from "../src/features/payment/paymentServices";

describe("Issue 70 - Real PostgreSQL Webhook Concurrency & Replay", () => {
  jest.setTimeout(30000);

  const testSecret = "concurrency_test_webhook_secret_32_chars!";
  const customerId = "00000000-0000-4012-a000-000000000001";
  const workerId = "00000000-0000-4012-b000-000000000001";
  const jobId = "00000000-0000-4012-c000-000000000001";
  const requirementId = "00000000-0000-4012-d000-000000000001";
  const bookingId = "00000000-0000-4012-e000-000000000001";
  const orderId = "order_concurrency_test_001";
  const paymentId = "00000000-0000-4012-f000-000000000001";
  let skillCategoryId: string;

  beforeAll(async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = testSecret;

    // Clean test records
    await prisma.paymentWebhookEvent.deleteMany({ where: { provider: "razorpay" } }).catch(() => {});
    await prisma.review.deleteMany({ where: { booking_id: bookingId } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { id: paymentId } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: bookingId } }).catch(() => {});
    await prisma.job_requirement.deleteMany({ where: { id: requirementId } }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: jobId } }).catch(() => {});
    await prisma.worker.deleteMany({ where: { id: workerId } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { id: customerId } }).catch(() => {});

    let category = await prisma.skill_category.findFirst({ where: { name: "ConcurrencyTestSkill" } });
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "ConcurrencyTestSkill", is_active: true },
      });
    }
    skillCategoryId = category.id;

    await prisma.customer.create({
      data: { id: customerId, phone: "+919995000001", name: "Concurrency Customer", password: "hash" },
    });

    await prisma.worker.create({
      data: {
        id: workerId,
        phone: "+919995000002",
        name: "Concurrency Worker",
        password: "hash",
        skill_type: "ConcurrencyTestSkill",
        skill_category_id: skillCategoryId,
        verification_status: "verified",
        is_online: true,
      },
    });
  });

  afterAll(async () => {
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
    await prisma.paymentWebhookEvent.deleteMany({ where: { provider: "razorpay" } }).catch(() => {});
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
        skill_type: "ConcurrencyTestSkill",
        worker_count_needed: 1,
        rate_per_day: 950,
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
        razorpay_order_id: orderId,
        amount: 95000, // 95000 paise
        currency: "INR",
        status: PaymentStatus.PENDING,
        idempotency_key: bookingId,
      },
    });
  });

  function signPayload(rawBody: string, secret: string): string {
    return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  }

  it("handles 10 concurrent identical webhook deliveries with exactly 1 DB record and 1 transition", async () => {
    const paymentEntityId = "pay_concurrency_captured_999";
    const payload = JSON.stringify({
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: paymentEntityId,
            order_id: orderId,
            amount: 95000,
            currency: "INR",
            status: "captured",
          },
        },
      },
    });

    const signature = signPayload(payload, testSecret);

    // Launch 10 concurrent webhook requests
    const concurrencyCount = 10;
    const promises = Array.from({ length: concurrencyCount }, () =>
      handleWebhook(payload, signature)
    );

    const results = await Promise.all(promises);

    // All requests must succeed provider-facingly (200 OK semantics)
    for (const res of results) {
      expect(res.success).toBe(true);
    }

    // Invariant 1: Exactly ONE PaymentWebhookEvent record persisted
    const eventRows = await prisma.paymentWebhookEvent.findMany({
      where: { providerEventId: paymentEntityId },
    });
    expect(eventRows.length).toBe(1);
    expect(eventRows[0].status).toBe("PROCESSED");

    // Invariant 2: Payment state transitioned to COMPLETED
    const finalPayment = await prisma.payment.findUnique({
      where: { id: paymentId },
    });
    expect(finalPayment?.status).toBe(PaymentStatus.COMPLETED);
    expect(finalPayment?.razorpay_payment_id).toBe(paymentEntityId);
  });

  it("safely handles replay of an already PROCESSED webhook event", async () => {
    const paymentEntityId = "pay_replay_test_888";
    const payload = JSON.stringify({
      event: "payment.captured",
      payload: {
        payment: {
          entity: {
            id: paymentEntityId,
            order_id: orderId,
            amount: 95000,
            currency: "INR",
            status: "captured",
          },
        },
      },
    });

    const signature = signPayload(payload, testSecret);

    // First request
    const firstRes = await handleWebhook(payload, signature);
    expect(firstRes.success).toBe(true);

    // Replayed request
    const replayRes = await handleWebhook(payload, signature);
    expect(replayRes.success).toBe(true);
    expect(replayRes.message).toContain("already processed");

    const eventRows = await prisma.paymentWebhookEvent.findMany({
      where: { providerEventId: paymentEntityId },
    });
    expect(eventRows.length).toBe(1);
  });
});
