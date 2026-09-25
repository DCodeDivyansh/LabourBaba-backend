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
      findMany: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    booking: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    worker_location: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    payment: {
      create: jest.fn(),
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
    worker_device: {
      upsert: jest.fn().mockResolvedValue({
        id: "device-row-id",
        worker_id: "mock-worker-id",
        device_id: "mock-device-id",
        fcm_token: "mock-fcm-token",
        platform: "android",
        last_seen_at: new Date(),
        revoked_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      }),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    worker_document: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
    otp_challenge: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    refresh_session: {
      create: jest.fn().mockImplementation(async ({ data }: any) => ({
        id: "a1b2c3d4-e5f6-4890-a234-56789abcdef0",
        expires_at: data?.expires_at || new Date(Date.now() + 30 * 86400000),
        user_id: data?.user_id,
        user_role: data?.user_role,
      })),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    audit_log: {
      create: jest.fn().mockResolvedValue({ id: "audit-1" }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn(async (callback: any) => {
      if (typeof callback === "function") {
        return await callback(prisma);
      }
      return callback;
    }),
    $executeRaw: jest.fn(),
  },
}));

import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { generateToken, hashPassword, hashOTP } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";

// Sentinel values that must NEVER appear in serialized responses or as field values
const SENTINEL_PASSWORD = "DO_NOT_LEAK_PASSWORD_123";
const SENTINEL_DEVICE_TOKEN = "DO_NOT_LEAK_DEVICE_TOKEN_456";
const SENTINEL_OTP_HASH = "DO_NOT_LEAK_OTP_HASH_789";

// Prohibited property keys that must never appear anywhere in public/serialized JSON
const PROHIBITED_KEYS = ["password", "device_token", "otp_hash"];

/**
 * Recursively inspect an object or array to find any occurrences of prohibited keys.
 */
function findProhibitedKeys(obj: any, keys: string[] = PROHIBITED_KEYS): string[] {
  const found: string[] = [];
  function recurse(current: any, path: string = "") {
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      current.forEach((item, index) => recurse(item, `${path}[${index}]`));
      return;
    }
    for (const [key, value] of Object.entries(current)) {
      const fullPath = path ? `${path}.${key}` : key;
      if (keys.includes(key.toLowerCase())) {
        found.push(fullPath);
      }
      recurse(value, fullPath);
    }
  }
  recurse(obj);
  return found;
}

/**
 * Assert that a response body does not contain any sentinel values or prohibited keys.
 */
function assertNoSensitiveData(resBody: any) {
  const serialized = JSON.stringify(resBody);

  // 1. Assert sentinel strings are absent
  expect(serialized).not.toContain(SENTINEL_PASSWORD);
  expect(serialized).not.toContain(SENTINEL_DEVICE_TOKEN);
  expect(serialized).not.toContain(SENTINEL_OTP_HASH);

  // 2. Assert prohibited keys are absent throughout the object tree
  const prohibitedOccurrences = findProhibitedKeys(resBody);
  expect(prohibitedOccurrences).toEqual([]);
}

describe("P0 Security Regression: Sensitive Data & Password Hash Leakage", () => {
  const MOCK_CUSTOMER_ID = "c0000000-0000-0000-0000-000000000001";
  const MOCK_WORKER_ID = "00000000-0000-4000-b000-000000000002";
  const MOCK_ADMIN_ID = "a0000000-0000-0000-0000-000000000003";
  const MOCK_BOOKING_ID = "b0000000-0000-0000-0000-000000000004";

  let customerToken: string;
  let workerToken: string;
  let adminToken: string;

  beforeAll(() => {
    customerToken = generateToken({ id: MOCK_CUSTOMER_ID, phone: "+919876543210", role: UserRole.CUSTOMER });
    workerToken = generateToken({ id: MOCK_WORKER_ID, phone: "+919876543211", role: UserRole.WORKER });
    adminToken = generateToken({ id: MOCK_ADMIN_ID, phone: "+919876543299", role: UserRole.ADMIN });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    ((prisma as any).refresh_session.create as jest.Mock).mockResolvedValue({
      id: "a1b2c3d4-e5f6-4890-a234-56789abcdef0",
      expires_at: new Date(Date.now() + 30 * 86400000),
    });
    ((prisma as any).audit_log.create as jest.Mock).mockResolvedValue({
      id: "audit-1",
      created_at: new Date(),
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. WORKER ENDPOINTS
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Worker Endpoints", () => {
    it("POST /api/workers/registerWorker must never leak password or device_token", async () => {
      (prisma.worker.create as jest.Mock).mockResolvedValue({
        id: MOCK_WORKER_ID,
        name: "Test Worker",
        phone: "+919876543211",
        skill_type: "Plumber",
        skill_category_id: "cat-uuid",
        aadhaar_last4: "1234",
        verification_status: "pending",
        // Even if Prisma mock returns sensitive fields:
        password: SENTINEL_PASSWORD,
        device_token: SENTINEL_DEVICE_TOKEN,
      });

      const res = await request(app)
        .post("/api/workers/registerWorker")
        .send({
          name: "Test Worker",
          skill_category_id: "c1b2c3d4-e5f6-4890-a234-56789abcdef0",
          phone: "+919876543211",
          password: "mysecurepassword",
          skill_type: "Plumber",
          aadhaar_last4: "1234",
          device_token: SENTINEL_DEVICE_TOKEN,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      assertNoSensitiveData(res.body);
    });

    it("GET /api/workers/me must never leak password or device_token", async () => {
      (prisma.worker.findUnique as jest.Mock).mockResolvedValue({
        id: MOCK_WORKER_ID,
        name: "Test Worker",
        phone: "+919876543211",
        skill_type: "Plumber",
        skill_category_id: "cat-uuid",
        aadhaar_last4: "1234",
        verification_status: "verified",
        password: SENTINEL_PASSWORD,
        device_token: SENTINEL_DEVICE_TOKEN,
      });

      const res = await request(app)
        .get("/api/workers/me")
        .set("Authorization", `Bearer ${workerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoSensitiveData(res.body);
    });

    it("GET /api/workers/me/bookings must never leak nested customer password or otp_hash", async () => {
      (prisma.booking.findMany as jest.Mock).mockResolvedValue([
        {
          id: MOCK_BOOKING_ID,
          job_id: "job-1",
          requirement_id: "req-1",
          worker_id: MOCK_WORKER_ID,
          customer_id: MOCK_CUSTOMER_ID,
          status: "confirmed",
          otp_verified: false,
          created_at: new Date(),
          updated_at: new Date(),
          otp_hash: SENTINEL_OTP_HASH,
          customer: {
            id: MOCK_CUSTOMER_ID,
            name: "Customer A",
            phone: "+919876543210",
            password: SENTINEL_PASSWORD,
          },
        },
      ]);

      const res = await request(app)
        .get("/api/workers/me/bookings")
        .set("Authorization", `Bearer ${workerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoSensitiveData(res.body);
    });

    it("PATCH /api/workers/me/device-token must return success without leaking worker or token", async () => {
      (prisma.worker.update as jest.Mock).mockResolvedValue({
        id: MOCK_WORKER_ID,
      });

      const res = await request(app)
        .patch("/api/workers/me/device-token")
        .set("Authorization", `Bearer ${workerToken}`)
        .send({ device_token: "new-push-token" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoSensitiveData(res.body);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. CUSTOMER ENDPOINTS
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Customer Endpoints", () => {
    it("GET /api/clients must never leak customer password", async () => {
      (prisma.customer.findMany as jest.Mock).mockResolvedValue([
        {
          id: MOCK_CUSTOMER_ID,
          name: "Customer One",
          phone: "+919876543210",
          created_at: new Date(),
          password: SENTINEL_PASSWORD,
        },
      ]);

      const res = await request(app)
        .get("/api/clients")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoSensitiveData(res.body);
    });

    it("POST /api/clients/add must never leak customer password in response", async () => {
      (prisma.customer.create as jest.Mock).mockResolvedValue({
        id: MOCK_CUSTOMER_ID,
        name: "New Customer",
        phone: "+919876543210",
        created_at: new Date(),
        password: SENTINEL_PASSWORD,
      });

      const res = await request(app)
        .post("/api/clients/add")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          name: "New Customer",
          phone: "+919876543210",
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      assertNoSensitiveData(res.body);
    });

    it("GET /api/clients/me must never leak customer password", async () => {
      (prisma.customer.findUnique as jest.Mock).mockResolvedValue({
        id: MOCK_CUSTOMER_ID,
        name: "Current Customer",
        phone: "+919876543210",
        created_at: new Date(),
        password: SENTINEL_PASSWORD,
      });

      const res = await request(app)
        .get("/api/clients/me")
        .set("Authorization", `Bearer ${customerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoSensitiveData(res.body);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. NESTED RELATION LEAKAGE FIXTURE (BOOKING DETAIL)
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Nested Relation Leakage (Booking Detail)", () => {
    it("GET /api/bookings/:id must strip otp_hash, worker password/device_token, and customer password", async () => {
      // Complete nested fixture containing all sensitive sentinel values
      const nestedBookingFixture = {
        id: MOCK_BOOKING_ID,
        job_id: "job-uuid-1",
        requirement_id: "req-uuid-1",
        worker_id: MOCK_WORKER_ID,
        customer_id: MOCK_CUSTOMER_ID,
        status: "confirmed",
        otp_hash: SENTINEL_OTP_HASH,
        otp_verified: false,
        created_at: new Date(),
        updated_at: new Date(),
        worker: {
          id: MOCK_WORKER_ID,
          name: "Worker Alice",
          skill_type: "Electrician",
          worker_score: 4.8,
          is_online: true,
          skill_category_id: "cat-uuid-1",
          password: SENTINEL_PASSWORD,
          device_token: SENTINEL_DEVICE_TOKEN,
        },
        customer: {
          id: MOCK_CUSTOMER_ID,
          name: "Customer Bob",
          phone: "+919876543210",
          password: SENTINEL_PASSWORD,
        },
        payment: {
          id: "pay-uuid-1",
          booking_id: MOCK_BOOKING_ID,
          razorpay_order_id: "order_12345",
          status: "PENDING",
          amount: 500,
        },
        job_requirement: {
          id: "req-uuid-1",
          skill_type: "Electrician",
          worker_count_needed: 1,
        },
      };

      (prisma.booking.findUnique as jest.Mock).mockResolvedValue(nestedBookingFixture);

      const res = await request(app)
        .get(`/api/bookings/${MOCK_BOOKING_ID}`)
        .set("Authorization", `Bearer ${customerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify the entire response body tree
      assertNoSensitiveData(res.body);

      // Verify safe fields ARE present and intact
      expect(res.body.data.id).toBe(MOCK_BOOKING_ID);
      expect(res.body.data.worker.name).toBe("Worker Alice");
      expect(res.body.data.customer.name).toBe("Customer Bob");
      expect(res.body.data.payment.amount).toBe(500);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. ADMIN ENDPOINTS
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Admin Endpoints", () => {
    it("GET /api/admin/workers must never leak worker password or device_token", async () => {
      (prisma.worker.findMany as jest.Mock).mockResolvedValue([
        {
          id: MOCK_WORKER_ID,
          name: "Admin View Worker",
          phone: "+919876543211",
          skill_type: "Mason",
          skill_category_id: "cat-1",
          password: SENTINEL_PASSWORD,
          device_token: SENTINEL_DEVICE_TOKEN,
          decline_count: 1,
          timeout_count: 0,
        },
      ]);

      const res = await request(app)
        .get("/api/admin/workers")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoSensitiveData(res.body);
    });

    it("GET /api/admin/flagged must never leak worker password or device_token", async () => {
      (prisma.worker.findMany as jest.Mock).mockResolvedValue([
        {
          id: MOCK_WORKER_ID,
          name: "Flagged Worker",
          phone: "+919876543211",
          skill_type: "Mason",
          skill_category_id: "cat-1",
          password: SENTINEL_PASSWORD,
          device_token: SENTINEL_DEVICE_TOKEN,
          decline_count: 8,
          timeout_count: 6,
        },
      ]);

      const res = await request(app)
        .get("/api/admin/flagged")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoSensitiveData(res.body);
    });

    it("GET /api/admin/jobs must never leak customer password through nested relations", async () => {
      (prisma.job.findMany as jest.Mock).mockResolvedValue([
        {
          id: "job-1",
          customer_id: MOCK_CUSTOMER_ID,
          status: "OPEN",
          customer: {
            id: MOCK_CUSTOMER_ID,
            name: "Job Customer",
            phone: "+919876543210",
            password: SENTINEL_PASSWORD,
          },
        },
      ]);

      const res = await request(app)
        .get("/api/admin/jobs")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoSensitiveData(res.body);
    });

    it("PATCH /api/admin/workers/:id/verify must not return worker password in updated record", async () => {
      (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
        return cb({
          worker_document: {
            findMany: jest.fn().mockResolvedValue([{ id: "doc-1", status: "PENDING" }]),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
          worker: {
            update: jest.fn().mockResolvedValue({
              id: MOCK_WORKER_ID,
              name: "Verified Worker",
              phone: "+919876543211",
              skill_type: "Painter",
              skill_category_id: "cat-1",
              verification_status: "verified",
              password: SENTINEL_PASSWORD,
              device_token: SENTINEL_DEVICE_TOKEN,
            }),
          },
          audit_log: {
            create: jest.fn().mockResolvedValue({ id: "audit-1" }),
          },
        });
      });

      const res = await request(app)
        .patch(`/api/admin/workers/${MOCK_WORKER_ID}/verify`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ status: "VERIFIED" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoSensitiveData(res.body);
    });

    it("POST /api/admin/workers/:id/suspend must not return worker password in updated record", async () => {
      // Issue #11: suspendWorker now uses $transaction. jest.clearAllMocks() in beforeEach
      // wipes the module-level factory implementation, so we must restore it here.
      ((prisma as any).$transaction as jest.Mock).mockImplementation(async (cb: any) =>
        typeof cb === "function" ? await cb(prisma) : cb
      );
      // Issue #11: suspendWorker now calls findUnique first to validate worker exists.
      (prisma.worker.findUnique as jest.Mock).mockResolvedValue({
        id: MOCK_WORKER_ID,
        verification_status: "verified",
        deleted_at: null,
      });
      (prisma.worker.update as jest.Mock).mockResolvedValue({
        id: MOCK_WORKER_ID,
        name: "Suspended Worker",
        phone: "+919876543211",
        skill_type: "Painter",
        skill_category_id: "cat-1",
        verification_status: "suspended",
        password: SENTINEL_PASSWORD,
        device_token: SENTINEL_DEVICE_TOKEN,
      });
      // Issue #11: suspendWorker atomically revokes refresh sessions inside the transaction
      ((prisma as any).refresh_session.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

      const res = await request(app)
        .post(`/api/admin/workers/${MOCK_WORKER_ID}/suspend`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ reason: "Policy violation" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoSensitiveData(res.body);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. DISPATCH ENDPOINTS
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Dispatch Endpoints", () => {
    it("GET /api/dispatch/incoming must never leak nested customer password", async () => {
      (prisma.job_dispatch.findMany as jest.Mock).mockResolvedValue([
        {
          id: "disp-1",
          worker_id: MOCK_WORKER_ID,
          requirement_id: "req-1",
          status: "pending",
          job_requirement: {
            id: "req-1",
            job: {
              id: "job-1",
              customer: {
                id: MOCK_CUSTOMER_ID,
                name: "Dispatch Customer",
                phone: "+919876543210",
                password: SENTINEL_PASSWORD,
              },
            },
          },
        },
      ]);

      const res = await request(app)
        .get("/api/dispatch/incoming")
        .set("Authorization", `Bearer ${workerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoSensitiveData(res.body);
    });

    it("GET /api/dispatch/:requirementId must never leak nested customer password", async () => {
      (prisma.job_dispatch.findFirst as jest.Mock).mockResolvedValue({
        id: "disp-1",
        worker_id: MOCK_WORKER_ID,
        requirement_id: "req-1",
        status: "pending",
        job_requirement: {
          id: "req-1",
          job: {
            id: "job-1",
            customer: {
              id: MOCK_CUSTOMER_ID,
              name: "Dispatch Customer",
              phone: "+919876543210",
              password: SENTINEL_PASSWORD,
            },
          },
        },
      });

      const res = await request(app)
        .get("/api/dispatch/req-1")
        .set("Authorization", `Bearer ${workerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoSensitiveData(res.body);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. AUTH ENDPOINTS
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Auth Endpoints", () => {
    it("POST /api/auth/verify-otp must never leak user password hash", async () => {
      (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
        typeof cb === "function" ? await cb(prisma) : cb
      );

      const validOtp = "654321";
      const hashedOtp = await hashOTP(validOtp);


      (prisma.otp_challenge.findFirst as jest.Mock).mockResolvedValue({
        id: "mock-challenge-uuid-leak-test",
        phone: "+919876543210",
        purpose: "login",
        otp_hash: hashedOtp,
        status: "ACTIVE",
        attempt_count: 0,
        consumed_at: null,
        expires_at: new Date(Date.now() + 300000),
        created_at: new Date(),
      });
      (prisma.otp_challenge.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      (prisma.customer.findUnique as jest.Mock).mockResolvedValue({
        id: MOCK_CUSTOMER_ID,
        name: "Auth Customer",
        phone: "+919876543210",
        password: SENTINEL_PASSWORD,
      });

      const res = await request(app)
        .post("/api/auth/verify-otp")
        .send({
          phone: "+919876543210",
          otp: validOtp,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      assertNoSensitiveData(res.body);

      // Verify token and sanitized user details are returned
      expect(res.body.data.token).toBeDefined();
      expect(res.body.data.user.id).toBe(MOCK_CUSTOMER_ID);
      expect(res.body.data.user.name).toBe("Auth Customer");
      expect(res.body.data.user.phone).toBe("+919876543210");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. NEGATIVE REGRESSION TESTS (SIMULATING DEVELOPER REVERSION)
  // ─────────────────────────────────────────────────────────────────────────────
  describe("Negative Regression Guardrails", () => {
    it("must detect and fail if a developer reverts to broad worker: true leaking password or device_token", () => {
      // Simulates an un-sanitized response where worker: true was used
      const insecureResponse = {
        success: true,
        data: {
          id: MOCK_BOOKING_ID,
          worker: {
            id: MOCK_WORKER_ID,
            name: "Test Worker",
            password: SENTINEL_PASSWORD,
            device_token: SENTINEL_DEVICE_TOKEN,
          },
        },
      };

      // Both sentinel value assertion and recursive key search MUST trigger a failure
      expect(() => assertNoSensitiveData(insecureResponse)).toThrow();
      const detectedKeys = findProhibitedKeys(insecureResponse);
      expect(detectedKeys).toContain("data.worker.password");
      expect(detectedKeys).toContain("data.worker.device_token");
    });

    it("must detect and fail if a developer reverts to broad customer: true leaking customer password", () => {
      // Simulates an un-sanitized response where customer: true was used
      const insecureResponse = {
        success: true,
        data: {
          id: MOCK_BOOKING_ID,
          customer: {
            id: MOCK_CUSTOMER_ID,
            name: "Customer",
            password: SENTINEL_PASSWORD,
          },
        },
      };

      expect(() => assertNoSensitiveData(insecureResponse)).toThrow();
      const detectedKeys = findProhibitedKeys(insecureResponse);
      expect(detectedKeys).toContain("data.customer.password");
    });

    it("must detect and fail if a developer exposes booking.otp_hash", () => {
      // Simulates an un-sanitized response where otp_hash leaked
      const insecureResponse = {
        success: true,
        data: {
          id: MOCK_BOOKING_ID,
          otp_hash: SENTINEL_OTP_HASH,
        },
      };

      expect(() => assertNoSensitiveData(insecureResponse)).toThrow();
      const detectedKeys = findProhibitedKeys(insecureResponse);
      expect(detectedKeys).toContain("data.otp_hash");
    });

    it("must detect sentinel value leakage even under benign key names", () => {
      const sneakyLeakResponse = {
        success: true,
        data: {
          id: "safe-id",
          custom_notes: `Confidential hash: ${SENTINEL_PASSWORD}`,
        },
      };

      expect(() => assertNoSensitiveData(sneakyLeakResponse)).toThrow();
    });
  });
});

