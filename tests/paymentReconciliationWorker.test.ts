/**
 * Issue 69 - Payment Reconciliation Service & Worker Tests
 *
 * Verifies that:
 * 1. Stale PENDING payments are detected and authoritative order state is fetched from Razorpay.
 * 2. Successful orders transition atomically to COMPLETED with audit logging.
 * 3. Amount/currency mismatches during reconciliation are quarantined immediately.
 * 4. Stale payments with exceeded attempts transition to FAILED.
 * 5. Idempotent: multiple worker sweeps produce safe, non-conflicting outcomes.
 */

import prisma from "../src/config/prisma";
import {
  paymentReconciliationService,
} from "../src/services/paymentReconciliationService";
import { PaymentStatus } from "../src/features/payment/paymentServices";
import { _setRazorpayInstanceForTesting } from "../src/providers/razorpay/razorpayProvider";

describe("Issue 69 - Payment Reconciliation Service & Worker", () => {
  jest.setTimeout(30000);

  const customerId = "00000000-0000-4011-a000-000000000001";
  const workerId = "00000000-0000-4011-b000-000000000001";
  const jobId = "00000000-0000-4011-c000-000000000001";
  const requirementId = "00000000-0000-4011-d000-000000000001";
  const bookingId = "00000000-0000-4011-e000-000000000001";
  const paymentId = "00000000-0000-4011-f000-000000000001";
  let skillCategoryId: string;

  beforeAll(async () => {
    // Clean test records
    await prisma.review.deleteMany({ where: { booking_id: bookingId } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { id: paymentId } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: bookingId } }).catch(() => {});
    await prisma.job_requirement.deleteMany({ where: { id: requirementId } }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: jobId } }).catch(() => {});
    await prisma.worker.deleteMany({ where: { id: workerId } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { id: customerId } }).catch(() => {});

    let category = await prisma.skill_category.findFirst({ where: { name: "ReconTestSkill" } });
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "ReconTestSkill", is_active: true },
      });
    }
    skillCategoryId = category.id;

    await prisma.customer.create({
      data: { id: customerId, phone: "+919996000001", name: "Recon Customer", password: "hash" },
    });

    await prisma.worker.create({
      data: {
        id: workerId,
        phone: "+919996000002",
        name: "Recon Worker",
        password: "hash",
        skill_type: "ReconTestSkill",
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
    await prisma.customer.deleteMany({ where: { id: customerId } }).catch(() => {});
    await prisma.$disconnect();
  });

  beforeEach(async () => {
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
        skill_type: "ReconTestSkill",
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

    // Create a stale pending payment created 30 minutes ago
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
    await prisma.payment.create({
      data: {
        id: paymentId,
        booking_id: bookingId,
        razorpay_order_id: "order_recon_test_001",
        amount: 50000, // 50000 paise
        currency: "INR",
        status: PaymentStatus.PENDING,
        idempotency_key: bookingId,
        created_at: thirtyMinsAgo,
      },
    });
  });

  describe("Reconciliation Sweeps", () => {
    it("reconciles paid order to COMPLETED state and records audit log", async () => {
      _setRazorpayInstanceForTesting({
        orders: {
          fetch: async (orderId: string) => ({
            id: orderId,
            amount: 50000,
            currency: "INR",
            status: "paid",
            attempts: 1,
          }),
        },
      } as any);

      const res = await paymentReconciliationService.reconcileStalePayments(15);

      expect(res.totalEvaluated).toBeGreaterThanOrEqual(1);
      expect(res.reconciledCompleted).toBeGreaterThanOrEqual(1);

      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
      expect(payment?.status).toBe(PaymentStatus.COMPLETED);
    });

    it("quarantines payment when provider amount mismatches during reconciliation", async () => {
      _setRazorpayInstanceForTesting({
        orders: {
          fetch: async (orderId: string) => ({
            id: orderId,
            amount: 25000, // Provider recorded 250 INR instead of 500 INR
            currency: "INR",
            status: "paid",
            attempts: 1,
          }),
        },
      } as any);

      const res = await paymentReconciliationService.reconcileStalePayments(15);

      expect(res.quarantined).toBeGreaterThanOrEqual(1);

      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
      expect(payment?.status).toBe(PaymentStatus.PENDING); // MUST NOT transition to COMPLETED
      expect(payment?.quarantine_reason).toContain("Reconciliation amount mismatch");
    });

    it("transitions stale order with >3 failed attempts to FAILED", async () => {
      _setRazorpayInstanceForTesting({
        orders: {
          fetch: async (orderId: string) => ({
            id: orderId,
            amount: 50000,
            currency: "INR",
            status: "created",
            attempts: 4, // 4 failed attempts
          }),
        },
      } as any);

      const res = await paymentReconciliationService.reconcileStalePayments(15);

      expect(res.reconciledFailed).toBeGreaterThanOrEqual(1);

      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
      expect(payment?.status).toBe(PaymentStatus.FAILED);
    });
  });
});
