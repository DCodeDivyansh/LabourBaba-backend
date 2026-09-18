/**
 * Issue #6 — Protect Booking and Payment Resources
 * Priority: P0/P1 Security / Privacy (Audit Findings #16, #20)
 *
 * Security Invariants Verified:
 * 1. Customer can only access their own bookings and payment records.
 * 2. Worker can only access bookings where assigned; payment records are NEVER exposed to workers.
 * 3. Platform Admin access is explicit and authorized.
 * 4. Payment access is derived from authorized booking relationship, not UUID possession.
 * 5. Both /api/payments/:bookingId and /api/bookings/:bookingId/payment are secured.
 * 6. Booking mutations (OTP, completion, confirmation, cancellation, location) are scoped.
 * 7. Malformed identifiers are rejected with HTTP 400 Bad Request before database access.
 * 8. Unauthenticated requests are rejected with HTTP 401 Unauthorized.
 */

import request from "supertest";
import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { UserRole } from "../src/middlewares/authMiddleware";
import { generateToken } from "../src/utils/authUtils";
import { bookingService } from "../src/features/booking/bookingServices";

// Mock Bull Board to prevent queue adapter validation failures
jest.mock("@bull-board/api", () => ({
  createBullBoard: jest.fn().mockReturnValue({}),
}));
jest.mock("@bull-board/api/bullMQAdapter", () => ({
  BullMQAdapter: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("@bull-board/express", () => ({
  ExpressAdapter: jest.fn().mockImplementation(() => ({
    setBasePath: jest.fn(),
    getRouter: jest.fn().mockReturnValue((req: any, res: any, next: any) => next()),
  })),
}));

// Mock BullMQ queues
jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue({}),
  })),
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn(),
  })),
}));

jest.mock("../src/config/bullmq", () => ({
  dispatchQueue: { add: jest.fn() },
  timeoutQueue: { add: jest.fn() },
  connection: {},
}));

jest.mock("../src/features/dispatch/simpleDispatch", () => ({
  dispatchJobSimple: jest.fn().mockResolvedValue({}),
}));

// Mock Razorpay Provider
jest.mock("../src/providers/razorpay/razorpayProvider", () => ({
  createOrder: jest.fn().mockResolvedValue({
    razorpayOrderId: "order_mock_123",
    amount: 50000,
    currency: "INR",
  }),
  verifyWebhookSignature: jest.fn().mockReturnValue(true),
  RazorpayProviderError: class RazorpayProviderError extends Error {
    public readonly code: string;
    public readonly statusCode: number;
    constructor(message: string, code: string, statusCode = 502) {
      super(message);
      this.name = "RazorpayProviderError";
      this.code = code;
      this.statusCode = statusCode;
    }
  },
}));

// Mock Prisma
jest.mock("../src/config/prisma", () => ({
  __esModule: true,
  default: {
    booking: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    payment: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    review: {
      create: jest.fn(),
      findFirst: jest.fn(),
    },
    worker_location: {
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(async (cb: any) =>
      cb({
        booking: {
          findFirst: jest.fn(),
          findUnique: jest.fn(),
          update: jest.fn(),
        },
        review: {
          create: jest.fn(),
        },
        payment: {
          findFirst: jest.fn(),
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      })
    ),
  },
}));

// Constants
const CUSTOMER_A_ID = "11111111-1111-4111-a111-111111111111";
const CUSTOMER_B_ID = "22222222-2222-4222-a222-222222222222";
const WORKER_A_ID   = "33333333-3333-4333-a333-333333333333";
const WORKER_B_ID   = "44444444-4444-4444-a444-444444444444";
const ADMIN_ID      = "99999999-9999-4999-a999-999999999999";

const BOOKING_A_ID  = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const BOOKING_B_ID  = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const PAYMENT_A_ID  = "faaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

const customerAToken = generateToken({ id: CUSTOMER_A_ID, role: UserRole.CUSTOMER, phone: "+919876543210" });
const customerBToken = generateToken({ id: CUSTOMER_B_ID, role: UserRole.CUSTOMER, phone: "+919876543211" });
const workerAToken   = generateToken({ id: WORKER_A_ID, role: UserRole.WORKER, phone: "+919876543212" });
const workerBToken   = generateToken({ id: WORKER_B_ID, role: UserRole.WORKER, phone: "+919876543213" });
const adminToken     = generateToken({ id: ADMIN_ID, role: UserRole.ADMIN, phone: "+919876543214" });

describe("Issue #6 — Protect Booking and Payment Resources", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // 1. GET /api/bookings/:bookingId (Booking Detail Access Control)
  // =========================================================================
  describe("1. GET /api/bookings/:bookingId (Booking Detail)", () => {
    it("Customer A CAN retrieve own booking (200 with payment data)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "CONFIRMED",
        payment: {
          id: PAYMENT_A_ID,
          booking_id: BOOKING_A_ID,
          amount: 50000,
          currency: "INR",
          status: "PENDING",
          razorpay_order_id: "order_123",
        },
      });

      const res = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(BOOKING_A_ID);
      expect(res.body.data.payment).toBeDefined();
      expect(res.body.data.payment.amount).toBe(50000);
      expect(prisma.booking.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: BOOKING_A_ID,
            customer_id: CUSTOMER_A_ID,
          }),
        })
      );
    });

    it("Customer B CANNOT retrieve Customer A's booking (404 IDOR protection)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Booking not found");
    });

    it("Worker A (assigned) CAN retrieve booking detail but NEVER receives payment data", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "CONFIRMED",
        payment: {
          id: PAYMENT_A_ID,
          booking_id: BOOKING_A_ID,
          amount: 50000,
        },
      });

      const res = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${workerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(BOOKING_A_ID);
      // Strict payment data minimization for workers
      expect(res.body.data.payment).toBeUndefined();
    });

    it("Worker B (unrelated worker) CANNOT retrieve Worker A's booking (404 IDOR protection)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${workerBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Booking not found");
    });

    it("Platform Admin CAN retrieve any booking detail", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "CONFIRMED",
        payment: { id: PAYMENT_A_ID, booking_id: BOOKING_A_ID, amount: 50000 },
      });

      const res = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(BOOKING_A_ID);
      expect(res.body.data.payment).toBeDefined();
    });

    it("Malformed bookingId returns 400 Bad Request without calling database", async () => {
      const res = await request(app)
        .get("/api/bookings/malformed-not-a-uuid")
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(prisma.booking.findFirst).not.toHaveBeenCalled();
    });

    it("Unauthenticated request returns 401 Unauthorized", async () => {
      const res = await request(app).get(`/api/bookings/${BOOKING_A_ID}`);
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // 2. Payment Access Controls (GET /api/payments/:bookingId & /api/bookings/:bookingId/payment)
  // =========================================================================
  describe("2. Payment Status Access Controls", () => {
    it("Customer A CAN get payment status via GET /api/payments/:bookingId", async () => {
      (prisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: PAYMENT_A_ID,
        booking_id: BOOKING_A_ID,
        razorpay_order_id: "order_123",
        status: "PENDING",
        amount: 50000,
        currency: "INR",
      });

      const res = await request(app)
        .get(`/api/payments/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.razorpay_order_id).toBe("order_123");
      expect(prisma.payment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            booking_id: BOOKING_A_ID,
            booking: { customer_id: CUSTOMER_A_ID },
          }),
        })
      );
    });

    it("Customer A CAN get payment status via canonical GET /api/bookings/:bookingId/payment", async () => {
      (prisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: PAYMENT_A_ID,
        booking_id: BOOKING_A_ID,
        razorpay_order_id: "order_123",
        status: "PENDING",
        amount: 50000,
        currency: "INR",
      });

      const res = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}/payment`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.razorpay_order_id).toBe("order_123");
    });

    it("Customer B CANNOT access Customer A's payment status (403/404 denied)", async () => {
      (prisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({ id: BOOKING_A_ID });

      const res = await request(app)
        .get(`/api/payments/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerBToken}`);

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });

    it("Worker A is FORBIDDEN from accessing /api/payments/:bookingId (403)", async () => {
      const res = await request(app)
        .get(`/api/payments/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${workerAToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(prisma.payment.findFirst).not.toHaveBeenCalled();
    });

    it("Worker A is FORBIDDEN from accessing /api/bookings/:bookingId/payment (403)", async () => {
      const res = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}/payment`)
        .set("Authorization", `Bearer ${workerAToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(prisma.payment.findFirst).not.toHaveBeenCalled();
    });

    it("Platform Admin CAN get payment status via both endpoints", async () => {
      (prisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: PAYMENT_A_ID,
        booking_id: BOOKING_A_ID,
        razorpay_order_id: "order_123",
        status: "PENDING",
        amount: 50000,
        currency: "INR",
      });

      const res1 = await request(app)
        .get(`/api/payments/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res1.status).toBe(200);

      const res2 = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}/payment`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res2.status).toBe(200);
    });

    it("Malformed bookingId on payment route returns 400 Bad Request", async () => {
      const res = await request(app)
        .get("/api/payments/not-a-valid-uuid")
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  // =========================================================================
  // 3. Booking Mutations Authorization & Scoping
  // =========================================================================
  describe("3. Booking Lifecycle Mutations", () => {
    it("Worker A CAN verify OTP for assigned booking", async () => {
      const mockTxBooking = {
        id: BOOKING_A_ID,
        worker_id: WORKER_A_ID,
        customer_id: CUSTOMER_A_ID,
        status: "CONFIRMED",
        otp_hash: "$2b$10$abcdefghijklmnopqrstuu", // valid hash
      };

      (prisma.$transaction as jest.Mock).mockImplementationOnce(async (cb: any) => {
        return cb({
          booking: {
            findFirst: jest.fn().mockResolvedValue(mockTxBooking),
            findUnique: jest.fn().mockResolvedValue(mockTxBooking),
            update: jest.fn().mockResolvedValue({ ...mockTxBooking, status: "IN_PROGRESS" }),
          },
        });
      });

      // Mock comparePassword to return true
      const authUtils = require("../src/utils/authUtils");
      const compareSpy = jest.spyOn(authUtils, "comparePassword").mockResolvedValue(true as never);

      const res = await request(app)
        .post(`/api/bookings/${BOOKING_A_ID}/otp/verify`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ otp: "123456" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      compareSpy.mockRestore();
    });

    it("Worker B CANNOT verify OTP for Worker A's booking (403/404 denied)", async () => {
      const mockTxBooking = {
        id: BOOKING_A_ID,
        worker_id: WORKER_A_ID,
        customer_id: CUSTOMER_A_ID,
      };

      (prisma.$transaction as jest.Mock).mockImplementationOnce(async (cb: any) => {
        return cb({
          booking: {
            findFirst: jest.fn().mockResolvedValue(null),
            findUnique: jest.fn().mockResolvedValue(mockTxBooking),
            update: jest.fn(),
          },
        });
      });

      const res = await request(app)
        .post(`/api/bookings/${BOOKING_A_ID}/otp/verify`)
        .set("Authorization", `Bearer ${workerBToken}`)
        .send({ otp: "123456" });

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });

    it("Invalid OTP format (not 6 digits) returns 400 Bad Request", async () => {
      const res = await request(app)
        .post(`/api/bookings/${BOOKING_A_ID}/otp/verify`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ otp: "123" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("Customer A CAN confirm complete for own booking", async () => {
      const mockTxBooking = {
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "COMPLETED",
      };

      (prisma.$transaction as jest.Mock).mockImplementationOnce(async (cb: any) => {
        return cb({
          booking: {
            findFirst: jest.fn().mockResolvedValue(mockTxBooking),
            findUnique: jest.fn().mockResolvedValue(mockTxBooking),
          },
          review: {
            create: jest.fn().mockResolvedValue({ id: "rev-1" }),
          },
        });
      });

      const res = await request(app)
        .post(`/api/bookings/${BOOKING_A_ID}/confirm-complete`)
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({ rating: 5, comment: "Great service" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("Customer B CANNOT confirm complete for Customer A's booking (403/404 denied)", async () => {
      const mockTxBooking = {
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "COMPLETED",
      };

      (prisma.$transaction as jest.Mock).mockImplementationOnce(async (cb: any) => {
        return cb({
          booking: {
            findFirst: jest.fn().mockResolvedValue(null),
            findUnique: jest.fn().mockResolvedValue(mockTxBooking),
          },
        });
      });

      const res = await request(app)
        .post(`/api/bookings/${BOOKING_A_ID}/confirm-complete`)
        .set("Authorization", `Bearer ${customerBToken}`)
        .send({ rating: 5 });

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });

    it("Customer A CAN get worker location for own booking", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
      });
      (prisma.worker_location.findFirst as jest.Mock).mockResolvedValue({
        id: "loc-1",
        worker_id: WORKER_A_ID,
        latitude: 19.076,
        longitude: 72.8777,
        location: "Mumbai",
        updated_at: new Date(),
      });

      const res = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}/location`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.latitude).toBe(19.076);
    });

    it("Customer B CANNOT get worker location for Customer A's booking (403/404)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({ id: BOOKING_A_ID, customer_id: CUSTOMER_A_ID });

      const res = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}/location`)
        .set("Authorization", `Bearer ${customerBToken}`);

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });
  });

  // =========================================================================
  // 4. Service-Layer Direct Invariants
  // =========================================================================
  describe("4. Service-Layer Direct Authorization Invariants", () => {
    it("bookingService.getBookingDetail throws 401 when actor is missing", async () => {
      await expect(bookingService.getBookingDetail(BOOKING_A_ID)).rejects.toThrow(
        "Authentication required to view booking"
      );
    });

    it("bookingService.getWorkerLocation throws 401 when actor is missing", async () => {
      await expect(bookingService.getWorkerLocation(BOOKING_A_ID, undefined as any)).rejects.toThrow();
    });

    it("bookingService.getBookingDetail strips payment for worker role", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        payment: { id: PAYMENT_A_ID, amount: 50000 },
      });

      const result = await bookingService.getBookingDetail(BOOKING_A_ID, {
        id: WORKER_A_ID,
        role: UserRole.WORKER,
        phone: "+919876543212",
      });

      expect(result).not.toBeNull();
      expect(result!.id).toBe(BOOKING_A_ID);
      expect(result!.payment).toBeUndefined();
    });
  });
});
