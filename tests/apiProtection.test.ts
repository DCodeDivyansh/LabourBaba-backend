import request from "supertest";

// Mock Bull Board to prevent queue adapter validation failures during test server startup
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

// Mock the bullmq module itself to avoid Redis connection attempts
jest.mock("bullmq", () => {
  return {
    Queue: jest.fn().mockImplementation(() => ({
      add: jest.fn().mockResolvedValue({}),
    })),
    Worker: jest.fn().mockImplementation(() => ({
      on: jest.fn(),
      close: jest.fn(),
    })),
  };
});

// Mock BullMQ queue config to prevent real connection attempts
jest.mock("../src/config/bullmq", () => ({
  dispatchQueue: {
    add: jest.fn(),
  },
  timeoutQueue: {
    add: jest.fn(),
  },
  connection: {},
}));

jest.mock("../src/providers/razorpay/razorpayProvider", () => ({
  createOrder: jest.fn().mockResolvedValue({
    razorpayOrderId: "order_mock123456",
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

// Mock the prisma client fully
jest.mock("../src/config/prisma", () => ({
  __esModule: true,
  default: {
    customer: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    worker: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    job: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    job_requirement: {
      create: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    job_dispatch: {
      updateMany: jest.fn(),
    },
    booking: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    worker_location: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
    payment: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    review: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    skill_category: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    worker_document: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
  },
}));

import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { dispatchQueue, timeoutQueue } from "../src/config/bullmq";
import { generateToken } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";
import * as razorpayProvider from "../src/providers/razorpay/razorpayProvider";

const MOCK_CUSTOMER_ID = "a1b2c3d4-e5f6-4890-a234-56789abcdef0";
const MOCK_WORKER_ID = "11b2c3d4-e5f6-4890-a234-56789abcdef1";
const MOCK_ADMIN_ID = "22b2c3d4-e5f6-4890-a234-56789abcdef2";
const MOCK_BOOKING_ID = "33b2c3d4-e5f6-4890-a234-56789abcdef3";

describe("API Protection and JWT Validation Tests", () => {
  let customerToken: string;
  let workerToken: string;
  let adminToken: string;

  beforeAll(() => {
    customerToken = generateToken({ id: MOCK_CUSTOMER_ID, phone: "+919876543210", role: UserRole.CUSTOMER });
    workerToken = generateToken({ id: MOCK_WORKER_ID, phone: "+919999999999", role: UserRole.WORKER });
    adminToken = generateToken({ id: MOCK_ADMIN_ID, phone: "+918888888888", role: UserRole.ADMIN });
  });

  beforeEach(() => {
    // Re-apply mock implementations before each test to prevent resetMocks from discarding them
    (dispatchQueue.add as jest.Mock).mockResolvedValue({});
    (timeoutQueue.add as jest.Mock).mockResolvedValue({});
    (razorpayProvider.createOrder as jest.Mock).mockResolvedValue({
      razorpayOrderId: "order_mock123456",
      amount: 50000,
      currency: "INR",
    });

    (prisma.$transaction as jest.Mock).mockImplementation((cb) => cb(prisma));
    (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);

    (prisma.customer.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.customer.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.customer.create as jest.Mock).mockResolvedValue({});

    (prisma.worker.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.worker.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.worker.create as jest.Mock).mockResolvedValue({});
    (prisma.worker.update as jest.Mock).mockResolvedValue({});

    (prisma.job.create as jest.Mock).mockResolvedValue({});
    (prisma.job.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.job.findUnique as jest.Mock).mockResolvedValue(null);
    (prisma.job.update as jest.Mock).mockResolvedValue({});

    (prisma.job_requirement.create as jest.Mock).mockResolvedValue({});
    (prisma.job_requirement.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.job_requirement.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    (prisma.job_dispatch.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.booking.findUnique as jest.Mock).mockResolvedValue(null);

    (prisma.worker_location.create as jest.Mock).mockResolvedValue({});

    (prisma.payment.create as jest.Mock).mockResolvedValue({});
    (prisma.payment.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.payment.update as jest.Mock).mockResolvedValue({});
    (prisma.payment.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    (prisma.review.create as jest.Mock).mockResolvedValue({});
    (prisma.review.findMany as jest.Mock).mockResolvedValue([]);

    (prisma.skill_category.create as jest.Mock).mockResolvedValue({});
    (prisma.skill_category.findMany as jest.Mock).mockResolvedValue([]);

    (prisma.worker_document.findMany as jest.Mock).mockResolvedValue([{ id: "doc-uuid", status: "PENDING", worker_id: MOCK_WORKER_ID }]);
    (prisma.worker_document.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("Customer Endpoints (/api/clients)", () => {
    it("GET /api/clients should return 401 when unauthenticated", async () => {
      const res = await request(app).get("/api/clients");
      expect(res.status).toBe(401);
    });

    it("GET /api/clients should return 200 when authenticated", async () => {
      (prisma.customer.findMany as jest.Mock).mockResolvedValue([]);
      const res = await request(app)
        .get("/api/clients")
        .set("Authorization", `Bearer ${customerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("POST /api/clients/add should return 401 when unauthenticated", async () => {
      const res = await request(app).post("/api/clients/add").send({ name: "Jane", phone: "+919876543215" });
      expect(res.status).toBe(401);
    });

    it("POST /api/clients/add should return 201 when authenticated", async () => {
      const mockCustomer = { id: MOCK_CUSTOMER_ID, name: "Jane", phone: "+919876543215" };
      (prisma.customer.create as jest.Mock).mockResolvedValue(mockCustomer);
      const res = await request(app)
        .post("/api/clients/add")
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ name: "Jane", phone: "+919876543215" });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });
  });

  describe("Job Endpoints (/api/jobs)", () => {
    it("POST /api/jobs should return 401 when unauthenticated", async () => {
      const res = await request(app).post("/api/jobs").send({ customer_id: MOCK_CUSTOMER_ID, latitude: 12.34, longitude: 56.78 });
      expect(res.status).toBe(401);
    });

    it("POST /api/jobs should return 201 when authenticated", async () => {
      const mockJob = { id: "job-uuid", customer_id: MOCK_CUSTOMER_ID, status: "OPEN" };
      (prisma.job.create as jest.Mock).mockResolvedValue(mockJob);
      (prisma.job_requirement.findMany as jest.Mock).mockResolvedValue([]);
      const res = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ customer_id: MOCK_CUSTOMER_ID, latitude: 12.34, longitude: 56.78, requirements: [] });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it("GET /api/jobs should return 401 when unauthenticated", async () => {
      const res = await request(app).get("/api/jobs");
      expect(res.status).toBe(401);
    });

    it("GET /api/jobs should return 200 when authenticated", async () => {
      (prisma.job.findMany as jest.Mock).mockResolvedValue([]);
      const res = await request(app)
        .get("/api/jobs")
        .set("Authorization", `Bearer ${customerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("GET /api/jobs/:jobId should return 401 when unauthenticated", async () => {
      const res = await request(app).get(`/api/jobs/${MOCK_BOOKING_ID}`);
      expect(res.status).toBe(401);
    });

    it("GET /api/jobs/:jobId should return 200 when authenticated", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({ id: MOCK_BOOKING_ID });
      const res = await request(app)
        .get(`/api/jobs/${MOCK_BOOKING_ID}`)
        .set("Authorization", `Bearer ${customerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("PATCH /api/jobs/:jobId/cancel should return 401 when unauthenticated", async () => {
      const res = await request(app).patch(`/api/jobs/${MOCK_BOOKING_ID}/cancel`);
      expect(res.status).toBe(401);
    });

    it("PATCH /api/jobs/:jobId/cancel should return 200 when authenticated", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({ id: MOCK_BOOKING_ID, customer_id: MOCK_CUSTOMER_ID });
      (prisma.job.update as jest.Mock).mockResolvedValue({ id: MOCK_BOOKING_ID, status: "CANCELLED" });
      const res = await request(app)
        .patch(`/api/jobs/${MOCK_BOOKING_ID}/cancel`)
        .set("Authorization", `Bearer ${customerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("Worker Location Endpoints (/api/worker_location)", () => {
    it("POST /api/worker_location/add should return 401 when unauthenticated", async () => {
      const res = await request(app).post("/api/worker_location/add").send({ latitude: 12.34, longitude: 56.78 });
      expect(res.status).toBe(401);
    });

    it("POST /api/worker_location/add should return 403 when authenticated as customer", async () => {
      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ latitude: 12.34, longitude: 56.78 });
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Forbidden");
    });

    it("POST /api/worker_location/add should return 200 when authenticated as worker", async () => {
      (prisma.worker.findUnique as jest.Mock).mockResolvedValue({ id: MOCK_WORKER_ID, deleted_at: null });
      (prisma.worker_location.create as jest.Mock).mockResolvedValue({ id: "loc-uuid" });
      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${workerToken}`)
        .send({ latitude: 12.34, longitude: 56.78 });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("Skill Endpoints (/api/skill)", () => {
    it("POST /api/skill/add should return 401 when unauthenticated", async () => {
      const res = await request(app).post("/api/skill/add").send({ name: "Carpentry" });
      expect(res.status).toBe(401);
    });

    it("POST /api/skill/add should return 403 when authenticated as customer", async () => {
      const res = await request(app)
        .post("/api/skill/add")
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ name: "Carpentry" });
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Forbidden");
    });

    it("POST /api/skill/add should return 403 when authenticated as worker", async () => {
      const res = await request(app)
        .post("/api/skill/add")
        .set("Authorization", `Bearer ${workerToken}`)
        .send({ name: "Carpentry" });
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Forbidden");
    });

    it("POST /api/skill/add should return 200 when authenticated as admin", async () => {
      (prisma.skill_category.create as jest.Mock).mockResolvedValue({ id: "skill-uuid", name: "Carpentry" });
      const res = await request(app)
        .post("/api/skill/add")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Carpentry" });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("GET /api/skill (public) should return 200 without token", async () => {
      (prisma.skill_category.findMany as jest.Mock).mockResolvedValue([]);
      const res = await request(app).get("/api/skill");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("Payment Endpoints (/api/payments)", () => {
    it("POST /api/payments/:bookingId/create-order should return 401 when unauthenticated", async () => {
      const res = await request(app).post(`/api/payments/${MOCK_BOOKING_ID}/create-order`).send({ booking_id: MOCK_BOOKING_ID, amount: 500 });
      expect(res.status).toBe(401);
    });

    it("POST /api/payments/:bookingId/create-order should return 201 when authenticated", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: MOCK_BOOKING_ID,
        customer_id: MOCK_CUSTOMER_ID,
        worker_id: MOCK_WORKER_ID,
        status: "confirmed",
        job_requirement: { rate_per_day: 500 }
      });
      (prisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.payment.create as jest.Mock).mockResolvedValue({
        id: "payment-uuid",
        razorpay_order_id: "order_mock123456",
        status: "PENDING",
        amount: 50000,
        currency: "INR",
        booking_id: MOCK_BOOKING_ID,
      });
      const res = await request(app)
        .post(`/api/payments/${MOCK_BOOKING_ID}/create-order`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({});
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });

    it("GET /api/payments/:bookingId should return 401 when unauthenticated", async () => {
      const res = await request(app).get(`/api/payments/${MOCK_BOOKING_ID}`);
      expect(res.status).toBe(401);
    });

    it("GET /api/payments/:bookingId should return 200 when authenticated", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: MOCK_BOOKING_ID,
        customer_id: MOCK_CUSTOMER_ID,
      });
      (prisma.payment.findUnique as jest.Mock).mockResolvedValue({
        id: "payment-uuid",
        booking_id: MOCK_BOOKING_ID,
        status: "CREATED",
        amount: 50000,
        currency: "INR"
      });
      const res = await request(app)
        .get(`/api/payments/${MOCK_BOOKING_ID}`)
        .set("Authorization", `Bearer ${customerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("Review Endpoints (/api/reviews)", () => {
    it("POST /api/reviews/:bookingId should return 401 when unauthenticated", async () => {
      const res = await request(app).post(`/api/reviews/${MOCK_BOOKING_ID}`).send({
        rating: 5,
        comment: "Great!"
      });
      expect(res.status).toBe(401);
    });

    it("POST /api/reviews/:bookingId should return 201 when authenticated", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: MOCK_BOOKING_ID,
        customer_id: MOCK_CUSTOMER_ID,
        worker_id: MOCK_WORKER_ID,
        status: "COMPLETED"
      });
      (prisma.review.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.review.create as jest.Mock).mockResolvedValue({
        id: "review-uuid",
        booking_id: MOCK_BOOKING_ID,
        customer_id: MOCK_CUSTOMER_ID,
        worker_id: MOCK_WORKER_ID,
        rating: 5,
        comment: "Great!"
      });
      const res = await request(app)
        .post(`/api/reviews/${MOCK_BOOKING_ID}`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({
          rating: 5,
          comment: "Great!"
        });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
    });
  });

  describe("Admin RBAC Authorization Matrix (/api/admin)", () => {
    describe("GET /api/admin/workers", () => {
      it("should return 401 when unauthenticated", async () => {
        const res = await request(app).get("/api/admin/workers");
        expect(res.status).toBe(401);
      });

      it("should return 403 when authenticated as customer", async () => {
        const res = await request(app)
          .get("/api/admin/workers")
          .set("Authorization", `Bearer ${customerToken}`);
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain("Forbidden");
      });

      it("should return 403 when authenticated as worker", async () => {
        const res = await request(app)
          .get("/api/admin/workers")
          .set("Authorization", `Bearer ${workerToken}`);
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain("Forbidden");
      });

      it("should return 403 when customer attempts role spoofing via query param ?role=admin", async () => {
        const res = await request(app)
          .get("/api/admin/workers?role=admin")
          .set("Authorization", `Bearer ${customerToken}`);
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("should return 403 when worker attempts role spoofing via query param ?role=admin", async () => {
        const res = await request(app)
          .get("/api/admin/workers?role=admin")
          .set("Authorization", `Bearer ${workerToken}`);
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("should return 200 when authenticated as admin", async () => {
        (prisma.worker.findMany as jest.Mock).mockResolvedValue([]);
        const res = await request(app)
          .get("/api/admin/workers")
          .set("Authorization", `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.data)).toBe(true);
      });
    });

    describe("PATCH /api/admin/workers/:id/verify", () => {
      it("should return 401 when unauthenticated", async () => {
        const res = await request(app)
          .patch(`/api/admin/workers/${MOCK_WORKER_ID}/verify`)
          .send({ status: "VERIFIED" });
        expect(res.status).toBe(401);
      });

      it("should return 403 when customer attempts verification AND NOT modify database", async () => {
        const res = await request(app)
          .patch(`/api/admin/workers/${MOCK_WORKER_ID}/verify`)
          .set("Authorization", `Bearer ${customerToken}`)
          .send({ status: "VERIFIED" });
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(prisma.worker.update).not.toHaveBeenCalled();
        expect(prisma.worker_document.updateMany).not.toHaveBeenCalled();
      });

      it("should return 403 when worker attempts verification AND NOT modify database", async () => {
        const res = await request(app)
          .patch(`/api/admin/workers/${MOCK_WORKER_ID}/verify`)
          .set("Authorization", `Bearer ${workerToken}`)
          .send({ status: "VERIFIED" });
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(prisma.worker.update).not.toHaveBeenCalled();
        expect(prisma.worker_document.updateMany).not.toHaveBeenCalled();
      });

      it("should return 403 when customer attempts role spoofing in body AND NOT modify database", async () => {
        const res = await request(app)
          .patch(`/api/admin/workers/${MOCK_WORKER_ID}/verify`)
          .set("Authorization", `Bearer ${customerToken}`)
          .send({ status: "VERIFIED", role: "admin" });
        expect(res.status).toBe(403);
        expect(prisma.worker.update).not.toHaveBeenCalled();
        expect(prisma.worker_document.updateMany).not.toHaveBeenCalled();
      });

      it("should return 200 when authenticated as admin and successfully update verification", async () => {
        const updatedWorker = { id: MOCK_WORKER_ID, verification_status: "verified" };
        (prisma.worker.update as jest.Mock).mockResolvedValue(updatedWorker);

        const res = await request(app)
          .patch(`/api/admin/workers/${MOCK_WORKER_ID}/verify`)
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ status: "VERIFIED" });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(prisma.worker.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: MOCK_WORKER_ID },
            data: { verification_status: "verified" },
          })
        );
      });
    });

    describe("GET /api/admin/jobs", () => {
      it("should return 401 when unauthenticated", async () => {
        const res = await request(app).get("/api/admin/jobs");
        expect(res.status).toBe(401);
      });

      it("should return 403 when authenticated as customer", async () => {
        const res = await request(app)
          .get("/api/admin/jobs")
          .set("Authorization", `Bearer ${customerToken}`);
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("should return 403 when authenticated as worker", async () => {
        const res = await request(app)
          .get("/api/admin/jobs")
          .set("Authorization", `Bearer ${workerToken}`);
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("should return 200 when authenticated as admin", async () => {
        (prisma.job.findMany as jest.Mock).mockResolvedValue([]);
        const res = await request(app)
          .get("/api/admin/jobs")
          .set("Authorization", `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });
    });

    describe("GET /api/admin/flagged", () => {
      it("should return 401 when unauthenticated", async () => {
        const res = await request(app).get("/api/admin/flagged");
        expect(res.status).toBe(401);
      });

      it("should return 403 when authenticated as customer", async () => {
        const res = await request(app)
          .get("/api/admin/flagged")
          .set("Authorization", `Bearer ${customerToken}`);
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("should return 403 when authenticated as worker", async () => {
        const res = await request(app)
          .get("/api/admin/flagged")
          .set("Authorization", `Bearer ${workerToken}`);
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
      });

      it("should return 200 when authenticated as admin", async () => {
        (prisma.worker.findMany as jest.Mock).mockResolvedValue([]);
        const res = await request(app)
          .get("/api/admin/flagged")
          .set("Authorization", `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });
    });

    describe("POST /api/admin/workers/:id/suspend", () => {
      it("should return 401 when unauthenticated", async () => {
        const res = await request(app)
          .post(`/api/admin/workers/${MOCK_WORKER_ID}/suspend`)
          .send({ reason: "Unprofessional conduct" });
        expect(res.status).toBe(401);
      });

      it("should return 403 when customer attempts suspension AND NOT modify database", async () => {
        const res = await request(app)
          .post(`/api/admin/workers/${MOCK_WORKER_ID}/suspend`)
          .set("Authorization", `Bearer ${customerToken}`)
          .send({ reason: "Unprofessional conduct" });
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(prisma.worker.update).not.toHaveBeenCalled();
      });

      it("should return 403 when worker attempts suspension AND NOT modify database", async () => {
        const res = await request(app)
          .post(`/api/admin/workers/${MOCK_WORKER_ID}/suspend`)
          .set("Authorization", `Bearer ${workerToken}`)
          .send({ reason: "Unprofessional conduct" });
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(prisma.worker.update).not.toHaveBeenCalled();
      });

      it("should return 403 when worker attempts role spoofing in body AND NOT modify database", async () => {
        const res = await request(app)
          .post(`/api/admin/workers/${MOCK_WORKER_ID}/suspend`)
          .set("Authorization", `Bearer ${workerToken}`)
          .send({ reason: "Unprofessional conduct", role: "admin" });
        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(prisma.worker.update).not.toHaveBeenCalled();
      });

      it("should return 200 when authenticated as admin and successfully suspend worker", async () => {
        const suspendedWorker = { id: MOCK_WORKER_ID, verification_status: "suspended", deleted_at: new Date() };
        (prisma.worker.update as jest.Mock).mockResolvedValue(suspendedWorker);

        const res = await request(app)
          .post(`/api/admin/workers/${MOCK_WORKER_ID}/suspend`)
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ reason: "Policy violation" });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(prisma.worker.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: MOCK_WORKER_ID },
            data: expect.objectContaining({ verification_status: "suspended" }),
          })
        );
      });
    });

    describe("Token Integrity & Boundary Role Validation", () => {
      it("should return 401 when token has tampered/invalid signature", async () => {
        const tamperedToken = adminToken.slice(0, -5) + "abcde";
        const res = await request(app)
          .get("/api/admin/workers")
          .set("Authorization", `Bearer ${tamperedToken}`);
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain("expired or is invalid");
      });

      it("should return 401 when token contains an invalid/unsupported role claim", async () => {
        const invalidRoleToken = generateToken({
          id: MOCK_CUSTOMER_ID,
          phone: "+919876543210",
          role: "superuser_spoofed" as any,
        });
        const res = await request(app)
          .get("/api/admin/workers")
          .set("Authorization", `Bearer ${invalidRoleToken}`);
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain("invalid or unsupported role claim");
      });

      it("should return 401 when token is missing role claim", async () => {
        const noRoleToken = generateToken({
          id: MOCK_CUSTOMER_ID,
          phone: "+919876543210",
        });
        const res = await request(app)
          .get("/api/admin/workers")
          .set("Authorization", `Bearer ${noRoleToken}`);
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toContain("invalid or unsupported role claim");
      });

      it("should return 401 when token has expired", async () => {
        const expiredToken = generateToken(
          { id: MOCK_ADMIN_ID, phone: "+918888888888", role: UserRole.ADMIN },
          "-1s"
        );
        const res = await request(app)
          .get("/api/admin/workers")
          .set("Authorization", `Bearer ${expiredToken}`);
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
      });
    });
  });
});
