import bcrypt from "bcrypt";
import prisma from "../src/config/prisma";
import { UserRole } from "../src/policies/types";
import { bookingService } from "../src/features/booking/bookingServices";
import {
  getPaymentStatus,
  refundPayment,
  PaymentStatus,
} from "../src/features/payment/paymentServices";

describe("P3 Issue 6 — Real PostgreSQL Booking & Payment Resource Protection", () => {
  jest.setTimeout(60000);

  // Entities
  let customerA: any;
  let customerB: any;
  let workerA: any;
  let workerB: any;
  let category: any;
  let adminUser: any;

  let jobA: any;
  let jobB: any;
  let reqA: any;
  let reqB: any;
  let bookingA: any;
  let bookingB: any;
  let paymentA: any;
  let paymentB: any;

  const phoneSuffix = Math.floor(100000 + Math.random() * 900000).toString();

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash("securePassword123!", 10);

    // 0. Ensure skill category exists
    category = await prisma.skill_category.findFirst({
      where: { name: "ResourceProtectionSkill" },
    });
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "ResourceProtectionSkill", is_active: true },
      });
    }

    // 1. Create Customers
    customerA = await prisma.customer.create({
      data: {
        name: "Customer Alice",
        phone: `+91981${phoneSuffix}`,
        password: passwordHash,
      },
    });

    customerB = await prisma.customer.create({
      data: {
        name: "Customer Bob",
        phone: `+91982${phoneSuffix}`,
        password: passwordHash,
      },
    });

    // 2. Create Workers
    workerA = await prisma.worker.create({
      data: {
        name: "Worker Charlie",
        phone: `+91983${phoneSuffix}`,
        password: passwordHash,
        skill_type: "ResourceProtectionSkill",
        skill_category_id: category.id,
      },
    });

    workerB = await prisma.worker.create({
      data: {
        name: "Worker Dave",
        phone: `+91984${phoneSuffix}`,
        password: passwordHash,
        skill_type: "ResourceProtectionSkill",
        skill_category_id: category.id,
      },
    });

    adminUser = {
      id: "00000000-0000-0000-0000-000000000001",
      role: UserRole.ADMIN,
      phone: "+919999999999",
    };

    // 3. Create Jobs
    jobA = await prisma.job.create({
      data: {
        customer_id: customerA.id,
        location: "123 Alice St",
        status: "OPEN",
        dispatch_status: "FILLED",
      },
    });

    jobB = await prisma.job.create({
      data: {
        customer_id: customerB.id,
        location: "456 Bob Ave",
        status: "OPEN",
        dispatch_status: "FILLED",
      },
    });

    // 4. Create Job Requirements
    reqA = await prisma.job_requirement.create({
      data: {
        job_id: jobA.id,
        skill_type: "ResourceProtectionSkill",
        worker_count_needed: 1,
        worker_count_filled: 1,
        rate_per_day: 800,
        status: "FILLED",
      },
    });

    reqB = await prisma.job_requirement.create({
      data: {
        job_id: jobB.id,
        skill_type: "ResourceProtectionSkill",
        worker_count_needed: 1,
        worker_count_filled: 1,
        rate_per_day: 1000,
        status: "FILLED",
      },
    });

    // 5. Create Bookings (Booking A -> Customer A, Worker A; Booking B -> Customer B, Worker B)
    const otpHash = await bcrypt.hash("1234", 10);

    bookingA = await prisma.booking.create({
      data: {
        job_id: jobA.id,
        requirement_id: reqA.id,
        customer_id: customerA.id,
        worker_id: workerA.id,
        status: "CONFIRMED",
        otp_hash: otpHash,
      },
    });

    bookingB = await prisma.booking.create({
      data: {
        job_id: jobB.id,
        requirement_id: reqB.id,
        customer_id: customerB.id,
        worker_id: workerB.id,
        status: "CONFIRMED",
        otp_hash: otpHash,
      },
    });

    // 6. Create Payments
    paymentA = await prisma.payment.create({
      data: {
        booking_id: bookingA.id,
        idempotency_key: bookingA.id,
        amount: 80000,
        currency: "INR",
        status: PaymentStatus.COMPLETED,
        razorpay_order_id: `order_A_${phoneSuffix}`,
        razorpay_payment_id: `pay_A_${phoneSuffix}`,
      },
    });

    paymentB = await prisma.payment.create({
      data: {
        booking_id: bookingB.id,
        idempotency_key: bookingB.id,
        amount: 100000,
        currency: "INR",
        status: PaymentStatus.COMPLETED,
        razorpay_order_id: `order_B_${phoneSuffix}`,
        razorpay_payment_id: `pay_B_${phoneSuffix}`,
      },
    });

    // 7. Set Worker Location for Worker A using PostGIS
    await prisma.$executeRaw`
      UPDATE worker
      SET location_geo = ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326)::geography,
          last_location_at = NOW()
      WHERE id = ${workerA.id}::uuid;
    `;
  });

  afterAll(async () => {
    try {
      if (paymentA?.id || paymentB?.id) {
        await prisma.payment.deleteMany({
          where: { id: { in: [paymentA?.id, paymentB?.id].filter(Boolean) } },
        });
      }
      if (bookingA?.id || bookingB?.id) {
        await prisma.booking.deleteMany({
          where: { id: { in: [bookingA?.id, bookingB?.id].filter(Boolean) } },
        });
      }
      if (reqA?.id || reqB?.id) {
        await prisma.job_requirement.deleteMany({
          where: { id: { in: [reqA?.id, reqB?.id].filter(Boolean) } },
        });
      }
      if (jobA?.id || jobB?.id) {
        await prisma.job.deleteMany({
          where: { id: { in: [jobA?.id, jobB?.id].filter(Boolean) } },
        });
      }
      if (customerA?.id || customerB?.id) {
        await prisma.customer.deleteMany({
          where: { id: { in: [customerA?.id, customerB?.id].filter(Boolean) } },
        });
      }
      if (workerA?.id || workerB?.id) {
        await prisma.worker.deleteMany({
          where: { id: { in: [workerA?.id, workerB?.id].filter(Boolean) } },
        });
      }
    } catch {}
    await prisma.$disconnect();
  });

  // =========================================================================
  // 1. Customer Ownership Isolation (Booking & Payment)
  // =========================================================================
  describe("1. Customer Ownership Isolation", () => {
    it("Customer A can read own Booking A with safe DTO", async () => {
      const actor = { id: customerA.id, role: UserRole.CUSTOMER, phone: customerA.phone };
      const detail = await bookingService.getBookingDetail(bookingA.id, actor);

      expect(detail).toBeDefined();
      expect(detail?.id).toBe(bookingA.id);
      expect(detail?.customer_id).toBe(customerA.id);
      // DTO safety: sensitive fields must not exist
      expect((detail as any)?.otp_hash).toBeUndefined();
      expect((detail as any)?.otpHash).toBeUndefined();
    });

    it("Customer A reading Customer B's Booking B MUST be denied (404/403)", async () => {
      const actor = { id: customerA.id, role: UserRole.CUSTOMER, phone: customerA.phone };
      await expect(bookingService.getBookingDetail(bookingB.id, actor)).rejects.toThrow();
    });

    it("Customer B reading Customer A's Booking A MUST be denied (404/403)", async () => {
      const actor = { id: customerB.id, role: UserRole.CUSTOMER, phone: customerB.phone };
      await expect(bookingService.getBookingDetail(bookingA.id, actor)).rejects.toThrow();
    });

    it("Customer A can read own Payment A via getPaymentStatus", async () => {
      const actor = { id: customerA.id, role: UserRole.CUSTOMER, phone: customerA.phone };
      const status = await getPaymentStatus(bookingA.id, actor);

      expect(status).toBeDefined();
      expect(status.id).toBe(paymentA.id);
      expect(status.amount).toBe(80000);
      expect(status.status).toBe(PaymentStatus.COMPLETED);
    });

    it("Customer A reading Customer B's Payment B via getPaymentStatus MUST be denied (404/403)", async () => {
      const actor = { id: customerA.id, role: UserRole.CUSTOMER, phone: customerA.phone };
      await expect(getPaymentStatus(bookingB.id, actor)).rejects.toThrow();
    });

    it("Customer B reading Customer A's Payment A via getPaymentStatus MUST be denied (404/403)", async () => {
      const actor = { id: customerB.id, role: UserRole.CUSTOMER, phone: customerB.phone };
      await expect(getPaymentStatus(bookingA.id, actor)).rejects.toThrow();
    });
  });

  // =========================================================================
  // 2. Worker Relationship & Payment Redaction
  // =========================================================================
  describe("2. Worker Relationship & Payment Redaction", () => {
    it("Worker A can read legitimately assigned Booking A", async () => {
      const actor = { id: workerA.id, role: UserRole.WORKER, phone: workerA.phone };
      const detail = await bookingService.getBookingDetail(bookingA.id, actor);

      expect(detail).toBeDefined();
      expect(detail?.id).toBe(bookingA.id);
      expect(detail?.worker_id).toBe(workerA.id);
      // Security requirement: payment data must be completely omitted for workers
      expect((detail as any)?.payment).toBeUndefined();
    });

    it("Worker B (unrelated) reading Booking A MUST be denied (404/403)", async () => {
      const actor = { id: workerB.id, role: UserRole.WORKER, phone: workerB.phone };
      await expect(bookingService.getBookingDetail(bookingA.id, actor)).rejects.toThrow();
    });

    it("Worker A reading unrelated Booking B MUST be denied (404/403)", async () => {
      const actor = { id: workerA.id, role: UserRole.WORKER, phone: workerA.phone };
      await expect(bookingService.getBookingDetail(bookingB.id, actor)).rejects.toThrow();
    });

    it("Worker A attempting getPaymentStatus for Booking A MUST be rejected with 403", async () => {
      const actor = { id: workerA.id, role: UserRole.WORKER, phone: workerA.phone };
      await expect(getPaymentStatus(bookingA.id, actor)).rejects.toThrow(/Workers are not authorized/i);
    });

    it("Worker B attempting getPaymentStatus for Booking A MUST be rejected with 403", async () => {
      const actor = { id: workerB.id, role: UserRole.WORKER, phone: workerB.phone };
      await expect(getPaymentStatus(bookingA.id, actor)).rejects.toThrow(/Workers are not authorized/i);
    });

    it("Worker A attempting refundPayment on Booking A MUST be rejected with 403", async () => {
      const actor = { id: workerA.id, role: UserRole.WORKER, phone: workerA.phone };
      await expect(refundPayment(bookingA.id, actor)).rejects.toThrow(/Workers are not authorized/i);
    });
  });

  // =========================================================================
  // 3. Platform Admin Authorization
  // =========================================================================
  describe("3. Explicit Admin Authorization", () => {
    it("Admin can read Booking A and Booking B", async () => {
      const detailA = await bookingService.getBookingDetail(bookingA.id, adminUser);
      expect(detailA?.id).toBe(bookingA.id);

      const detailB = await bookingService.getBookingDetail(bookingB.id, adminUser);
      expect(detailB?.id).toBe(bookingB.id);
    });

    it("Admin can read Payment A and Payment B status", async () => {
      const payA = await getPaymentStatus(bookingA.id, adminUser);
      expect(payA.id).toBe(paymentA.id);

      const payB = await getPaymentStatus(bookingB.id, adminUser);
      expect(payB.id).toBe(paymentB.id);
    });
  });

  // =========================================================================
  // 4. State Mutations & Cross-User Boundary Enforcement
  // =========================================================================
  describe("4. State Mutation Authorization Boundaries", () => {
    it("Unrelated Worker B cannot verify OTP on Booking A", async () => {
      const actor = { id: workerB.id, role: UserRole.WORKER, phone: workerB.phone };
      await expect(bookingService.verifyOtp(bookingA.id, workerB.id, "1234", actor)).rejects.toThrow();
    });

    it("Unrelated Worker B cannot complete Booking A", async () => {
      const actor = { id: workerB.id, role: UserRole.WORKER, phone: workerB.phone };
      await expect(bookingService.completeBooking(bookingA.id, workerB.id, actor)).rejects.toThrow();
    });

    it("Unrelated Customer B cannot confirm completion of Booking A", async () => {
      const actor = { id: customerB.id, role: UserRole.CUSTOMER, phone: customerB.phone };
      await expect(bookingService.confirmComplete(bookingA.id, customerB.id, { rating: 5, comment: "Great" }, actor)).rejects.toThrow();
    });

    it("Unrelated Customer B cannot cancel Booking A", async () => {
      const actor = { id: customerB.id, role: UserRole.CUSTOMER, phone: customerB.phone };
      await expect(bookingService.cancelBooking(bookingA.id, customerB.id, { reason: "Changed mind" }, actor)).rejects.toThrow();
    });

    it("Unrelated Worker B cannot cancel Booking A", async () => {
      const actor = { id: workerB.id, role: UserRole.WORKER, phone: workerB.phone };
      await expect(bookingService.cancelBooking(bookingA.id, workerB.id, { reason: "Cannot attend" }, actor)).rejects.toThrow();
    });

    it("Unrelated Customer B cannot track worker location on Booking A", async () => {
      const actor = { id: customerB.id, role: UserRole.CUSTOMER, phone: customerB.phone };
      await expect(bookingService.getWorkerLocation(bookingA.id, actor)).rejects.toThrow();
    });

    it("Customer A can track worker location on own Booking A", async () => {
      const actor = { id: customerA.id, role: UserRole.CUSTOMER, phone: customerA.phone };
      const loc = await bookingService.getWorkerLocation(bookingA.id, actor);
      expect(loc).toBeDefined();
      expect(loc?.worker_id).toBe(workerA.id);
    });
  });

  // =========================================================================
  // 5. UUID Tampering & Non-Existent Resources
  // =========================================================================
  describe("5. UUID Tampering & Invalid Resource Access", () => {
    const randomUuid = "ffffffff-ffff-ffff-ffff-ffffffffffff";

    it("Customer querying non-existent booking returns 404 cleanly", async () => {
      const actor = { id: customerA.id, role: UserRole.CUSTOMER, phone: customerA.phone };
      await expect(bookingService.getBookingDetail(randomUuid, actor)).rejects.toThrow();
    });

    it("Customer querying non-existent payment returns 404 cleanly", async () => {
      const actor = { id: customerA.id, role: UserRole.CUSTOMER, phone: customerA.phone };
      await expect(getPaymentStatus(randomUuid, actor)).rejects.toThrow();
    });
  });
});
