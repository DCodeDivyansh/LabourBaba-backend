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

// Mock BullMQ queue config
jest.mock("../src/config/bullmq", () => ({
  dispatchQueue: {
    add: jest.fn(),
  },
  timeoutQueue: {
    add: jest.fn(),
  },
  connection: {},
}));

// Mock dispatchJobSimple
jest.mock("../src/features/dispatch/simpleDispatch", () => ({
  dispatchJobSimple: jest.fn().mockResolvedValue({}),
}));

// Mock razorpayProvider
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

// Mock Prisma client
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
import { generateToken } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";
import { jobService } from "../src/features/jobs/job.services";
import { adminService } from "../src/features/admin/adminServices";
import { dispatchJobSimple } from "../src/features/dispatch/simpleDispatch";

const CUSTOMER_A_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const CUSTOMER_B_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const WORKER_ID = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
const ADMIN_ID = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
const JOB_ID_A = "11111111-1111-4111-8111-111111111111";
const JOB_ID_B = "22222222-2222-4222-8222-222222222222";

describe("Issue #2 Remediation — Client-Controlled customer_id Removal from Job APIs", () => {
  let customerAToken: string;
  let customerBToken: string;
  let workerToken: string;
  let adminToken: string;

  beforeAll(() => {
    customerAToken = generateToken({ id: CUSTOMER_A_ID, phone: "+919876543210", role: UserRole.CUSTOMER });
    customerBToken = generateToken({ id: CUSTOMER_B_ID, phone: "+919876543211", role: UserRole.CUSTOMER });
    workerToken = generateToken({ id: WORKER_ID, phone: "+919876543212", role: UserRole.WORKER });
    adminToken = generateToken({ id: ADMIN_ID, phone: "+919876543213", role: UserRole.ADMIN });
  });

  beforeEach(() => {
    (dispatchJobSimple as jest.Mock).mockResolvedValue({});
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb) => cb(prisma));
    (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);
    (prisma.job_requirement.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.job.create as jest.Mock).mockResolvedValue({ id: JOB_ID_A, customer_id: CUSTOMER_A_ID });
    (prisma.job.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.job.findUnique as jest.Mock).mockImplementation(async (args?: any) => {
      const id = args?.where?.id;
      if (id === JOB_ID_A || id === "mock-id") {
        return {
          id: id,
          customer_id: CUSTOMER_A_ID,
          status: "OPEN",
          dispatch_status: "PENDING",
          job_requirement: [],
        };
      }
      return null;
    });
    (prisma.job.update as jest.Mock).mockResolvedValue({});
    (prisma.job_requirement.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.job_dispatch.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
  });

  // =========================================================================
  // 1. JOB CREATION AUTHORIZATION & IMMUTABILITY OF OWNERSHIP
  // =========================================================================
  describe("1. POST /api/jobs (Job Creation)", () => {
    it("TEST 1: Customer A creates own job without customer_id -> job.customer_id is set to Customer A", async () => {
      const createdJob = {
        id: JOB_ID_A,
        customer_id: CUSTOMER_A_ID,
        latitude: 12.9716,
        longitude: 77.5946,
        status: "OPEN",
        dispatch_status: "PENDING",
      };
      (prisma.job.create as jest.Mock).mockResolvedValue(createdJob);

      const res = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({
          latitude: 12.9716,
          longitude: 77.5946,
          location: "Bangalore",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.customer_id).toBe(CUSTOMER_A_ID);

      // Verify Prisma was called with Customer A's authenticated principal ID
      expect(prisma.job.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            customer_id: CUSTOMER_A_ID,
          }),
        })
      );
    });

    it("TEST 2: Customer A attempts to inject customer_id = Customer B in body -> rejected by strict schema with 400", async () => {
      const res = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({
          customer_id: CUSTOMER_B_ID,
          latitude: 12.9716,
          longitude: 77.5946,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      // Ensure database was NEVER called
      expect(prisma.job.create).not.toHaveBeenCalled();
    });

    it("TEST 3: Customer A attempts to inject customerId = Customer B in body -> rejected by strict schema with 400", async () => {
      const res = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({
          customerId: CUSTOMER_B_ID,
          latitude: 12.9716,
          longitude: 77.5946,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(prisma.job.create).not.toHaveBeenCalled();
    });

    it("TEST 3b: Customer A attempts to inject ownerId / userId in body -> rejected by strict schema with 400", async () => {
      const res = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${customerAToken}`)
        .send({
          ownerId: CUSTOMER_B_ID,
          userId: CUSTOMER_B_ID,
          latitude: 12.9716,
          longitude: 77.5946,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(prisma.job.create).not.toHaveBeenCalled();
    });

    it("TEST 11a: POST /api/jobs fails with 401 when unauthenticated", async () => {
      const res = await request(app)
        .post("/api/jobs")
        .send({
          latitude: 12.9716,
          longitude: 77.5946,
        });

      expect(res.status).toBe(401);
      expect(prisma.job.create).not.toHaveBeenCalled();
    });

    it("TEST 12a: POST /api/jobs fails with 403 when authenticated as WORKER", async () => {
      const res = await request(app)
        .post("/api/jobs")
        .set("Authorization", `Bearer ${workerToken}`)
        .send({
          latitude: 12.9716,
          longitude: 77.5946,
        });

      expect(res.status).toBe(403);
      expect(prisma.job.create).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 2. GET /api/jobs QUERY PARAMETER INJECTION NEUTRALIZATION
  // =========================================================================
  describe("2. GET /api/jobs (Customer Self-Service Listing)", () => {
    it("TEST 4: Customer A passes ?customer_id=Customer-B -> ignored, returns ONLY Customer A's jobs", async () => {
      const customerAJobs = [
        { id: JOB_ID_A, customer_id: CUSTOMER_A_ID, status: "OPEN" },
      ];
      (prisma.job.findMany as jest.Mock).mockResolvedValue(customerAJobs);

      const res = await request(app)
        .get(`/api/jobs?customer_id=${CUSTOMER_B_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(customerAJobs);

      // Verify Prisma query was strictly scoped to Customer A, ignoring query parameter
      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { customer_id: CUSTOMER_A_ID },
        })
      );
    });

    it("TEST 5: Customer A passes ?customerId=Customer-B -> ignored, returns ONLY Customer A's jobs", async () => {
      const customerAJobs = [
        { id: JOB_ID_A, customer_id: CUSTOMER_A_ID, status: "OPEN" },
      ];
      (prisma.job.findMany as jest.Mock).mockResolvedValue(customerAJobs);

      const res = await request(app)
        .get(`/api/jobs?customerId=${CUSTOMER_B_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { customer_id: CUSTOMER_A_ID },
        })
      );
    });

    it("TEST 6: Customer A calls GET /api/jobs without query parameters -> scoped strictly to Customer A", async () => {
      (prisma.job.findMany as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .get("/api/jobs")
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { customer_id: CUSTOMER_A_ID },
        })
      );
    });

    it("TEST 11b: GET /api/jobs fails with 401 when unauthenticated", async () => {
      const res = await request(app).get("/api/jobs");
      expect(res.status).toBe(401);
      expect(prisma.job.findMany).not.toHaveBeenCalled();
    });

    it("TEST 12b: GET /api/jobs fails with 403 when authenticated as WORKER", async () => {
      const res = await request(app)
        .get("/api/jobs")
        .set("Authorization", `Bearer ${workerToken}`);

      expect(res.status).toBe(403);
      expect(prisma.job.findMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. JOB MUTATION (CANCELLATION) OWNERSHIP ENFORCEMENT
  // =========================================================================
  describe("3. PATCH /api/jobs/:jobId/cancel (Mutation Ownership)", () => {
    it("TEST 7 & 12: Customer A attempts to cancel Customer B's job -> 403 Forbidden, no database update", async () => {
      // Mock findUnique returning Customer B's job
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_ID_B,
        customer_id: CUSTOMER_B_ID,
        status: "OPEN",
      });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_ID_B}/cancel`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Forbidden");

      // Verify job was NOT updated
      expect(prisma.job.update).not.toHaveBeenCalled();
    });

    it("Customer A cancels own job -> 200 Success and status updated to CANCELLED", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_ID_A,
        customer_id: CUSTOMER_A_ID,
        status: "OPEN",
      });
      (prisma.job.update as jest.Mock).mockResolvedValue({
        id: JOB_ID_A,
        status: "CANCELLED",
      });
      (prisma.job_requirement.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.job_requirement.findMany as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .patch(`/api/jobs/${JOB_ID_A}/cancel`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(prisma.job.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: JOB_ID_A },
          data: expect.objectContaining({ status: "CANCELLED" }),
        })
      );
    });

    it("TEST 11c: PATCH /api/jobs/:jobId/cancel fails with 401 when unauthenticated", async () => {
      const res = await request(app).patch(`/api/jobs/${JOB_ID_A}/cancel`);
      expect(res.status).toBe(401);
      expect(prisma.job.update).not.toHaveBeenCalled();
    });

    it("TEST 12c: PATCH /api/jobs/:jobId/cancel fails with 403 when authenticated as WORKER", async () => {
      const res = await request(app)
        .patch(`/api/jobs/${JOB_ID_A}/cancel`)
        .set("Authorization", `Bearer ${workerToken}`);

      expect(res.status).toBe(403);
      expect(prisma.job.update).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. ADMIN CROSS-CUSTOMER SEARCH ISOLATION
  // =========================================================================
  describe("4. GET /api/admin/jobs (Admin Cross-Customer Search)", () => {
    it("TEST 8: Admin can search for Customer B's jobs with ?customer_id filter -> 200 with filtered results", async () => {
      const mockJobs = [
        {
          id: JOB_ID_B,
          customer_id: CUSTOMER_B_ID,
          status: "OPEN",
          customer: { id: CUSTOMER_B_ID, name: "Customer B", phone: "+919876543211" },
          job_requirement: [],
        },
      ];
      (prisma.job.findMany as jest.Mock).mockResolvedValue(mockJobs);

      const res = await request(app)
        .get(`/api/admin/jobs?customer_id=${CUSTOMER_B_ID}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { customer_id: CUSTOMER_B_ID },
        })
      );
    });

    it("TEST 8b: Admin can fetch all jobs platform-wide when no customer_id filter is provided", async () => {
      (prisma.job.findMany as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .get("/api/admin/jobs")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: undefined,
        })
      );
    });

    it("TEST 9: Customer A cannot access admin cross-customer search -> 403 Forbidden", async () => {
      const res = await request(app)
        .get(`/api/admin/jobs?customer_id=${CUSTOMER_B_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(prisma.job.findMany).not.toHaveBeenCalled();
    });

    it("TEST 10: Worker cannot access admin cross-customer search -> 403 Forbidden", async () => {
      const res = await request(app)
        .get(`/api/admin/jobs?customer_id=${CUSTOMER_B_ID}`)
        .set("Authorization", `Bearer ${workerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(prisma.job.findMany).not.toHaveBeenCalled();
    });

    it("TEST 11d: Admin job search fails with 401 when unauthenticated", async () => {
      const res = await request(app).get(`/api/admin/jobs?customer_id=${CUSTOMER_B_ID}`);
      expect(res.status).toBe(401);
      expect(prisma.job.findMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 5. SERVICE-LAYER SECURITY INVARIANTS
  // =========================================================================
  describe("5. Service-Layer Ownership Invariants", () => {
    it("TEST 13a: jobService.createJob always binds customer_id to authenticated parameter", async () => {
      (prisma.job.create as jest.Mock).mockResolvedValue({ id: "mock-id", customer_id: CUSTOMER_A_ID });

      await jobService.createJob(CUSTOMER_A_ID, {
        latitude: 12.34,
        longitude: 56.78,
      });

      expect(prisma.job.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            customer_id: CUSTOMER_A_ID,
          }),
        })
      );
    });

    it("TEST 13b: jobService.getJobsByCustomer queries strictly by customer_id", async () => {
      (prisma.job.findMany as jest.Mock).mockResolvedValue([]);

      await jobService.getJobsByCustomer(CUSTOMER_A_ID);

      expect(prisma.job.findMany).toHaveBeenCalledWith({
        where: { customer_id: CUSTOMER_A_ID },
        include: { job_requirement: true },
      });
    });

    it("TEST 13c: jobService.cancelJob throws error when caller is not the owner", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_ID_B,
        customer_id: CUSTOMER_B_ID,
        status: "OPEN",
      });

      await expect(jobService.cancelJob(JOB_ID_B, CUSTOMER_A_ID)).rejects.toThrow(
        "Forbidden: You do not own this job"
      );
    });

    it("TEST 13d: adminService.getAllJobs with customerId applies where: { customer_id }", async () => {
      (prisma.job.findMany as jest.Mock).mockResolvedValue([]);

      await adminService.getAllJobs(CUSTOMER_B_ID);

      expect(prisma.job.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { customer_id: CUSTOMER_B_ID },
        })
      );
    });
  });
});
