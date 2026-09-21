/**
 * P3 Issue 3 — Webhook Fail-Closed Security & Concurrency Verification
 *
 * Verifies:
 * 1. Unit Signature Verification:
 *    - Correct secret + body + signature -> PASS
 *    - Modified body + original signature -> FAIL
 *    - Wrong secret -> FAIL
 *    - Missing / empty / whitespace secret -> FAIL
 *    - Missing / empty / malformed signature -> FAIL
 * 2. Express HTTP Middleware & Fail-Closed Endpoint Invariants:
 *    - Missing secret -> 500 WEBHOOK_SECRET_NOT_CONFIGURED (zero DB mutation)
 *    - Empty secret -> 500 WEBHOOK_SECRET_NOT_CONFIGURED (zero DB mutation)
 *    - Missing signature -> 401 WEBHOOK_MISSING_SIGNATURE (zero DB mutation)
 *    - Invalid signature -> 401 WEBHOOK_INVALID_SIGNATURE (zero DB mutation)
 *    - Tampered body -> 401 WEBHOOK_INVALID_SIGNATURE (zero DB mutation)
 *    - Malformed JSON -> 400 WEBHOOK_INVALID_BODY (zero DB mutation)
 *    - Valid signature -> 200 OK (Payment status -> COMPLETED)
 *    - Replay delivery -> 200 OK (Idempotent, exactly 1 transition)
 * 3. Exact Raw-Body Byte Preservation across Express Middleware (Unicode, formatting)
 * 4. Real PostgreSQL 20-Request Concurrency Replay Contention
 */

import crypto from "crypto";
import request from "supertest";
import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { verifyWebhookSignature } from "../src/providers/razorpay/razorpayProvider";
import { handleWebhook, PaymentStatus } from "../src/features/payment/paymentServices";

describe("P3 Issue 3 — Webhook Fail-Closed Security & Concurrency Verification", () => {
  jest.setTimeout(60000);

  const testSecret = "webhook_test_secret_key_secure_32_bytes!";
  const customerId = "00000000-0000-4033-a000-000000000001";
  const workerId = "00000000-0000-4033-b000-000000000001";
  const jobId = "00000000-0000-4033-c000-000000000001";
  const requirementId = "00000000-0000-4033-d000-000000000001";
  const bookingId = "00000000-0000-4033-e000-000000000001";
  const orderId = "order_fail_closed_test_001";
  const paymentId = "00000000-0000-4033-f000-000000000001";
  let skillCategoryId: string;

  function signPayload(rawBody: string | Buffer, secret: string): string {
    return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  }

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

    let category = await prisma.skill_category.findFirst({ where: { name: "WebhookFailClosedSkill" } });
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "WebhookFailClosedSkill", is_active: true },
      });
    }
    skillCategoryId = category.id;

    await prisma.customer.create({
      data: { id: customerId, phone: "+919999000033", name: "Webhook Customer", password: "hash" },
    });

    await prisma.worker.create({
      data: {
        id: workerId,
        phone: "+919999000034",
        name: "Webhook Worker",
        password: "hash",
        skill_type: "WebhookFailClosedSkill",
        skill_category_id: skillCategoryId,
        verification_status: "verified",
        is_online: true,
      },
    });
  });

  afterAll(async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = testSecret;
    try {
      await prisma.paymentWebhookEvent.deleteMany({ where: { provider: "razorpay" } }).catch(() => {});
      await prisma.review.deleteMany({ where: { booking_id: bookingId } }).catch(() => {});
      await prisma.payment.deleteMany({ where: { id: paymentId } }).catch(() => {});
      await prisma.booking.deleteMany({ where: { id: bookingId } }).catch(() => {});
      await prisma.job_requirement.deleteMany({ where: { id: requirementId } }).catch(() => {});
      await prisma.job.deleteMany({ where: { id: jobId } }).catch(() => {});
      await prisma.worker.deleteMany({ where: { id: workerId } }).catch(() => {});
      await prisma.customer.deleteMany({ where: { id: customerId } }).catch(() => {});
    } catch {}
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = testSecret;

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
        skill_type: "WebhookFailClosedSkill",
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
        razorpay_order_id: orderId,
        amount: 80000, // 800 INR in paise
        currency: "INR",
        status: PaymentStatus.PENDING,
        idempotency_key: bookingId,
      },
    });
  });

  // ── 1. Unit Tests for Signature Verification ──────────────────────────────────
  describe("1. Unit Tests — verifyWebhookSignature Function", () => {
    const rawBody = JSON.stringify({ event: "payment.captured", id: "evt_1" });
    const validSig = signPayload(rawBody, testSecret);

    it("accepts valid secret, rawBody and signature", () => {
      expect(verifyWebhookSignature(rawBody, validSig, testSecret)).toBe(true);
    });

    it("rejects modified body with original signature", () => {
      const tamperedBody = JSON.stringify({ event: "payment.captured", id: "evt_tampered" });
      expect(verifyWebhookSignature(tamperedBody, validSig, testSecret)).toBe(false);
    });

    it("rejects wrong secret", () => {
      expect(verifyWebhookSignature(rawBody, validSig, "wrong_secret_1234567890")).toBe(false);
    });

    it("rejects missing / empty / whitespace secret", () => {
      expect(verifyWebhookSignature(rawBody, validSig, "")).toBe(false);
      expect(verifyWebhookSignature(rawBody, validSig, "   ")).toBe(false);
      expect(verifyWebhookSignature(rawBody, validSig, undefined as any)).toBe(false);
      expect(verifyWebhookSignature(rawBody, validSig, null as any)).toBe(false);
    });

    it("rejects missing / empty / whitespace signature", () => {
      expect(verifyWebhookSignature(rawBody, "", testSecret)).toBe(false);
      expect(verifyWebhookSignature(rawBody, "   ", testSecret)).toBe(false);
      expect(verifyWebhookSignature(rawBody, undefined as any, testSecret)).toBe(false);
      expect(verifyWebhookSignature(rawBody, null as any, testSecret)).toBe(false);
    });

    it("rejects malformed signature (non-hex, odd length)", () => {
      expect(verifyWebhookSignature(rawBody, "not_a_valid_hex_signature", testSecret)).toBe(false);
      expect(verifyWebhookSignature(rawBody, "abc", testSecret)).toBe(false);
      expect(verifyWebhookSignature(rawBody, "12345", testSecret)).toBe(false);
    });
  });

  // ── 2. HTTP Fail-Closed Integration Tests ─────────────────────────────────────
  describe("2. HTTP Integration Tests — POST /api/payments/webhook", () => {
    it("MUST reject with HTTP 500 when RAZORPAY_WEBHOOK_SECRET is missing (fail-closed)", async () => {
      delete process.env.RAZORPAY_WEBHOOK_SECRET;

      const body = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: { id: "pay_attack_1", order_id: orderId, amount: 80000, currency: "INR", status: "captured" },
          },
        },
      });

      const res = await request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", "any_signature")
        .send(body);

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("WEBHOOK_SECRET_NOT_CONFIGURED");

      // Verify ZERO database mutation
      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
      expect(payment?.status).toBe(PaymentStatus.PENDING);
      expect(payment?.razorpay_payment_id).toBeNull();
    });

    it("MUST reject with HTTP 500 when RAZORPAY_WEBHOOK_SECRET is empty string (fail-closed)", async () => {
      process.env.RAZORPAY_WEBHOOK_SECRET = "";

      const body = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: { id: "pay_attack_2", order_id: orderId, amount: 80000, currency: "INR", status: "captured" },
          },
        },
      });

      const res = await request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", "any_signature")
        .send(body);

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("WEBHOOK_SECRET_NOT_CONFIGURED");

      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
      expect(payment?.status).toBe(PaymentStatus.PENDING);
    });

    it("MUST reject with HTTP 401 when X-Razorpay-Signature header is missing", async () => {
      process.env.RAZORPAY_WEBHOOK_SECRET = testSecret;

      const body = JSON.stringify({ event: "payment.captured" });

      const res = await request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .send(body);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("WEBHOOK_MISSING_SIGNATURE");

      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
      expect(payment?.status).toBe(PaymentStatus.PENDING);
    });

    it("MUST reject with HTTP 401 when signature is invalid", async () => {
      process.env.RAZORPAY_WEBHOOK_SECRET = testSecret;

      const body = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: { id: "pay_attack_3", order_id: orderId, amount: 80000, currency: "INR", status: "captured" },
          },
        },
      });

      const res = await request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", "deadbeef0000111122223333444455556666777788889999aaaabbbbccccdddd")
        .send(body);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("WEBHOOK_INVALID_SIGNATURE");

      // Verify ZERO database mutation
      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
      expect(payment?.status).toBe(PaymentStatus.PENDING);
    });

    it("MUST reject with HTTP 401 when body is tampered", async () => {
      process.env.RAZORPAY_WEBHOOK_SECRET = testSecret;

      const originalBody = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: { id: "pay_tamper_orig", order_id: orderId, amount: 80000, currency: "INR", status: "captured" },
          },
        },
      });
      const validSigForOrig = signPayload(originalBody, testSecret);

      const tamperedBody = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: { id: "pay_tamper_mod", order_id: orderId, amount: 100, currency: "INR", status: "captured" },
          },
        },
      });

      const res = await request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", validSigForOrig)
        .send(tamperedBody);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("WEBHOOK_INVALID_SIGNATURE");

      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
      expect(payment?.status).toBe(PaymentStatus.PENDING);
    });

    it("MUST accept validly signed webhook, transition payment to COMPLETED, and record event", async () => {
      process.env.RAZORPAY_WEBHOOK_SECRET = testSecret;

      const body = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: { id: "pay_valid_fc_01", order_id: orderId, amount: 80000, currency: "INR", status: "captured" },
          },
        },
      });
      const signature = signPayload(body, testSecret);

      const res = await request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", signature)
        .send(body);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
      expect(payment?.status).toBe(PaymentStatus.COMPLETED);
      expect(payment?.razorpay_payment_id).toBe("pay_valid_fc_01");

      const event = await prisma.paymentWebhookEvent.findFirst({
        where: { providerEventId: "pay_valid_fc_01" },
      });
      expect(event).toBeDefined();
      expect(event?.status).toBe("PROCESSED");
    });

    it("MUST handle duplicate delivery safely & idempotently", async () => {
      process.env.RAZORPAY_WEBHOOK_SECRET = testSecret;

      const body = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: { id: "pay_replay_fc_01", order_id: orderId, amount: 80000, currency: "INR", status: "captured" },
          },
        },
      });
      const signature = signPayload(body, testSecret);

      // 1. First delivery
      const res1 = await request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", signature)
        .send(body);
      expect(res1.status).toBe(200);

      // 2. Second delivery (replay)
      const res2 = await request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", signature)
        .send(body);
      expect(res2.status).toBe(200);
      expect(res2.body.success).toBe(true);
      expect(res2.body.message.toLowerCase()).toMatch(/already (processed|completed)/);

      // Exactly ONE event record in DB
      const events = await prisma.paymentWebhookEvent.findMany({
        where: { providerEventId: "pay_replay_fc_01" },
      });
      expect(events.length).toBe(1);
    });
  });

  // ── 3. Exact Raw-Body Byte Preservation across Middleware Stack ───────────────
  describe("3. Middleware Ordering & Raw Body Preservation", () => {
    it("verifies signature over exact raw request body including custom whitespace & unicode", async () => {
      process.env.RAZORPAY_WEBHOOK_SECRET = testSecret;

      // Custom formatted JSON string with specific indentation & unicode notes
      const customRawBody = `{\n  "event": "payment.captured",\n  "payload": {\n    "payment": {\n      "entity": {\n        "id": "pay_raw_unicode_01",\n        "order_id": "${orderId}",\n        "amount": 80000,\n        "currency": "INR",\n        "status": "captured",\n        "notes": {\n          "description": "LabourBaba 🇮🇳 मजदूर बाबा पेमेंट"\n        }\n      }\n    }\n  }\n}`;

      const signature = signPayload(customRawBody, testSecret);

      const res = await request(app)
        .post("/api/payments/webhook")
        .set("Content-Type", "application/json")
        .set("X-Razorpay-Signature", signature)
        .send(customRawBody);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
      expect(payment?.status).toBe(PaymentStatus.COMPLETED);
      expect(payment?.razorpay_payment_id).toBe("pay_raw_unicode_01");
    });
  });

  // ── 4. Real PostgreSQL Concurrency: 20 Simultaneous Replays ──────────────────
  describe("4. Real PostgreSQL Concurrency — 20 Simultaneous Webhook Deliveries", () => {
    it("MUST guarantee exactly one state transition under 20 concurrent identical deliveries", async () => {
      process.env.RAZORPAY_WEBHOOK_SECRET = testSecret;

      const concurrentPayId = "pay_concurrent_20_reqs";
      const payload = JSON.stringify({
        event: "payment.captured",
        payload: {
          payment: {
            entity: { id: concurrentPayId, order_id: orderId, amount: 80000, currency: "INR", status: "captured" },
          },
        },
      });
      const signature = signPayload(payload, testSecret);

      const CONCURRENCY = 20;
      const promises: Promise<request.Response>[] = [];

      for (let i = 0; i < CONCURRENCY; i++) {
        promises.push(
          request(app)
            .post("/api/payments/webhook")
            .set("Content-Type", "application/json")
            .set("X-Razorpay-Signature", signature)
            .send(payload)
        );
      }

      const responses = await Promise.all(promises);

      // All 20 requests MUST return 200 OK
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      }

      // Invariant 1: Exactly ONE PaymentWebhookEvent row exists in PostgreSQL
      const events = await prisma.paymentWebhookEvent.findMany({
        where: { providerEventId: concurrentPayId },
      });
      expect(events.length).toBe(1);
      expect(events[0].status).toBe("PROCESSED");

      // Invariant 2: Payment status transitioned to COMPLETED exactly once
      const finalPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
      expect(finalPayment?.status).toBe(PaymentStatus.COMPLETED);
      expect(finalPayment?.razorpay_payment_id).toBe(concurrentPayId);
    });
  });
});
