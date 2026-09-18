import request from "supertest";
import { UserRole } from "../src/middlewares/authMiddleware";
import { generateToken } from "../src/utils/authUtils";

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
jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue({}),
  })),
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn(),
  })),
}));

// Mock BullMQ queue config
jest.mock("../src/config/bullmq", () => ({
  dispatchQueue: { add: jest.fn() },
  timeoutQueue: { add: jest.fn() },
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
    conversation: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    message: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
    payment: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    review: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    worker_document: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn((cb: any) => cb(require("../src/config/prisma").default)),
    $queryRaw: jest.fn().mockResolvedValue([]),
  },
}));

import { app } from "../src/server";
import prisma from "../src/config/prisma";

describe("Issue #3 Cross-Resource Authorization & UUID Secrecy Integration Suite", () => {
  const CUSTOMER_A_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const CUSTOMER_B_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  const WORKER_A_ID = "11111111-1111-4111-a111-111111111111";
  const WORKER_B_ID = "22222222-2222-4222-a222-222222222222";
  const ADMIN_ID = "99999999-9999-4999-a999-999999999999";

  const JOB_A_ID = "aaaa1111-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const BOOKING_A_ID = "aaaa2222-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  const BOOKING_B_ID = "bbbb2222-bbbb-4bbb-bbbb-bbbbbbbbbbbb";

  let customerAToken: string;
  let customerBToken: string;
  let workerAToken: string;
  let workerBToken: string;
  let adminToken: string;

  beforeAll(() => {
    customerAToken = generateToken({ id: CUSTOMER_A_ID, phone: "+919876543210", role: UserRole.CUSTOMER });
    customerBToken = generateToken({ id: CUSTOMER_B_ID, phone: "+919876543219", role: UserRole.CUSTOMER });
    workerAToken = generateToken({ id: WORKER_A_ID, phone: "+919876543211", role: UserRole.WORKER });
    workerBToken = generateToken({ id: WORKER_B_ID, phone: "+919876543212", role: UserRole.WORKER });
    adminToken = generateToken({ id: ADMIN_ID, phone: "+919876543299", role: UserRole.ADMIN });
  });

  beforeEach(() => {
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(prisma));
    (prisma.job_requirement.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.job_dispatch.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prisma.job.update as jest.Mock).mockResolvedValue({});
    (prisma.job_requirement.updateMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prisma.booking.update as jest.Mock).mockResolvedValue({});
  });

  // ==========================================================================
  // 1. Job Authorization & Ownership
  // ==========================================================================
  describe("1. Job Resource Authorization", () => {
    it("Customer A CAN view their own Job detail", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        status: "POSTED",
        requirements: [],
      });

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(JOB_A_ID);
    });

    it("Customer B CANNOT view Customer A's Job detail (returns 404 IDOR protection)", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        status: "POSTED",
        requirements: [],
      });

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}`)
        .set("Authorization", `Bearer ${customerBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it("Customer B CANNOT cancel Customer A's Job (returns 404 IDOR protection)", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        status: "POSTED",
      });

      const res = await request(app)
        .patch(`/api/jobs/${JOB_A_ID}/cancel`)
        .set("Authorization", `Bearer ${customerBToken}`);

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });

    it("Worker A CANNOT cancel any Job (rejected with 403 Forbidden)", async () => {
      const res = await request(app)
        .patch(`/api/jobs/${JOB_A_ID}/cancel`)
        .set("Authorization", `Bearer ${workerAToken}`);

      expect(res.status).toBe(403);
    });

    it("Customer B CANNOT list requirements of Customer A's Job (returns 404 IDOR protection)", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        status: "POSTED",
      });

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}/requirements`)
        .set("Authorization", `Bearer ${customerBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it("Customer B CANNOT add requirements to Customer A's Job (returns 404 IDOR protection)", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        status: "POSTED",
      });

      const res = await request(app)
        .post(`/api/jobs/${JOB_A_ID}/requirements`)
        .set("Authorization", `Bearer ${customerBToken}`)
        .send({
          skill_type: "PLUMBER",
          worker_count_needed: 2,
          rate_per_day: 800,
          wave_size: 5,
        });

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });

    it("Customer B CANNOT list bookings of Customer A's Job (returns 404 IDOR protection)", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        status: "POSTED",
      });

      const res = await request(app)
        .get(`/api/jobs/${JOB_A_ID}/bookings`)
        .set("Authorization", `Bearer ${customerBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  // ==========================================================================
  // 2. Booking Authorization & Ownership
  // ==========================================================================
  describe("2. Booking Resource Authorization", () => {
    it("Customer A CAN read own Booking", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "CONFIRMED",
      });

      const res = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(BOOKING_A_ID);
    });

    it("Worker A CAN read Booking they are assigned to", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "CONFIRMED",
      });

      const res = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${workerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("Customer B CANNOT read Customer A's Booking (returns 404 IDOR protection)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "CONFIRMED",
      });

      const res = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it("Worker B CANNOT read Booking assigned to Worker A (returns 404 IDOR protection)", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "CONFIRMED",
      });

      const res = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${workerBToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it("Worker B CANNOT verify OTP for Worker A's Booking", async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "CONFIRMED",
        otp: "123456",
      });

      const res = await request(app)
        .post(`/api/bookings/${BOOKING_A_ID}/otp/verify`)
        .set("Authorization", `Bearer ${workerBToken}`)
        .send({ otp: "123456" });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("Customer B CANNOT cancel Customer A's Booking", async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "CONFIRMED",
      });

      const res = await request(app)
        .post(`/api/bookings/${BOOKING_A_ID}/cancel`)
        .set("Authorization", `Bearer ${customerBToken}`)
        .send({ reason: "Malicious cancel" });

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });
  });

  // ==========================================================================
  // 3. Chat Resource Authorization (Unifying HTTP and Socket Policy)
  // ==========================================================================
  describe("3. Chat Resource Authorization", () => {
    it("Customer A CAN read chat messages for own Booking", async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "CONFIRMED",
      });
      (prisma.conversation.findFirst as jest.Mock).mockResolvedValue({
        id: "conv-1",
        booking_id: BOOKING_A_ID,
      });
      (prisma.message.findMany as jest.Mock).mockResolvedValue([
        { id: "msg-1", conversation_id: "conv-1", content: "Hello", sender_id: CUSTOMER_A_ID },
      ]);

      const res = await request(app)
        .get(`/api/chat/${BOOKING_A_ID}/messages`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it("Customer B CANNOT read chat messages for Customer A's Booking (returns 404 IDOR protection)", async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "CONFIRMED",
      });

      const res = await request(app)
        .get(`/api/chat/${BOOKING_A_ID}/messages`)
        .set("Authorization", `Bearer ${customerBToken}`);

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });

    it("Worker B CANNOT read chat messages for Booking assigned to Worker A (returns 404 IDOR protection)", async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "CONFIRMED",
      });

      const res = await request(app)
        .get(`/api/chat/${BOOKING_A_ID}/messages`)
        .set("Authorization", `Bearer ${workerBToken}`);

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });

    it("Customer B CANNOT send chat message to Customer A's Booking", async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "CONFIRMED",
      });

      const res = await request(app)
        .post(`/api/chat/${BOOKING_A_ID}/messages`)
        .set("Authorization", `Bearer ${customerBToken}`)
        .send({ content: "Intruder message" });

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });
  });

  // ==========================================================================
  // 4. Worker Self-Service & Documents Authorization
  // ==========================================================================
  describe("4. Worker Self-Service & Privacy Authorization", () => {
    it("Customer A CANNOT access /api/workers/me/documents (requires WORKER role -> 403)", async () => {
      const res = await request(app)
        .get("/api/workers/me/documents")
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("Customer A CANNOT access /api/workers/me (requires WORKER role -> 403)", async () => {
      const res = await request(app)
        .get("/api/workers/me")
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("Customer A CANNOT access /api/workers/me/earnings (requires WORKER role -> 403)", async () => {
      const res = await request(app)
        .get("/api/workers/me/earnings")
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("Worker A CAN access their own documents", async () => {
      (prisma.worker_document.findMany as jest.Mock).mockResolvedValue([
        { id: "doc-1", worker_id: WORKER_A_ID, doc_type: "AADHAAR" },
      ]);

      const res = await request(app)
        .get("/api/workers/me/documents")
        .set("Authorization", `Bearer ${workerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ==========================================================================
  // 5. Review Resource Authorization
  // ==========================================================================
  describe("5. Review Resource Authorization", () => {
    it("Customer B CANNOT view review for Customer A's Booking (returns 404 IDOR protection)", async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "COMPLETED",
      });

      const res = await request(app)
        .get(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerBToken}`);

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });

    it("Worker A (assigned worker) CAN view review for their completed booking", async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "COMPLETED",
      });
      (prisma.review.findFirst as jest.Mock).mockResolvedValue({
        id: "rev-1",
        booking_id: BOOKING_A_ID,
        rating: 5,
        comment: "Great work!",
      });

      const res = await request(app)
        .get(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${workerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("Worker B (unrelated worker) CANNOT view review for Customer A's booking (returns 404 IDOR protection)", async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: BOOKING_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "COMPLETED",
      });

      const res = await request(app)
        .get(`/api/reviews/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${workerBToken}`);

      expect([403, 404]).toContain(res.status);
      expect(res.body.success).toBe(false);
    });
  });

  // ==========================================================================
  // 6. UUID Secrecy & IDOR Invariant (Knowing UUID is never enough)
  // ==========================================================================
  describe("6. UUID Secrecy Invariant", () => {
    it("Random unassociated UUID for job returns 404 without database leaking existence", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue(null);

      const fakeUuid = "77777777-7777-4777-a777-777777777777";
      const res = await request(app)
        .get(`/api/jobs/${fakeUuid}`)
        .set("Authorization", `Bearer ${customerAToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it("Unauthenticated request with valid UUID returns 401 Unauthorized", async () => {
      const res = await request(app).get(`/api/jobs/${JOB_A_ID}`);
      expect(res.status).toBe(401);
    });
  });
});
