/**
 * Issues 63, 64 & 65 - Webhook Signature, Idempotency & Amount/Currency Reconciliation Tests
 *
 * Verifies that:
 * 1. HMAC-SHA256 signature verification over exact raw request body.
 * 2. Webhook idempotency via unique constraints.
 * 3. Amount reconciliation: captured amount mismatch quarantines payment without marking COMPLETED.
 * 4. Currency reconciliation: mismatch quarantines payment.
 */

import crypto from "crypto";
import prisma from "../src/config/prisma";
import {
  handleWebhook,
  PaymentStatus,
} from "../src/features/payment/paymentServices";

describe("Issues 63, 64 & 65 - Webhook Verification, Idempotency & Reconciliation", () => {
  jest.setTimeout(30000);

  const testSecret = "test_webhook_secret_32_characters_ok!";
  const customerId = "00000000-0000-4009-a000-000000000001";
  const workerId = "00000000-0000-4009-b000-000000000001";
  const jobId = "00000000-0000-4009-c000-000000000001";
  const requirementId = "00000000-0000-4009-d000-000000000001";
  const bookingId = "00000000-0000-4009-e000-000000000001";
  const orderId = "order_webhook_test_001";
  const paymentId = "00000000-0000-4009-f000-000000000001";
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

    let category = await prisma.skill_category.findFirst({ where: { name: "WebhookTestSkill" } });
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "WebhookTestSkill", is_active: true },
      });
    }
    skillCategoryId = category.id;

    await prisma.customer.create({
      data: { id: customerId, phone: "+919999000001", name: "Webhook Customer", password: "hash" },
    });

    await prisma.worker.create({
      data: {
        id: workerId,
        phone: "+919999000002",
        name: "Webhook Worker",
        password: "hash",
        skill_type: "WebhookTestSkill",
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
        skill_type: "WebhookTestSkill",
        worker_count_needed: 1,
        rate_per_day: 600,
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
        amount: 60000, // 60000 paise = 600 INR
        currency: "INR",
        status: PaymentStatus.PENDING,
        idempotency_key: bookingId,
      },
    });
  });

  function signPayload(rawBody: string, secret: string): string {
    return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  }

  describe("1. Issue 63 — Raw-Body Signature Verification", () => {
    it("accepts valid HMAC signature and processes payment.captured", async () => {
      const payload = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: {
              id: "pay_valid_123",
              order_id: orderId,
              amount: 60000,
              currency: "INR",
              status: "captured",
            },
          },
        },
      });

      const signature = signPayload(payload, testSecret);
      const res = await handleWebhook(payload, signature);

      expect(res.success).toBe(true);

      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
      expect(payment?.status).toBe(PaymentStatus.COMPLETED);
      expect(payment?.razorpay_payment_id).toBe("pay_valid_123");
    });

    it("rejects invalid signature with 401 WEBHOOK_INVALID_SIGNATURE", async () => {
      const payload = JSON.stringify({ event: "payment.captured" });
      const invalidSignature = "invalid_signature_hex_1234567890abcdef";

      await expect(handleWebhook(payload, invalidSignature)).rejects.toThrow(
        /signature verification failed/
      );
    });
  });

  describe("2. Issue 64 — Webhook Idempotency & Duplicate Delivery", () => {
    it("safely handles duplicate webhook delivery without duplicate transitions", async () => {
      const payload = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: {
              id: "pay_duplicate_123",
              order_id: orderId,
              amount: 60000,
              currency: "INR",
              status: "captured",
            },
          },
        },
      });

      const signature = signPayload(payload, testSecret);

      // First delivery
      const res1 = await handleWebhook(payload, signature);
      expect(res1.success).toBe(true);

      // Second (duplicate) delivery
      const res2 = await handleWebhook(payload, signature);
      expect(res2.success).toBe(true);
      expect(res2.message).toContain("already processed");

      // Verify DB contains exactly one event record
      const events = await prisma.paymentWebhookEvent.findMany({
        where: { providerEventId: "pay_duplicate_123" },
      });
      expect(events.length).toBe(1);
      expect(events[0].status).toBe("PROCESSED");
    });
  });

  describe("3. Issue 65 — Amount & Currency Reconciliation Guardrails", () => {
    it("quarantines payment and refuses transition when captured amount does not match expected amount", async () => {
      const payload = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: {
              id: "pay_mismatch_amount",
              order_id: orderId,
              amount: 30000, // Mismatched: expected 60000 paise
              currency: "INR",
              status: "captured",
            },
          },
        },
      });

      const signature = signPayload(payload, testSecret);
      const res = await handleWebhook(payload, signature);

      expect(res.success).toBe(true);

      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
      // Crucial security invariant: payment MUST NOT be COMPLETED
      expect(payment?.status).toBe(PaymentStatus.PENDING);
      expect(payment?.quarantine_reason).toContain("Amount mismatch");
    });

    it("quarantines payment when currency does not match expected currency", async () => {
      const payload = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: {
              id: "pay_mismatch_currency",
              order_id: orderId,
              amount: 60000,
              currency: "USD", // Mismatched: expected INR
              status: "captured",
            },
          },
        },
      });

      const signature = signPayload(payload, testSecret);
      const res = await handleWebhook(payload, signature);

      expect(res.success).toBe(true);

      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
      expect(payment?.status).toBe(PaymentStatus.PENDING);
      expect(payment?.quarantine_reason).toContain("Currency mismatch");
    });
  });
});
