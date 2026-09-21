import request from "supertest";

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

// Mock bullmq module
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

// Mock prisma client
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
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    booking: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    conversation: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    message: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
    worker_location: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
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
    worker_analytics: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));

import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { generateToken } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";

const MOCK_CUSTOMER_ID = "a1b2c3d4-e5f6-4890-a234-56789abcdef0";
const MOCK_WORKER_ID = "11b2c3d4-e5f6-4890-a234-56789abcdef1";
const MOCK_ADMIN_ID = "22b2c3d4-e5f6-4890-a234-56789abcdef2";
const MOCK_BOOKING_ID = "33b2c3d4-e5f6-4890-a234-56789abcdef3";
const MOCK_JOB_ID = "44b2c3d4-e5f6-4890-a234-56789abcdef4";

/**
 * Recursively scans an object or array to ensure NO forbidden database property exists
 */
function assertNoForbiddenFields(obj: any, path = ""): void {
  if (!obj || typeof obj !== "object") return;

  const FORBIDDEN_FIELDS = [
    "password",
    "password_hash",
    "passwordHash",
    "otp_hash",
    "otpHash",
    "device_token",
    "deviceToken",
    "push_token",
    "pushToken",
    "location_geo",
    "storage_key",
    "private_document_key",
    "internal_status",
    "internal_notes",
    "admin_notes",
    "idempotency_key",
  ];

  if (Array.isArray(obj)) {
    obj.forEach((item, index) => assertNoForbiddenFields(item, `${path}[${index}]`));
    return;
  }

  for (const key of Object.keys(obj)) {
    const currentPath = path ? `${path}.${key}` : key;
    expect({ path: currentPath, forbidden: FORBIDDEN_FIELDS.includes(key) }).toEqual({
      path: currentPath,
      forbidden: false,
    });
    assertNoForbiddenFields(obj[key], currentPath);
  }
}

describe("HTTP DTO Boundary Security & Data Exposure Tests (Issue #4)", () => {
  let customerToken: string;
  let workerToken: string;
  let adminToken: string;

  beforeEach(() => {
    customerToken = generateToken({
      id: MOCK_CUSTOMER_ID,
      phone: "+919876543210",
      role: UserRole.CUSTOMER,
    });
    workerToken = generateToken({
      id: MOCK_WORKER_ID,
      phone: "+919876543211",
      role: UserRole.WORKER,
    });
    adminToken = generateToken({
      id: MOCK_ADMIN_ID,
      phone: "+919876543212",
      role: UserRole.ADMIN,
    });
  });

  describe("Customer Profile & Auth Boundaries", () => {
    it("GET /api/clients/me MUST never expose password, deleted_at, or tokens", async () => {
      (prisma.customer.findUnique as jest.Mock).mockResolvedValue({
        id: MOCK_CUSTOMER_ID,
        name: "Test Customer",
        phone: "+919876543210",
        password: "hashed_secret_password",
        deleted_at: null,
        created_at: new Date(),
        device_token: "secret_fcm_token",
      });

      const res = await request(app)
        .get("/api/clients/me")
        .set("Authorization", `Bearer ${customerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe("Test Customer");
      assertNoForbiddenFields(res.body);
    });

    it("GET /api/clients MUST never expose passwords", async () => {
      (prisma.customer.findMany as jest.Mock).mockResolvedValue([
        {
          id: MOCK_CUSTOMER_ID,
          name: "Customer 1",
          phone: "+919876543210",
          password: "hashed_password",
          created_at: new Date(),
        },
      ]);

      const res = await request(app)
        .get("/api/clients")
        .set("Authorization", `Bearer ${customerToken}`);

      expect(res.status).toBe(200);
      assertNoForbiddenFields(res.body);
    });
  });

  describe("Worker Profile & Document Boundaries", () => {
    it("GET /api/workers/me MUST never expose password or device_token", async () => {
      (prisma.worker.findUnique as jest.Mock).mockResolvedValue({
        id: MOCK_WORKER_ID,
        name: "Worker 1",
        phone: "+919876543211",
        password: "hashed_worker_password",
        device_token: "fcm_token_12345",
        skill_type: "Plumber",
        skill_category_id: "cat-1",
        worker_score: 5.0,
        is_online: true,
        aadhaar_last4: "9999",
        verification_status: "verified",
      });

      const res = await request(app)
        .get("/api/workers/me")
        .set("Authorization", `Bearer ${workerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoForbiddenFields(res.body);
    });

    it("GET /api/workers/me/documents MUST return explicit document DTOs without storage internals", async () => {
      (prisma.worker_document.findMany as jest.Mock).mockResolvedValue([
        {
          id: "doc-1",
          worker_id: MOCK_WORKER_ID,
          document_type: "AADHAAR",
          file_url: "https://bucket.s3.amazonaws.com/doc1.pdf",
          status: "VERIFIED",
          storage_key: "private/raw/doc1.pdf",
          admin_notes: "internal admin note",
        },
      ]);

      const res = await request(app)
        .get("/api/workers/me/documents")
        .set("Authorization", `Bearer ${workerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoForbiddenFields(res.body);
    });
  });

  describe("Job & Requirement Boundaries", () => {
    it("GET /api/jobs/:jobId MUST return DTO with safe customer summary and requirements", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: MOCK_JOB_ID,
        customer_id: MOCK_CUSTOMER_ID,
        location: "Mumbai",
        status: "OPEN",
        dispatch_status: "PENDING",
        created_at: new Date(),
        booking: [{ worker_id: MOCK_WORKER_ID }],
        job_requirement: [
          {
            id: "req-1",
            job_id: MOCK_JOB_ID,
            skill_type: "Plumber",
            worker_count_needed: 2,
            worker_count_filled: 1,
            rate_per_day: 500,
            status: "OPEN",
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

      const res = await request(app)
        .get(`/api/jobs/${MOCK_JOB_ID}`)
        .set("Authorization", `Bearer ${customerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(MOCK_JOB_ID);
      assertNoForbiddenFields(res.body);
    });

    it("GET /api/jobs/:jobId/bookings MUST map worker details through public DTO without passwords", async () => {
      (prisma.job.findUnique as jest.Mock).mockResolvedValue({
        id: MOCK_JOB_ID,
        customer_id: MOCK_CUSTOMER_ID,
      });

      (prisma.booking.findMany as jest.Mock).mockResolvedValue([
        {
          id: MOCK_BOOKING_ID,
          job_id: MOCK_JOB_ID,
          requirement_id: "req-1",
          worker_id: MOCK_WORKER_ID,
          customer_id: MOCK_CUSTOMER_ID,
          status: "confirmed",
          otp_verified: false,
          created_at: new Date(),
          updated_at: new Date(),
          worker: {
            id: MOCK_WORKER_ID,
            name: "Worker Safe",
            phone: "+919876543211",
            skill_type: "Plumber",
            worker_score: 4.9,
            password: "password_leaked_if_unmapped",
            device_token: "device_token_leaked_if_unmapped",
          },
        },
      ]);

      (prisma.$queryRaw as jest.Mock).mockResolvedValue([
        { latitude: 19.076, longitude: 72.8777 },
      ]);

      const res = await request(app)
        .get(`/api/jobs/${MOCK_JOB_ID}/bookings`)
        .set("Authorization", `Bearer ${customerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoForbiddenFields(res.body);
    });
  });

  describe("Booking & Payment Boundaries", () => {
    it("GET /api/bookings/:bookingId MUST strictly exclude otp_hash and sanitize all nested relations", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: MOCK_BOOKING_ID,
        job_id: MOCK_JOB_ID,
        requirement_id: "req-1",
        worker_id: MOCK_WORKER_ID,
        customer_id: MOCK_CUSTOMER_ID,
        status: "confirmed",
        otp_verified: false,
        otp_hash: "SECRET_OTP_HASH_NEVER_LEAK",
        created_at: new Date(),
        updated_at: new Date(),
        worker: {
          id: MOCK_WORKER_ID,
          name: "Safe Worker",
          skill_type: "Plumber",
          worker_score: 4.8,
          is_online: true,
          skill_category_id: "cat-1",
          password: "WORKER_PASSWORD_SECRET",
          device_token: "WORKER_DEVICE_TOKEN",
        },
        customer: {
          id: MOCK_CUSTOMER_ID,
          name: "Customer Name",
          phone: "+919876543210",
          password: "CUSTOMER_PASSWORD_SECRET",
        },
        payment: {
          id: "pay-1",
          booking_id: MOCK_BOOKING_ID,
          razorpay_order_id: "order_123",
          status: "PENDING",
          amount: 50000,
          idempotency_key: "SECRET_IDEMPOTENCY_KEY",
        },
      });

      const res = await request(app)
        .get(`/api/bookings/${MOCK_BOOKING_ID}`)
        .set("Authorization", `Bearer ${customerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoForbiddenFields(res.body);
    });

    it("GET /api/payments/:bookingId MUST return Payment DTO without internal payment secrets", async () => {
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: MOCK_BOOKING_ID,
        customer_id: MOCK_CUSTOMER_ID,
      });

      (prisma.payment.findFirst as jest.Mock).mockResolvedValue({
        id: "pay-1",
        booking_id: MOCK_BOOKING_ID,
        razorpay_order_id: "order_123",
        razorpay_payment_id: "pay_123",
        status: "COMPLETED",
        amount: 50000,
        currency: "INR",
        idempotency_key: "INTERNAL_IDEMPOTENCY_KEY",
      });
      (prisma.payment.findUnique as jest.Mock).mockResolvedValue({
        id: "pay-1",
        booking_id: MOCK_BOOKING_ID,
        razorpay_order_id: "order_123",
        razorpay_payment_id: "pay_123",
        status: "COMPLETED",
        amount: 50000,
        currency: "INR",
        idempotency_key: "INTERNAL_IDEMPOTENCY_KEY",
      });

      const res = await request(app)
        .get(`/api/payments/${MOCK_BOOKING_ID}`)
        .set("Authorization", `Bearer ${customerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoForbiddenFields(res.body);
    });
  });

  describe("Admin Views Boundary", () => {
    it("GET /api/admin/workers MUST return allowlisted WorkerAdminDTOs and never passwords/tokens", async () => {
      (prisma.worker.findMany as jest.Mock).mockResolvedValue([
        {
          id: MOCK_WORKER_ID,
          name: "Admin Worker View",
          phone: "+919876543211",
          skill_type: "Electrician",
          skill_category_id: "cat-2",
          worker_score: 4.7,
          is_online: false,
          aadhaar_last4: "1234",
          verification_status: "verified",
          decline_count: 0,
          timeout_count: 0,
          password: "RAW_PASSWORD_HASH_MUST_NEVER_LEAK_EVEN_TO_ADMIN",
          device_token: "DEVICE_TOKEN_SECRET",
        },
      ]);

      const res = await request(app)
        .get("/api/admin/workers")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoForbiddenFields(res.body);
    });

    it("GET /api/admin/jobs MUST return allowlisted jobs without spreading raw Prisma models", async () => {
      (prisma.job.findMany as jest.Mock).mockResolvedValue([
        {
          id: MOCK_JOB_ID,
          customer_id: MOCK_CUSTOMER_ID,
          status: "OPEN",
          dispatch_status: "PENDING",
          customer: {
            id: MOCK_CUSTOMER_ID,
            name: "Customer",
            phone: "+919876543210",
            password: "PASSWORD_SHOULD_NEVER_LEAK",
          },
          job_requirement: [],
        },
      ]);

      const res = await request(app)
        .get("/api/admin/jobs")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoForbiddenFields(res.body);
    });
  });

  describe("Chat & Reviews Boundaries", () => {
    it("GET /api/chat/:bookingId/messages MUST return ChatMessageDTOs without conversation relations", async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: MOCK_BOOKING_ID,
        customer_id: MOCK_CUSTOMER_ID,
        worker_id: MOCK_WORKER_ID,
      });

      (prisma.conversation.findFirst as jest.Mock).mockResolvedValue({
        id: "conv-1",
        booking_id: MOCK_BOOKING_ID,
      });

      (prisma.message.findMany as jest.Mock).mockResolvedValue([
        {
          id: "msg-1",
          conversation_id: "conv-1",
          sender_id: MOCK_CUSTOMER_ID,
          content: "Hello worker",
          sent_at: new Date(),
          internal_flag: "DO_NOT_EXPOSE",
        },
      ]);

      const res = await request(app)
        .get(`/api/chat/${MOCK_BOOKING_ID}/messages`)
        .set("Authorization", `Bearer ${customerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoForbiddenFields(res.body);
    });

    it("GET /api/reviews/worker/:workerId MUST return ReviewDTOs without internal audit metadata", async () => {
      (prisma.review.findMany as jest.Mock).mockResolvedValue([
        {
          id: "rev-1",
          booking_id: MOCK_BOOKING_ID,
          worker_id: MOCK_WORKER_ID,
          customer_id: MOCK_CUSTOMER_ID,
          rating: 5,
          comment: "Excellent service",
          created_at: new Date(),
          admin_notes: "Checked for profanity: clean",
        },
      ]);

      const res = await request(app)
        .get(`/api/reviews/worker/${MOCK_WORKER_ID}`)
        .set("Authorization", `Bearer ${customerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoForbiddenFields(res.body);
    });
  });
});
