/**
 * P6 Issue 1 — Customer-Management Authorization Gap
 * Regression & Integration Authorization Test Suite
 *
 * SECURITY PROPERTY UNDER TEST:
 *   A caller cannot access customer-management functionality merely because
 *   they possess a valid JWT. Every customer-management operation must have an
 *   explicit authorization policy based on authenticated principal + role.
 *
 * TESTING APPROACH:
 *   - Real Express app is loaded (including real authenticateJWT + requireRole middleware)
 *   - Prisma is mocked to avoid a real database dependency for role-boundary tests
 *   - The actual HTTP routing stack is exercised via supertest (not controller calls)
 *   - This means authentication middleware and authorization middleware run for real
 *
 * REGRESSION PROTECTION:
 *   If requireRole(UserRole.ADMIN) is removed from GET / or POST /add,
 *   tests A4, A5, B4, B5 will fail (they expect 403 but get 200/201).
 *   If requireRole(UserRole.CUSTOMER) is removed from GET /me,
 *   tests C4, C5 will fail (they expect 403 but get 200).
 */

import request from "supertest";

// --- Infrastructure mocks (required to boot the server without Redis/external deps) ---

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
  Queue: jest.fn().mockImplementation(() => ({ add: jest.fn().mockResolvedValue({}) })),
  Worker: jest.fn().mockImplementation(() => ({ on: jest.fn(), close: jest.fn() })),
}));
jest.mock("../src/config/bullmq", () => ({
  dispatchQueue: { add: jest.fn() },
  timeoutQueue: { add: jest.fn() },
  connection: {},
}));
jest.mock("../src/providers/razorpay/razorpayProvider", () => ({
  createOrder: jest.fn().mockResolvedValue({ razorpayOrderId: "order_mock", amount: 100, currency: "INR" }),
  verifyWebhookSignature: jest.fn().mockReturnValue(true),
  RazorpayProviderError: class extends Error {
    code: string; statusCode: number;
    constructor(msg: string, code: string, statusCode = 502) {
      super(msg); this.code = code; this.statusCode = statusCode;
    }
  },
}));

// --- Prisma mock — real middleware still runs, only DB calls are mocked ---
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
    },
    job: { findMany: jest.fn() },
    job_requirement: { findMany: jest.fn() },
    booking: { findUnique: jest.fn(), findFirst: jest.fn() },
    skill_category: { findMany: jest.fn() },
    worker_document: { findMany: jest.fn() },
    worker_location: { findUnique: jest.fn() },
    payment: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn() },
    review: { findMany: jest.fn() },
    audit_log: {
      create: jest.fn().mockResolvedValue({ id: "mock-audit-id" }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    admin_audit_log: {
      create: jest.fn().mockResolvedValue({ id: "mock-audit-id" }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    refresh_session: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
  },
}));

// --- App + test utilities ---
import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { generateToken, signAccessToken } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";

// --- Fixed principal IDs ---
const CUSTOMER_A_ID = "aaaaaaaa-0000-4000-a000-000000000001";
const CUSTOMER_B_ID = "bbbbbbbb-0000-4000-a000-000000000002";
const WORKER_ID     = "cccccccc-0000-4000-a000-000000000003";
const ADMIN_ID      = "dddddddd-0000-4000-a000-000000000004";
const SUSPENDED_CUSTOMER_ID = "eeeeeeee-0000-4000-a000-000000000005";
const DELETED_CUSTOMER_ID   = "ffffffff-0000-4000-a000-000000000006";

jest.setTimeout(20000);

describe("P6 Issue 1 — Customer-Management Authorization Gap", () => {
  let tokenCustomerA: string;
  let tokenCustomerB: string;
  let tokenWorker: string;
  let tokenAdmin: string;
  let tokenExpired: string;
  let tokenInvalid: string;
  let tokenSuspendedCustomer: string;
  let tokenDeletedCustomer: string;

  beforeAll(() => {
    tokenCustomerA         = generateToken({ id: CUSTOMER_A_ID, phone: "+919800000001", role: UserRole.CUSTOMER });
    tokenCustomerB         = generateToken({ id: CUSTOMER_B_ID, phone: "+919800000002", role: UserRole.CUSTOMER });
    tokenWorker            = generateToken({ id: WORKER_ID,     phone: "+919700000001", role: UserRole.WORKER });
    tokenAdmin             = generateToken({ id: ADMIN_ID,      phone: "+919600000001", role: UserRole.ADMIN });
    tokenSuspendedCustomer = generateToken({ id: SUSPENDED_CUSTOMER_ID, phone: "+919800000003", role: UserRole.CUSTOMER });
    tokenDeletedCustomer   = generateToken({ id: DELETED_CUSTOMER_ID,   phone: "+919800000004", role: UserRole.CUSTOMER });
    tokenExpired           = signAccessToken({ id: CUSTOMER_A_ID, phone: "+919800000001", role: UserRole.CUSTOMER }, "-1s");
    tokenInvalid           = "eyJhbGciOiJIUzI1NiJ9.invalid.signature";
  });

  beforeEach(() => {
    (prisma.customer.findUnique as jest.Mock).mockResolvedValue({
      id: CUSTOMER_A_ID,
      phone: "+919800000001",
      name: "Customer A",
      created_at: new Date(),
      deleted_at: null,
    });
    (prisma.worker.findUnique as jest.Mock).mockResolvedValue({
      id: WORKER_ID,
      phone: "+919700000001",
      deleted_at: null,
      verification_status: "verified",
    });
    (prisma.customer.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.customer.create as jest.Mock).mockResolvedValue({
      id: "new-cust-uuid",
      name: "New Customer",
      phone: "+919800009999",
      created_at: new Date(),
    });
    (prisma.$transaction as jest.Mock).mockImplementation((cb: any) => cb(prisma));
    (prisma.$executeRaw as jest.Mock).mockResolvedValue(1);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================================
  // TEST GROUP A: GET /api/clients (ADMIN-only customer enumeration)
  // ============================================================================
  describe("Group A: GET /api/clients (ADMIN-only)", () => {
    it("A1: anonymous request returns 401", async () => {
      const res = await request(app).get("/api/clients");
      expect(res.status).toBe(401);
      expect(res.body.data).toBeUndefined();
    });

    it("A2: invalid JWT returns 401", async () => {
      const res = await request(app)
        .get("/api/clients")
        .set("Authorization", `Bearer ${tokenInvalid}`);
      expect(res.status).toBe(401);
      expect(res.body.data).toBeUndefined();
    });

    it("A3: expired JWT returns 401", async () => {
      const res = await request(app)
        .get("/api/clients")
        .set("Authorization", `Bearer ${tokenExpired}`);
      expect(res.status).toBe(401);
      expect(res.body.data).toBeUndefined();
    });

    // REGRESSION GUARD: fails if requireRole(ADMIN) is removed from GET /
    it("A4: CUSTOMER token returns 403 (not authorized for admin-only endpoint)", async () => {
      const res = await request(app)
        .get("/api/clients")
        .set("Authorization", `Bearer ${tokenCustomerA}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.data).toBeUndefined();
    });

    // REGRESSION GUARD: fails if requireRole(ADMIN) is removed from GET /
    it("A5: WORKER token returns 403 (not authorized for admin-only endpoint)", async () => {
      const res = await request(app)
        .get("/api/clients")
        .set("Authorization", `Bearer ${tokenWorker}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.data).toBeUndefined();
    });

    it("A6: ADMIN token returns 200 with customer list", async () => {
      (prisma.customer.findMany as jest.Mock).mockResolvedValue([
        { id: CUSTOMER_A_ID, name: "Customer A", phone: "+919800000001", created_at: new Date() },
      ]);
      const res = await request(app)
        .get("/api/clients")
        .set("Authorization", `Bearer ${tokenAdmin}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  // ============================================================================
  // TEST GROUP B: POST /api/clients/add (ADMIN-only customer creation)
  // ============================================================================
  describe("Group B: POST /api/clients/add (ADMIN-only)", () => {
    const validPayload = { name: "Test Customer", phone: "+919876543210" };

    it("B1: anonymous request returns 401", async () => {
      const res = await request(app).post("/api/clients/add").send(validPayload);
      expect(res.status).toBe(401);
      expect(res.body.data).toBeUndefined();
    });

    it("B2: invalid JWT returns 401", async () => {
      const res = await request(app)
        .post("/api/clients/add")
        .set("Authorization", `Bearer ${tokenInvalid}`)
        .send(validPayload);
      expect(res.status).toBe(401);
      expect(res.body.data).toBeUndefined();
    });

    it("B3: expired JWT returns 401", async () => {
      const res = await request(app)
        .post("/api/clients/add")
        .set("Authorization", `Bearer ${tokenExpired}`)
        .send(validPayload);
      expect(res.status).toBe(401);
      expect(res.body.data).toBeUndefined();
    });

    // REGRESSION GUARD: fails if requireRole(ADMIN) is removed from POST /add
    it("B4: CUSTOMER token returns 403 (not authorized for admin-only endpoint)", async () => {
      const res = await request(app)
        .post("/api/clients/add")
        .set("Authorization", `Bearer ${tokenCustomerA}`)
        .send(validPayload);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.data).toBeUndefined();
      // Authorization must block before DB is hit
      expect(prisma.customer.create).not.toHaveBeenCalled();
    });

    // REGRESSION GUARD: fails if requireRole(ADMIN) is removed from POST /add
    it("B5: WORKER token returns 403 (not authorized for admin-only endpoint)", async () => {
      const res = await request(app)
        .post("/api/clients/add")
        .set("Authorization", `Bearer ${tokenWorker}`)
        .send(validPayload);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.data).toBeUndefined();
      expect(prisma.customer.create).not.toHaveBeenCalled();
    });

    it("B6: ADMIN token successfully creates customer (201)", async () => {
      const created = { id: "new-cust-uuid", name: "Test Customer", phone: "+919876543210", created_at: new Date() };
      (prisma.customer.create as jest.Mock).mockResolvedValue(created);
      const res = await request(app)
        .post("/api/clients/add")
        .set("Authorization", `Bearer ${tokenAdmin}`)
        .send(validPayload);
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(prisma.customer.create).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================================
  // TEST GROUP C: GET /api/clients/me (CUSTOMER-only self-service)
  // ============================================================================
  describe("Group C: GET /api/clients/me (CUSTOMER-only self-service)", () => {
    it("C1: anonymous request returns 401", async () => {
      const res = await request(app).get("/api/clients/me");
      expect(res.status).toBe(401);
      expect(res.body.data).toBeUndefined();
    });

    it("C2: invalid JWT returns 401", async () => {
      const res = await request(app)
        .get("/api/clients/me")
        .set("Authorization", `Bearer ${tokenInvalid}`);
      expect(res.status).toBe(401);
      expect(res.body.data).toBeUndefined();
    });

    it("C3: expired JWT returns 401", async () => {
      const res = await request(app)
        .get("/api/clients/me")
        .set("Authorization", `Bearer ${tokenExpired}`);
      expect(res.status).toBe(401);
      expect(res.body.data).toBeUndefined();
    });

    // REGRESSION GUARD: fails if requireRole(CUSTOMER) is removed from GET /me
    it("C4: ADMIN token returns 403 (/me is CUSTOMER-only)", async () => {
      const res = await request(app)
        .get("/api/clients/me")
        .set("Authorization", `Bearer ${tokenAdmin}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.data).toBeUndefined();
    });

    // REGRESSION GUARD: fails if requireRole(CUSTOMER) is removed from GET /me
    it("C5: WORKER token returns 403 (/me is CUSTOMER-only)", async () => {
      const res = await request(app)
        .get("/api/clients/me")
        .set("Authorization", `Bearer ${tokenWorker}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.data).toBeUndefined();
    });

    it("C6: CUSTOMER token returns 200 with own profile", async () => {
      (prisma.customer.findUnique as jest.Mock).mockResolvedValue({
        id: CUSTOMER_A_ID,
        name: "Customer A",
        phone: "+919800000001",
        created_at: new Date(),
        deleted_at: null,
      });
      const res = await request(app)
        .get("/api/clients/me")
        .set("Authorization", `Bearer ${tokenCustomerA}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
    });

    it("C7: returned profile belongs to the authenticated CUSTOMER (identity from JWT)", async () => {
      (prisma.customer.findUnique as jest.Mock).mockImplementation(({ where }: any) => {
        if (where.id === CUSTOMER_A_ID) {
          return Promise.resolve({
            id: CUSTOMER_A_ID,
            name: "Customer A",
            phone: "+919800000001",
            created_at: new Date(),
            deleted_at: null,
          });
        }
        return Promise.resolve(null);
      });

      const res = await request(app)
        .get("/api/clients/me")
        .set("Authorization", `Bearer ${tokenCustomerA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(CUSTOMER_A_ID);
      // Controller must have queried with the JWT's customer id, not any client-supplied value
      expect(prisma.customer.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: CUSTOMER_A_ID } })
      );
    });
  });

  // ============================================================================
  // TEST GROUP D: Object-Level Authorization (cross-customer isolation)
  // ============================================================================
  describe("Group D: Object-Level Authorization (cross-customer isolation)", () => {
    it("D1: Customer A /me returns Customer A data only", async () => {
      (prisma.customer.findUnique as jest.Mock).mockImplementation(({ where }: any) => {
        if (where.id === CUSTOMER_A_ID) {
          return Promise.resolve({
            id: CUSTOMER_A_ID, name: "Customer A", phone: "+919800000001",
            created_at: new Date(), deleted_at: null,
          });
        }
        return Promise.resolve(null);
      });

      const res = await request(app)
        .get("/api/clients/me")
        .set("Authorization", `Bearer ${tokenCustomerA}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(CUSTOMER_A_ID);
      expect(prisma.customer.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: CUSTOMER_A_ID } })
      );
    });

    it("D2: Customer B /me returns Customer B data only", async () => {
      (prisma.customer.findUnique as jest.Mock).mockImplementation(({ where }: any) => {
        if (where.id === CUSTOMER_B_ID) {
          return Promise.resolve({
            id: CUSTOMER_B_ID, name: "Customer B", phone: "+919800000002",
            created_at: new Date(), deleted_at: null,
          });
        }
        return Promise.resolve(null);
      });

      const res = await request(app)
        .get("/api/clients/me")
        .set("Authorization", `Bearer ${tokenCustomerB}`);

      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(CUSTOMER_B_ID);
      expect(prisma.customer.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: CUSTOMER_B_ID } })
      );
    });

    it("D3: no client-controlled customer_id field on GET /me — query params override has no effect", async () => {
      (prisma.customer.findUnique as jest.Mock).mockImplementation(({ where }: any) => {
        if (where.id === CUSTOMER_A_ID) {
          return Promise.resolve({
            id: CUSTOMER_A_ID, name: "Customer A", phone: "+919800000001",
            created_at: new Date(), deleted_at: null,
          });
        }
        return Promise.resolve(null);
      });

      // Attempt to inject Customer B's ID via query parameters (unsupported attack surface)
      const res = await request(app)
        .get("/api/clients/me")
        .query({ customer_id: CUSTOMER_B_ID, customerId: CUSTOMER_B_ID, id: CUSTOMER_B_ID })
        .set("Authorization", `Bearer ${tokenCustomerA}`);

      expect(res.status).toBe(200);
      // Must have queried with Customer A's JWT id, not the supplied Customer B id
      expect(prisma.customer.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: CUSTOMER_A_ID } })
      );
      expect(prisma.customer.findUnique).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: CUSTOMER_B_ID } })
      );
    });

    it("D4: Customer A cannot enumerate all customers (admin-only listing blocked at 403)", async () => {
      const res = await request(app)
        .get("/api/clients")
        .set("Authorization", `Bearer ${tokenCustomerA}`);
      expect(res.status).toBe(403);
      // No DB call should occur before authorization passes
      expect(prisma.customer.findMany).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // TEST GROUP E: Public endpoints remain accessible without auth
  // ============================================================================
  describe("Group E: Public Endpoints (signup / login remain public)", () => {
    it("E1: POST /api/clients/signup reachable without auth (not 401/403)", async () => {
      const res = await request(app)
        .post("/api/clients/signup")
        .send({});
      // Any status except 401/403 — proves endpoint is behind no auth guard
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it("E2: POST /api/clients/login reachable without auth (not 401/403)", async () => {
      const res = await request(app)
        .post("/api/clients/login")
        .send({});
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });
  });

  // ============================================================================
  // TEST GROUP F: Suspended / Deleted user canonical auth behavior
  // ============================================================================
  describe("Group F: Suspended / Deleted user canonical auth behavior", () => {
    it("F1: deleted customer is rejected by authenticateJWT at auth boundary (401)", async () => {
      (prisma.customer.findUnique as jest.Mock).mockResolvedValue({
        id: SUSPENDED_CUSTOMER_ID,
        phone: "+919800000003",
        deleted_at: new Date(),
      });

      const res = await request(app)
        .get("/api/clients/me")
        .set("Authorization", `Bearer ${tokenSuspendedCustomer}`);

      expect(res.status).toBe(401);
      expect(res.body.data).toBeUndefined();
    });

    it("F2: soft-deleted customer is rejected by authenticateJWT (401) even on admin endpoints", async () => {
      (prisma.customer.findUnique as jest.Mock).mockResolvedValue({
        id: DELETED_CUSTOMER_ID,
        phone: "+919800000004",
        deleted_at: new Date(),
      });

      const res = await request(app)
        .get("/api/clients")
        .set("Authorization", `Bearer ${tokenDeletedCustomer}`);

      expect(res.status).toBe(401);
      expect(res.body.data).toBeUndefined();
    });
  });

  // ============================================================================
  // TEST GROUP G: Regression Guards (invariants that MUST NOT regress)
  // ============================================================================
  describe("Group G: Regression Guards", () => {
    it("INVARIANT-1: valid JWT alone does NOT grant GET /api/clients (403 not 200)", async () => {
      const res = await request(app)
        .get("/api/clients")
        .set("Authorization", `Bearer ${tokenCustomerA}`);
      expect(res.status).toBe(403);
    });

    it("INVARIANT-2: valid JWT alone does NOT grant POST /api/clients/add (403 not 201)", async () => {
      const res = await request(app)
        .post("/api/clients/add")
        .set("Authorization", `Bearer ${tokenCustomerA}`)
        .send({ name: "Test", phone: "+919876543210" });
      expect(res.status).toBe(403);
    });

    it("INVARIANT-3: ADMIN JWT cannot use CUSTOMER self-service /me (403)", async () => {
      const res = await request(app)
        .get("/api/clients/me")
        .set("Authorization", `Bearer ${tokenAdmin}`);
      expect(res.status).toBe(403);
    });

    it("INVARIANT-4: authorization blocks DB query for unauthorized GET /api/clients", async () => {
      await request(app)
        .get("/api/clients")
        .set("Authorization", `Bearer ${tokenCustomerA}`);
      expect(prisma.customer.findMany).not.toHaveBeenCalled();
    });

    it("INVARIANT-5: authorization blocks DB mutation for unauthorized POST /api/clients/add", async () => {
      await request(app)
        .post("/api/clients/add")
        .set("Authorization", `Bearer ${tokenWorker}`)
        .send({ name: "Attacker", phone: "+919876543210" });
      expect(prisma.customer.create).not.toHaveBeenCalled();
    });

    it("INVARIANT-6: valid-but-wrong-role token returns 403 (not 401) — auth passed, authz failed", async () => {
      const res = await request(app)
        .get("/api/clients")
        .set("Authorization", `Bearer ${tokenWorker}`);
      // 403 = authenticated but not authorized (correct)
      // 401 = would mean authentication failed (wrong)
      expect(res.status).toBe(403);
    });
  });
});
