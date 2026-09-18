import request from "supertest";
import { UserRole } from "../src/type/userRole";
import { generateToken } from "../src/utils/authUtils";

// Mock BullMQ and queues to prevent Redis connections during test server startup
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

// Mock Prisma
jest.mock("../src/config/prisma", () => ({
  __esModule: true,
  default: {
    customer: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    worker: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    job: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    job_requirement: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    booking: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    job_dispatch: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    dispatch_wave: {
      findMany: jest.fn(),
    },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([]),
  },
}));

import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { jobService } from "../src/features/jobs/job.services";
import { jobReqService } from "../src/features/jobs/jobReqServices";
import { dispatchService } from "../src/features/dispatch/dispatchServices";

describe("Issue #5 — Protect Job Detail and Requirements (P1 Security / IDOR)", () => {
  const CUSTOMER_A_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const CUSTOMER_B_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  const WORKER_A_ID = "11111111-1111-4111-a111-111111111111"; // Assigned/booked on Job A
  const WORKER_B_ID = "22222222-2222-4222-a222-222222222222"; // Unrelated to Job A
  const WORKER_C_ID = "33333333-3333-4333-a333-333333333333"; // Another worker on Job A
  const ADMIN_ID = "99999999-9999-4999-a999-999999999999";

  const JOB_A_ID = "aaaa1111-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const JOB_B_ID = "bbbb1111-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  const REQ_A1_ID = "aaaa2222-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const REQ_B1_ID = "bbbb2222-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  const BOOKING_A1_ID = "aaaa3333-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const BOOKING_A2_ID = "aaaa4444-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

  let customerAToken: string;
  let customerBToken: string;
  let workerAToken: string;
  let workerBToken: string;
  let adminToken: string;

  beforeAll(() => {
    customerAToken = generateToken({ id: CUSTOMER_A_ID, phone: "+919876543210", role: UserRole.CUSTOMER });
    customerBToken = generateToken({ id: CUSTOMER_B_ID, phone: "+919876543211", role: UserRole.CUSTOMER });
    workerAToken = generateToken({ id: WORKER_A_ID, phone: "+919876543212", role: UserRole.WORKER });
    workerBToken = generateToken({ id: WORKER_B_ID, phone: "+919876543213", role: UserRole.WORKER });
    adminToken = generateToken({ id: ADMIN_ID, phone: "+919876543214", role: UserRole.ADMIN });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(prisma));
  });

  // =========================================================================
  // 1. GET /api/jobs/:jobId (Job Detail Protection)
  // =========================================================================
  describe("1. GET /api/jobs/:jobId (Job Detail)", () => {
    it("Customer A CAN retrieve their own Job detail (200 with DTO)", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        status: "OPEN",
        booking: [{ worker_id: WORKER_A_ID }],
        job_requirement: [{ id: REQ_A1_ID, job_dispatch: [] }],
      });

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(JOB_A_ID);
      expect(res.body.data.customer_id).toBe(CUSTOMER_A_ID);
    });

    it("Customer B CANNOT retrieve Customer A's Job detail by UUID (404 IDOR protection)", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        status: "OPEN",
        booking: [{ worker_id: WORKER_A_ID }],
        job_requirement: [],
      });

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}`)
        .set("Authorization", `Bearer ${customerBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Job not found");
    });

    it("Worker A (assigned to Job A) CAN retrieve Job A detail", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        status: "OPEN",
        booking: [{ worker_id: WORKER_A_ID }],
        job_requirement: [{ id: REQ_A1_ID, job_dispatch: [] }],
      });

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}`)
        .set("Authorization", `Bearer ${workerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(JOB_A_ID);
    });

    it("Worker B (unrelated worker) CANNOT retrieve Job A detail (404 IDOR protection)", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        status: "OPEN",
        booking: [{ worker_id: WORKER_A_ID }],
        job_requirement: [{ id: REQ_A1_ID, job_dispatch: [{ worker_id: WORKER_A_ID }] }],
      });

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}`)
        .set("Authorization", `Bearer ${workerBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Job not found");
    });

    it("Admin CAN retrieve any Job detail", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        status: "OPEN",
        booking: [],
        job_requirement: [],
      });

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("Malformed jobId returns 400 Bad Request without calling database", async () => {
      const res = await request(app)
        .get("/api/jobs/not-a-valid-uuid")
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Validation failed");
      expect(prisma.job.findUnique).not.toHaveBeenCalled();
    });

    it("Unauthenticated request returns 401 Unauthorized", async () => {
      const res = await request(app).get(`/api/jobs/${JOB_A_ID}`);
      expect(res.status).toBe(401);
      expect(prisma.job.findUnique).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 2. GET /api/jobs/:jobId/requirements (Requirements List Protection)
  // =========================================================================
  describe("2. GET /api/jobs/:jobId/requirements (Requirements List)", () => {
    it("Customer A CAN list requirements of own Job A", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        booking: [],
        job_requirement: [],
      });
      (prisma.job_requirement.findMany as jest.Mock).mockResolvedValue([
        { id: REQ_A1_ID, job_id: JOB_A_ID, skill_type: "Plumber", worker_count_needed: 2 },
      ]);

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}/requirements`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(REQ_A1_ID);
    });

    it("Customer B CANNOT list requirements of Customer A's Job (404 IDOR protection)", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        booking: [],
        job_requirement: [],
      });

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}/requirements`)
        .set("Authorization", `Bearer ${customerBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(prisma.job_requirement.findMany).not.toHaveBeenCalled();
    });

    it("Worker A (assigned/booked) CAN list requirements of Job A", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        booking: [{ worker_id: WORKER_A_ID }],
        job_requirement: [{ id: REQ_A1_ID, job_dispatch: [] }],
      });
      (prisma.job_requirement.findMany as jest.Mock).mockResolvedValue([
        { id: REQ_A1_ID, job_id: JOB_A_ID, skill_type: "Plumber", worker_count_needed: 2 },
      ]);

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}/requirements`)
        .set("Authorization", `Bearer ${workerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data[0].id).toBe(REQ_A1_ID);
    });

    it("Worker B (unrelated) CANNOT list requirements of Job A (404 IDOR protection)", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        booking: [{ worker_id: WORKER_A_ID }],
        job_requirement: [{ id: REQ_A1_ID, job_dispatch: [{ worker_id: WORKER_A_ID }] }],
      });

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}/requirements`)
        .set("Authorization", `Bearer ${workerBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(prisma.job_requirement.findMany).not.toHaveBeenCalled();
    });

    it("Admin CAN list requirements of any Job", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        booking: [],
        job_requirement: [],
      });
      (prisma.job_requirement.findMany as jest.Mock).mockResolvedValue([
        { id: REQ_A1_ID, job_id: JOB_A_ID, skill_type: "Plumber", worker_count_needed: 2 },
      ]);

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}/requirements`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // =========================================================================
  // 3. GET /api/jobs/:jobId/requirements/:requirementId (Individual Requirement)
  // =========================================================================
  describe("3. GET /api/jobs/:jobId/requirements/:requirementId (Single Requirement Detail)", () => {
    it("Customer A CAN retrieve requirement belonging to their own Job", async () => {
      (prisma.job_requirement.findFirst as jest.Mock).mockResolvedValue({
        id: REQ_A1_ID,
        job_id: JOB_A_ID,
        skill_type: "Electrician",
        worker_count_needed: 1,
        job: { customer_id: CUSTOMER_A_ID },
        job_dispatch: [],
        booking: [],
      });

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}/requirements/${REQ_A1_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(REQ_A1_ID);
    });

    it("Customer B CANNOT retrieve Customer A's requirement by UUID (404 IDOR protection)", async () => {
      (prisma.job_requirement.findFirst as jest.Mock).mockResolvedValue({
        id: REQ_A1_ID,
        job_id: JOB_A_ID,
        skill_type: "Electrician",
        worker_count_needed: 1,
        job: { customer_id: CUSTOMER_A_ID },
        job_dispatch: [],
        booking: [],
      });

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}/requirements/${REQ_A1_ID}`)
        .set("Authorization", `Bearer ${customerBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Requirement not found");
    });

    it("Worker A (booked on requirement) CAN retrieve requirement detail", async () => {
      (prisma.job_requirement.findFirst as jest.Mock).mockResolvedValue({
        id: REQ_A1_ID,
        job_id: JOB_A_ID,
        skill_type: "Electrician",
        worker_count_needed: 1,
        job: { customer_id: CUSTOMER_A_ID },
        job_dispatch: [],
        booking: [{ worker_id: WORKER_A_ID }],
      });

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}/requirements/${REQ_A1_ID}`)
        .set("Authorization", `Bearer ${workerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(REQ_A1_ID);
    });

    it("Worker B (unrelated) CANNOT retrieve requirement detail (404 IDOR protection)", async () => {
      (prisma.job_requirement.findFirst as jest.Mock).mockResolvedValue({
        id: REQ_A1_ID,
        job_id: JOB_A_ID,
        skill_type: "Electrician",
        worker_count_needed: 1,
        job: { customer_id: CUSTOMER_A_ID },
        job_dispatch: [{ worker_id: WORKER_A_ID }],
        booking: [{ worker_id: WORKER_A_ID }],
      });

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}/requirements/${REQ_A1_ID}`)
        .set("Authorization", `Bearer ${workerBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Requirement not found");
    });

    it("Mismatched requirement and job returns 404", async () => {
      (prisma.job_requirement.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}/requirements/${REQ_B1_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it("Malformed requirementId returns 400 Bad Request", async () => {
      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}/requirements/invalid-uuid-string`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(prisma.job_requirement.findFirst).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. GET /api/jobs/:jobId/bookings (Job Booking List Isolation)
  // =========================================================================
  describe("4. GET /api/jobs/:jobId/bookings (Job Booking List & Isolation)", () => {
    it("Customer A CAN list all bookings for their own Job A", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        booking: [{ worker_id: WORKER_A_ID }, { worker_id: WORKER_C_ID }],
        job_requirement: [],
      });
      (prisma.booking.findMany as jest.Mock).mockResolvedValue([
        { id: BOOKING_A1_ID, job_id: JOB_A_ID, worker_id: WORKER_A_ID, status: "CONFIRMED" },
        { id: BOOKING_A2_ID, job_id: JOB_A_ID, worker_id: WORKER_C_ID, status: "CONFIRMED" },
      ]);

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}/bookings`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { job_id: JOB_A_ID } })
      );
    });

    it("Customer B CANNOT list bookings for Customer A's Job (404 IDOR protection)", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        booking: [{ worker_id: WORKER_A_ID }],
        job_requirement: [],
      });

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}/bookings`)
        .set("Authorization", `Bearer ${customerBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(prisma.booking.findMany).not.toHaveBeenCalled();
    });

    it("Worker A (assigned to Job A) ONLY sees their own booking, NOT other workers' bookings", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        booking: [{ worker_id: WORKER_A_ID }, { worker_id: WORKER_C_ID }],
        job_requirement: [],
      });
      // Mock findMany returning only Worker A's booking
      (prisma.booking.findMany as jest.Mock).mockResolvedValue([
        { id: BOOKING_A1_ID, job_id: JOB_A_ID, worker_id: WORKER_A_ID, status: "CONFIRMED" },
      ]);

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}/bookings`)
        .set("Authorization", `Bearer ${workerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].worker_id).toBe(WORKER_A_ID);

      // Verify Prisma query was strictly filtered to worker_id = Worker A
      expect(prisma.booking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { job_id: JOB_A_ID, worker_id: WORKER_A_ID },
        })
      );
    });

    it("Worker B (unrelated) CANNOT list bookings for Job A (404 IDOR protection)", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        booking: [{ worker_id: WORKER_A_ID }],
        job_requirement: [],
      });

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}/bookings`)
        .set("Authorization", `Bearer ${workerBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(prisma.booking.findMany).not.toHaveBeenCalled();
    });

    it("Admin CAN list all bookings for any Job", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        booking: [{ worker_id: WORKER_A_ID }],
        job_requirement: [],
      });
      (prisma.booking.findMany as jest.Mock).mockResolvedValue([
        { id: BOOKING_A1_ID, job_id: JOB_A_ID, worker_id: WORKER_A_ID, status: "CONFIRMED" },
      ]);

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}/bookings`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // =========================================================================
  // 5. GET /api/dispatch/:requirementId/waves (Dispatch Wave Protection)
  // =========================================================================
  describe("5. GET /api/dispatch/:requirementId/waves (Wave History Protection)", () => {
    it("Customer A (job owner) CAN view waves for their own requirement", async () => {
      (prisma.job_requirement.findUnique as jest.Mock).mockResolvedValue({
        id: REQ_A1_ID,
        job: { customer_id: CUSTOMER_A_ID },
      });
      (prisma.dispatch_wave.findMany as jest.Mock).mockResolvedValue([
        { id: "wave-1", requirement_id: REQ_A1_ID, wave_number: 1, status: "COMPLETED" },
      ]);
      (prisma.job_dispatch.findMany as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .get(`/api/dispatch/${REQ_A1_ID}/waves`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.waves).toHaveLength(1);
    });

    it("Customer B CANNOT view wave history for Customer A's requirement (404 IDOR protection)", async () => {
      (prisma.job_requirement.findUnique as jest.Mock).mockResolvedValue({
        id: REQ_A1_ID,
        job: { customer_id: CUSTOMER_A_ID },
      });

      const res = await request(app)
        .get(`/api/dispatch/${REQ_A1_ID}/waves`)
        .set("Authorization", `Bearer ${customerBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Requirement not found");
    });

    it("Worker B (unrelated worker) CANNOT view wave history (404 IDOR protection)", async () => {
      (prisma.job_requirement.findUnique as jest.Mock).mockResolvedValue({
        id: REQ_A1_ID,
        job: { customer_id: CUSTOMER_A_ID },
      });

      const res = await request(app)
        .get(`/api/dispatch/${REQ_A1_ID}/waves`)
        .set("Authorization", `Bearer ${workerBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("Requirement not found");
    });

    it("Admin CAN view wave history for any requirement", async () => {
      (prisma.job_requirement.findUnique as jest.Mock).mockResolvedValue({
        id: REQ_A1_ID,
        job: { customer_id: CUSTOMER_A_ID },
      });
      (prisma.dispatch_wave.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.job_dispatch.findMany as jest.Mock).mockResolvedValue([]);

      const res = await request(app)
        .get(`/api/dispatch/${REQ_A1_ID}/waves`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("Malformed requirementId in waves endpoint returns 400 Bad Request", async () => {
      const res = await request(app)
        .get("/api/dispatch/invalid-uuid/waves")
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(prisma.dispatch_wave.findMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 6. Service-Layer Direct Authorization Invariants
  // =========================================================================
  describe("6. Service-Layer Direct Authorization Invariants", () => {
    it("jobService.getJobDetail throws 401 when actor is missing", async () => {
      await expect(jobService.getJobDetail(JOB_A_ID, undefined)).rejects.toThrow(
        "Authentication required"
      );
    });

    it("jobService.getJobRequirements throws 401 when actor is missing", async () => {
      await expect(jobService.getJobRequirements(JOB_A_ID, undefined)).rejects.toThrow(
        "Authentication required"
      );
    });

    it("jobService.getJobBookings throws 401 when actor is missing", async () => {
      await expect(jobService.getJobBookings(JOB_A_ID, undefined)).rejects.toThrow(
        "Authentication required"
      );
    });

    it("jobReqService.getRequirementDetail throws 401 when actor is missing", async () => {
      await expect(jobReqService.getRequirementDetail(JOB_A_ID, REQ_A1_ID, undefined)).rejects.toThrow(
        "Authentication required"
      );
    });

    it("dispatchService.getWaves throws 404 when customer does not own requirement", async () => {
      (prisma.job_requirement.findUnique as jest.Mock).mockResolvedValue({
        id: REQ_A1_ID,
        job: { customer_id: CUSTOMER_A_ID },
      });

      await expect(
        dispatchService.getWaves(REQ_A1_ID, {
          id: CUSTOMER_B_ID,
          role: UserRole.CUSTOMER,
          phone: "+919876543211",
        })
      ).rejects.toThrow("Requirement not found");
    });
  });
});
