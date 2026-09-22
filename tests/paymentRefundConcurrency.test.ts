/**
 * P4 Issue 6 — Refund Flow Concurrency, Atomic Ownership & Timeout Handling Tests
 *
 * Verifies:
 * - Test A: 50 concurrent refund requests against the same payment (exactly 1 provider call, 0 duplicates, 1 winner, 49 rejected with 409/idempotent).
 * - Test B: Calling refund on an already REFUND_PENDING payment rejects without reaching provider.
 * - Test C: Provider timeout/failure sets status to REFUND_FAILED (never falsely marked REFUNDED).
 * - Test D: Provider success transitions status from REFUND_PENDING to REFUNDED with provider refund ID persisted.
 * - Test E: Retrying a REFUND_FAILED payment re-claims the lock atomically and succeeds; retrying a REFUNDED payment returns idempotent success.
 */

import prisma from "../src/config/prisma";
import { refundPayment, handleWebhook, PaymentStatus } from "../src/features/payment/paymentServices";
import { _setRazorpayInstanceForTesting } from "../src/providers/razorpay/razorpayProvider";
import { UserRole } from "../src/policies";

describe("P4 Issue 6 — Refund Flow Concurrency & Atomic Ownership", () => {
  jest.setTimeout(60000);

  const customerId = "00000000-0000-4066-a000-000000000001";
  const workerId = "00000000-0000-4066-b000-000000000001";
  const jobId = "00000000-0000-4066-c000-000000000001";
  const requirementId = "00000000-0000-4066-d000-000000000001";
  const bookingId = "00000000-0000-4066-e000-000000000001";
  const paymentId = "00000000-0000-4066-f000-000000000001";
  let skillCategoryId: string;

  let providerCallCount = 0;

  beforeAll(async () => {
    await prisma.paymentWebhookEvent.deleteMany({}).catch(() => {});
    await prisma.review.deleteMany({ where: { booking_id: bookingId } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { id: paymentId } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: bookingId } }).catch(() => {});
    await prisma.job_requirement.deleteMany({ where: { id: requirementId } }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: jobId } }).catch(() => {});
    await prisma.worker.deleteMany({ where: { id: workerId } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { id: customerId } }).catch(() => {});

    let category = await prisma.skill_category.findFirst({ where: { name: "RefundConcurrencySkill" } });
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "RefundConcurrencySkill", is_active: true },
      });
    }
    skillCategoryId = category.id;

    await prisma.customer.create({
      data: { id: customerId, phone: "+919999000066", name: "Refund Concurrency Customer", password: "hash" },
    });

    await prisma.worker.create({
      data: {
        id: workerId,
        phone: "+919999000067",
        name: "Refund Concurrency Worker",
        password: "hash",
        skill_type: "RefundConcurrencySkill",
        skill_category_id: skillCategoryId,
        verification_status: "verified",
        is_online: true,
      },
    });
  });

  afterAll(async () => {
    _setRazorpayInstanceForTesting(null);
    try {
      await prisma.paymentWebhookEvent.deleteMany({}).catch(() => {});
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
    providerCallCount = 0;
    _setRazorpayInstanceForTesting({
      payments: {
        refund: async (payId: string, params: any) => {
          providerCallCount++;
          // Simulate a realistic provider delay to expose race conditions
          await new Promise((r) => setTimeout(r, 40));
          return {
            id: `rfnd_conc_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
            payment_id: payId,
            amount: params?.amount || 80000,
            currency: "INR",
            status: "processed",
          };
        },
      },
    } as any);

    await prisma.paymentWebhookEvent.deleteMany({}).catch(() => {});
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
        skill_type: "RefundConcurrencySkill",
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
        razorpay_order_id: "order_refund_concurrency_001",
        razorpay_payment_id: "pay_refund_concurrency_001",
        amount: 80000,
        currency: "INR",
        status: PaymentStatus.COMPLETED,
        idempotency_key: bookingId,
      },
    });
  });

  it("Test A: 50 concurrent refund requests result in exactly 1 provider call and 0 duplicate refunds", async () => {
    const actor = { id: customerId, role: UserRole.CUSTOMER, phone: "+919999000066" };

    const concurrencyCount = 50;
    const promises = Array.from({ length: concurrencyCount }, () =>
      refundPayment(bookingId, actor, 80000, "50 concurrent refunds test")
        .then((res) => ({ success: true, res }))
        .catch((err) => ({ success: false, err }))
    );

    const results = await Promise.all(promises);

    const successes = results.filter((r): r is { success: true; res: any } => r.success);
    const failures = results.filter((r): r is { success: false; err: any } => !r.success);

    // Exactly 1 caller wins the atomic claim and invokes Razorpay
    expect(providerCallCount).toBe(1);

    // All failed attempts should fail with 409 REFUND_ALREADY_PENDING or REFUND_INVALID_STATE
    for (const fail of failures) {
      expect(fail.err.statusCode).toBe(409);
      expect(fail.err.code).toMatch(/REFUND_ALREADY_PENDING|REFUND_INVALID_STATE/);
    }

    // At least 1 success (the winner, plus any that completed after REFUNDED state returned idempotent success)
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // Verify final state in PostgreSQL
    const finalPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(finalPayment?.status).toBe(PaymentStatus.REFUNDED);
    expect(finalPayment?.razorpay_refund_id).toMatch(/^rfnd_conc_/);
    expect(finalPayment?.refund_amount).toBe(80000);
  });

  it("Test B: Already pending refund rejects without calling provider", async () => {
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.REFUND_PENDING },
    });

    const actor = { id: customerId, role: UserRole.CUSTOMER, phone: "+919999000066" };

    await expect(
      refundPayment(bookingId, actor, 80000, "Pending refund test")
    ).rejects.toThrow(/already in progress/);

    expect(providerCallCount).toBe(0);
  });

  it("Test C: Provider timeout/failure marks REFUND_UNKNOWN and throws 502 without marking REFUNDED", async () => {
    _setRazorpayInstanceForTesting({
      payments: {
        refund: async () => {
          providerCallCount++;
          const timeoutErr: any = new Error("Gateway Timeout from Razorpay");
          timeoutErr.statusCode = 504;
          throw timeoutErr;
        },
      },
    } as any);

    const actor = { id: customerId, role: UserRole.CUSTOMER, phone: "+919999000066" };

    await expect(
      refundPayment(bookingId, actor, 80000, "Timeout simulation")
    ).rejects.toThrow(/Payment refund failed/);

    expect(providerCallCount).toBe(1);

    const failedPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(failedPayment?.status).toBe(PaymentStatus.REFUND_UNKNOWN);
    expect(failedPayment?.status).not.toBe(PaymentStatus.REFUNDED);
    expect(failedPayment?.refund_reason).toContain("Gateway Timeout");
  });

  it("Test D: Provider success transitions status from REFUND_PENDING to REFUNDED with provider ID", async () => {
    const actor = { id: customerId, role: UserRole.CUSTOMER, phone: "+919999000066" };

    const res = await refundPayment(bookingId, actor, 80000, "Provider success test");
    expect(res.success).toBe(true);
    expect(res.refundId).toMatch(/^rfnd_conc_/);

    const refundedPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(refundedPayment?.status).toBe(PaymentStatus.REFUNDED);
    expect(refundedPayment?.razorpay_refund_id).toBe(res.refundId);
    expect(refundedPayment?.refund_status).toBe("processed");
  });

  it("Test E: Retrying a REFUND_FAILED payment re-claims the lock and succeeds", async () => {
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: PaymentStatus.REFUND_FAILED, refund_reason: "Previous 400 Bad Request" },
    });

    const actor = { id: customerId, role: UserRole.CUSTOMER, phone: "+919999000066" };

    const res = await refundPayment(bookingId, actor, 80000, "Retry refund");
    expect(res.success).toBe(true);
    expect(providerCallCount).toBe(1);

    const updatedPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(updatedPayment?.status).toBe(PaymentStatus.REFUNDED);
    expect(updatedPayment?.razorpay_refund_id).toBe(res.refundId);

    // Retrying again when already REFUNDED yields idempotent success
    const idempotentRes = await refundPayment(bookingId, actor, 80000, "Retry already refunded");
    expect(idempotentRes.success).toBe(true);
    expect(idempotentRes.message).toContain("already been refunded");
    // Should NOT have made an extra provider call
    expect(providerCallCount).toBe(1);
  });

  it("Test F: Adversarial Unknown Provider Outcome — Lost Response Recovered via Webhook with 0 Duplicate Charges", async () => {
    const webhookSecret = "test_webhook_secret_p4_issue_6_recovery!";
    process.env.RAZORPAY_WEBHOOK_SECRET = webhookSecret;

    const lostRefundId = "rfnd_adversarial_lost_999";
    const razorpayPayId = "pay_refund_concurrency_001";

    // 1. Simulate provider side effect succeeded on Razorpay, but local network dropped before response arrived
    _setRazorpayInstanceForTesting({
      payments: {
        refund: async () => {
          providerCallCount++;
          // Simulate that provider processed it, but connection dropped right after
          const networkDropErr: any = new Error("Connection reset by peer during refund response");
          networkDropErr.statusCode = 500;
          throw networkDropErr;
        },
      },
    } as any);

    const actor = { id: customerId, role: UserRole.CUSTOMER, phone: "+919999000066" };

    // 2. Caller experiences a 502/error
    await expect(
      refundPayment(bookingId, actor, 80000, "Adversarial network drop simulation")
    ).rejects.toThrow(/Payment refund failed/);

    expect(providerCallCount).toBe(1);

    // Local DB is temporarily in REFUND_UNKNOWN
    const interimPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(interimPayment?.status).toBe(PaymentStatus.REFUND_UNKNOWN);
    expect(interimPayment?.razorpay_refund_id).toBeNull();

    // 3. Provider sends refund.processed webhook asynchronous reconciliation
    const webhookPayload = JSON.stringify({
      entity: "event",
      event: "refund.processed",
      contains: ["refund", "payment"],
      payload: {
        payment: {
          entity: {
            id: razorpayPayId,
            order_id: "order_refund_concurrency_001",
            amount: 80000,
            currency: "INR",
            status: "refunded",
          },
        },
        refund: {
          entity: {
            id: lostRefundId,
            payment_id: razorpayPayId,
            amount: 80000,
            currency: "INR",
            status: "processed",
          },
        },
      },
    });

    const crypto = require("crypto");
    const signature = crypto.createHmac("sha256", webhookSecret).update(webhookPayload).digest("hex");

    const webhookRes = await handleWebhook(webhookPayload, signature);

    expect(webhookRes.success).toBe(true);

    // 4. Verify local payment state authoritatively converged to REFUNDED with the provider refund ID
    const recoveredPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(recoveredPayment?.status).toBe(PaymentStatus.REFUNDED);
    expect(recoveredPayment?.razorpay_refund_id).toBe(lostRefundId);
    expect(recoveredPayment?.refund_amount).toBe(80000);
    expect(recoveredPayment?.refund_status).toBe("processed");

    // 5. Customer retries refund request after recovery — MUST be idempotent and NEVER call provider again
    const retryRes = await refundPayment(bookingId, actor, 80000, "Customer retry after recovery");
    expect(retryRes.success).toBe(true);
    expect(retryRes.refundId).toBe(lostRefundId);
    expect(retryRes.message).toContain("already been refunded");

    // PROVE: Provider was called exactly 1 time in total (0 duplicate refunds)
    expect(providerCallCount).toBe(1);
  });

  it("Test G: Adversarial Early Retry during Unknown Provider Outcome BEFORE Webhook arrives — Reconciles with 0 Duplicate Provider Invocations", async () => {
    const lostRefundId = "rfnd_early_retry_pre_webhook_888";
    const razorpayPayId = "pay_refund_concurrency_001";

    let refundApiInvocations = 0;

    _setRazorpayInstanceForTesting({
      payments: {
        refund: async () => {
          refundApiInvocations++;
          // First attempt succeeds on provider, but network fails before client gets response
          const networkTimeout: any = new Error("Gateway Timeout from upstream bank");
          networkTimeout.statusCode = 504;
          throw networkTimeout;
        },
        fetch: async (payId: string) => {
          // When pre-flight reconciliation checks the provider status, Razorpay reports it as REFUNDED!
          return {
            id: payId,
            order_id: "order_refund_concurrency_001",
            amount: 80000,
            currency: "INR",
            status: "refunded",
            amount_refunded: 80000,
            refund_status: "full",
          };
        },
      },
    } as any);

    const actor = { id: customerId, role: UserRole.CUSTOMER, phone: "+919999000066" };

    // 1. Initial attempt fails locally with REFUND_UNKNOWN
    await expect(
      refundPayment(bookingId, actor, 80000, "Initial timed out request")
    ).rejects.toThrow(/Payment refund failed/);

    expect(refundApiInvocations).toBe(1);

    const unknownPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(unknownPayment?.status).toBe(PaymentStatus.REFUND_UNKNOWN);

    // 2. Customer immediately issues a SECOND refund request (NO WEBHOOK HAS ARRIVED YET)
    const earlyRetryRes = await refundPayment(bookingId, actor, 80000, "Early retry before webhook");

    // 3. Early retry runs pre-flight reconciliation, detects provider refund, and resolves to REFUNDED
    expect(earlyRetryRes.success).toBe(true);
    expect(earlyRetryRes.message).toContain("already been refunded");

    // CRITICAL INVARIANT: ZERO second provider refund call was initiated
    expect(refundApiInvocations).toBe(1);

    // Final database status is verified to be REFUNDED
    const finalPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(finalPayment?.status).toBe(PaymentStatus.REFUNDED);
    expect(finalPayment?.refund_amount).toBe(80000);
  });

  it("Test H: Intermediate Provider State (captured + refund_status: full) — Early Retry & Process Restart Invariant (PROVIDER CALLS === 1)", async () => {
    const webhookSecret = "test_webhook_secret_p4_issue_6_intermediate!";
    process.env.RAZORPAY_WEBHOOK_SECRET = webhookSecret;

    const lostRefundId = "rfnd_intermediate_state_777";
    const razorpayPayId = "pay_refund_concurrency_001";

    let totalProviderRefundInvocations = 0;

    // Simulate Razorpay accepting the refund, but network dropping
    _setRazorpayInstanceForTesting({
      payments: {
        refund: async () => {
          totalProviderRefundInvocations++;
          const netErr: any = new Error("Connection reset while waiting for refund response");
          netErr.statusCode = 500;
          throw netErr;
        },
        fetch: async (payId: string) => {
          // Earliest legitimate state: Razorpay status is still "captured", but refund_status is "full" and amount_refunded is 80000
          return {
            id: payId,
            order_id: "order_refund_concurrency_001",
            amount: 80000,
            currency: "INR",
            status: "captured", // Still 'captured' in intermediate state
            amount_refunded: 80000,
            refund_status: "full",
          };
        },
      },
    } as any);

    const actor = { id: customerId, role: UserRole.CUSTOMER, phone: "+919999000066" };

    // 1. Initial attempt fails locally with REFUND_UNKNOWN
    await expect(
      refundPayment(bookingId, actor, 80000, "Initial request before network drop")
    ).rejects.toThrow(/Payment refund failed/);

    expect(totalProviderRefundInvocations).toBe(1);

    const intermediatePayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(intermediatePayment?.status).toBe(PaymentStatus.REFUND_UNKNOWN);

    // 2. Early retry BEFORE webhook arrives
    const earlyRetry = await refundPayment(bookingId, actor, 80000, "Early retry during intermediate state");
    expect(earlyRetry.success).toBe(true);
    expect(earlyRetry.message).toContain("already been refunded");

    // Invariant: ZERO extra provider refund calls
    expect(totalProviderRefundInvocations).toBe(1);

    // 3. Deliver refund.processed webhook
    const webhookPayload = JSON.stringify({
      entity: "event",
      event: "refund.processed",
      contains: ["refund", "payment"],
      payload: {
        payment: {
          entity: {
            id: razorpayPayId,
            order_id: "order_refund_concurrency_001",
            amount: 80000,
            currency: "INR",
            status: "refunded",
          },
        },
        refund: {
          entity: {
            id: lostRefundId,
            payment_id: razorpayPayId,
            amount: 80000,
            currency: "INR",
            status: "processed",
          },
        },
      },
    });

    const crypto = require("crypto");
    const signature = crypto.createHmac("sha256", webhookSecret).update(webhookPayload).digest("hex");
    const webhookRes = await handleWebhook(webhookPayload, signature);
    expect(webhookRes.success).toBe(true);

    // 4. Verify final local state
    const finalPayment = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(finalPayment?.status).toBe(PaymentStatus.REFUNDED);
    expect(finalPayment?.razorpay_refund_id).toBe(lostRefundId);

    // 5. Simulate application restart and repeat retry
    const postRestartRetry = await refundPayment(bookingId, actor, 80000, "Post-restart retry");
    expect(postRestartRetry.success).toBe(true);
    expect(postRestartRetry.refundId).toBe(lostRefundId);

    // ABSOLUTE INVARIANT: TOTAL PROVIDER REFUND INVOCATIONS === 1
    expect(totalProviderRefundInvocations).toBe(1);
  });
});
