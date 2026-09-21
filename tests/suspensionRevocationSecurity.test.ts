/**
 * suspensionRevocationSecurity.test.ts
 *
 * Issue #11: Revoke Sessions on Suspension/Deletion
 * Priority: P2 | Category: Authentication / Session Security
 *
 * Proves the core security invariant:
 *   If an account transitions into a suspended or deleted state,
 *   all active sessions, access tokens, refresh tokens, and Socket.IO connections
 *   become immediately unusable and new login is rejected.
 */

import request from "supertest";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { sessionService } from "../src/features/auth/session.service";
import { adminService } from "../src/features/admin/adminServices";
import {
  SESSION_STATUS,
  REVOKE_REASON,
  REFRESH_TOKEN_SEPARATOR,
} from "../src/features/auth/session.types";
import { UserRole } from "../src/type/userRole";
import { signAccessToken, hashPassword } from "../src/utils/authUtils";
import { socketAuthMiddleware } from "../src/socket/socketAuth";
import * as socketLifecycle from "../src/socket/socketLifecycle";

// Mock BullMQ queues to prevent connection attempts during testing
jest.mock("../src/config/bullmq", () => ({
  dispatchQueue: { add: jest.fn().mockResolvedValue({}) },
  timeoutQueue: { add: jest.fn().mockResolvedValue({}) },
}));

// Mock Firebase Admin
jest.mock("../src/shared/fcm", () => ({
  sendPushNotification: jest.fn().mockResolvedValue({}),
}));

// In-memory data store for isolated testing
interface MockWorker {
  id: string;
  phone: string;
  name: string;
  skill_type: string;
  skill_category_id: string;
  verification_status: string;
  deleted_at: Date | null;
  password: string;
}

interface MockCustomer {
  id: string;
  phone: string;
  name: string;
  password: string;
  deleted_at: Date | null;
}

interface MockSession {
  id: string;
  user_id: string;
  user_role: string;
  token_hash: string;
  family_id: string;
  device_id: string | null;
  user_agent: string | null;
  ip_address: string | null;
  status: string;
  revoked_reason: string | null;
  rotated_to_id: string | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date;
}

let workerStore: MockWorker[] = [];
let customerStore: MockCustomer[] = [];
let sessionStore: MockSession[] = [];
let otpChallengeStore: any[] = [];

// Mock Prisma client with an in-memory transactional database implementation
jest.mock("../src/config/prisma", () => {
  return {
    __esModule: true,
    default: {
      worker: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      customer: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      refresh_session: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
      },
      otp_challenge: {
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      audit_log: {
        create: jest.fn().mockResolvedValue({ id: "audit-1", created_at: new Date() }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $connect: jest.fn().mockResolvedValue(undefined),
      $disconnect: jest.fn().mockResolvedValue(undefined),
      $transaction: jest.fn(),
    },
  };
});

describe("P2 Security Suite — Issue #11: Revoke Sessions on Suspension/Deletion", () => {
  const WORKER_A_ID = "aaaaaaaa-1111-4aaa-aaaa-111111111111";
  const WORKER_B_ID = "bbbbbbbb-2222-4bbb-bbbb-222222222222";
  const CUSTOMER_ID = "cccccccc-3333-4ccc-cccc-333333333333";
  const ADMIN_ID = "dddddddd-4444-4ddd-dddd-444444444444";

  let adminToken: string;
  let hashedPassword: string;

  function setupPrismaMock() {
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
      if (typeof cb === "function") {
        return await cb(prisma);
      }
      return cb;
    });

    ((prisma as any).audit_log.create as jest.Mock).mockResolvedValue({ id: "audit-1", created_at: new Date() });
    ((prisma as any).audit_log.findMany as jest.Mock).mockResolvedValue([]);

    (prisma.worker.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => {
      if (where.id) return workerStore.find((w) => w.id === where.id) || null;
      if (where.phone) return workerStore.find((w) => w.phone === where.phone) || null;
      return null;
    });

    (prisma.worker.findFirst as jest.Mock).mockImplementation(async ({ where }: any) => {
      if (where?.phone) return workerStore.find((w) => w.phone === where.phone) || null;
      return null;
    });

    (prisma.worker.update as jest.Mock).mockImplementation(async ({ where, data }: any) => {
      const w = workerStore.find((item) => item.id === where.id);
      if (!w) throw new Error("Worker not found");
      if (data.verification_status !== undefined) w.verification_status = data.verification_status;
      if (data.deleted_at !== undefined) w.deleted_at = data.deleted_at;
      return { ...w };
    });

    (prisma.customer.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => {
      if (where.id) return customerStore.find((c) => c.id === where.id) || null;
      if (where.phone) return customerStore.find((c) => c.phone === where.phone) || null;
      return null;
    });

    (prisma.customer.findFirst as jest.Mock).mockImplementation(async ({ where }: any) => {
      if (where?.phone) return customerStore.find((c) => c.phone === where.phone) || null;
      return null;
    });

    (prisma.customer.update as jest.Mock).mockImplementation(async ({ where, data }: any) => {
      const c = customerStore.find((item) => item.id === where.id);
      if (!c) throw new Error("Customer not found");
      if (data.deleted_at !== undefined) c.deleted_at = data.deleted_at;
      return { ...c };
    });

    (prisma.refresh_session.create as jest.Mock).mockImplementation(async ({ data }: any) => {
      const newSession: MockSession = {
        id: crypto.randomUUID(),
        user_id: data.user_id,
        user_role: data.user_role,
        token_hash: data.token_hash,
        family_id: data.family_id,
        device_id: data.device_id ?? null,
        user_agent: data.user_agent ?? null,
        ip_address: data.ip_address ?? null,
        status: data.status ?? SESSION_STATUS.ACTIVE,
        revoked_reason: null,
        rotated_to_id: null,
        created_at: new Date(),
        last_used_at: data.last_used_at ?? null,
        expires_at: data.expires_at,
      };
      sessionStore.push(newSession);
      return { id: newSession.id, expires_at: newSession.expires_at };
    });

    (prisma.refresh_session.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => {
      const s = sessionStore.find((item) => item.id === where.id);
      return s ? { ...s } : null;
    });

    (prisma.refresh_session.findMany as jest.Mock).mockImplementation(async ({ where }: any) => {
      let list = sessionStore.filter((s) => s.user_id === where.user_id);
      if (where.status) list = list.filter((s) => s.status === where.status);
      return list.map((s) => ({ ...s }));
    });

    (prisma.refresh_session.update as jest.Mock).mockImplementation(async ({ where, data }: any) => {
      const s = sessionStore.find((item) => item.id === where.id);
      if (!s) throw new Error("Session not found");
      Object.assign(s, data);
      return { ...s };
    });

    (prisma.refresh_session.updateMany as jest.Mock).mockImplementation(async ({ where, data }: any) => {
      let matched = sessionStore.filter((s) => {
        if (where.id && s.id !== where.id) return false;
        if (where.user_id && s.user_id !== where.user_id) return false;
        if (where.family_id && s.family_id !== where.family_id) return false;
        if (where.status?.in && !where.status.in.includes(s.status)) return false;
        if (where.status && typeof where.status === "string" && s.status !== where.status) return false;
        if (where.status?.not && s.status === where.status.not) return false;
        return true;
      });
      matched.forEach((s) => Object.assign(s, data));
      return { count: matched.length };
    });

    (prisma.otp_challenge.findFirst as jest.Mock).mockImplementation(async ({ where }: any) => {
      const ch = otpChallengeStore.find(
        (c) => c.phone === where.phone && c.purpose === where.purpose && c.status === where.status
      );
      return ch ? { ...ch } : null;
    });

    (prisma.otp_challenge.update as jest.Mock).mockImplementation(async ({ where, data }: any) => {
      const ch = otpChallengeStore.find((c) => c.id === where.id);
      if (ch) Object.assign(ch, data);
      return ch;
    });

    (prisma.otp_challenge.updateMany as jest.Mock).mockImplementation(async ({ where, data }: any) => {
      const ch = otpChallengeStore.find((c) => c.id === where.id && c.status === where.status);
      if (ch) {
        Object.assign(ch, data);
        return { count: 1 };
      }
      return { count: 0 };
    });
  }

  beforeAll(async () => {
    hashedPassword = await hashPassword("StrongPass123!");
    adminToken = signAccessToken({ id: ADMIN_ID, role: UserRole.ADMIN, phone: "+919999000000" });
  });

  beforeEach(() => {
    workerStore = [
      {
        id: WORKER_A_ID,
        phone: "+919876543210",
        name: "Worker Alice",
        skill_type: "Plumber",
        skill_category_id: "c1111111-1111-4111-a111-111111111111",
        verification_status: "verified",
        deleted_at: null,
        password: hashedPassword,
      },
      {
        id: WORKER_B_ID,
        phone: "+919876543211",
        name: "Worker Bob",
        skill_type: "Electrician",
        skill_category_id: "c1111111-1111-4111-a111-111111111111",
        verification_status: "verified",
        deleted_at: null,
        password: hashedPassword,
      },
    ];

    customerStore = [
      {
        id: CUSTOMER_ID,
        phone: "+919876543220",
        name: "Customer Charlie",
        password: hashedPassword,
        deleted_at: null,
      },
    ];

    sessionStore = [];
    otpChallengeStore = [];
    setupPrismaMock();
  });

  // ==========================================================================
  // Scenario A: Existing session after suspension
  // ==========================================================================
  describe("Scenario A: Existing access token immediately rejected after suspension", () => {
    it("MUST reject existing access token on protected routes once worker is suspended", async () => {
      // 1. Worker has a valid access token
      const workerToken = signAccessToken({ id: WORKER_A_ID, role: UserRole.WORKER, phone: "+919876543210" });

      // Baseline: Before suspension, accessing /api/workers/me succeeds
      const beforeRes = await request(app)
        .get("/api/workers/me")
        .set("Authorization", `Bearer ${workerToken}`);
      expect(beforeRes.status).toBe(200);
      expect(beforeRes.body.success).toBe(true);

      // 2. Admin suspends the worker
      const suspendRes = await request(app)
        .post(`/api/admin/workers/${WORKER_A_ID}/suspend`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ reason: "Violation of safety policy" });
      expect(suspendRes.status).toBe(200);

      // 3. Same access token used on protected API immediately fails
      const afterRes = await request(app)
        .get("/api/workers/me")
        .set("Authorization", `Bearer ${workerToken}`);

      expect(afterRes.status).toBe(401);
      expect(afterRes.body.success).toBe(false);
      expect(afterRes.body.code).toBe("ACCOUNT_SUSPENDED");
      expect(afterRes.body.message).toMatch(/suspended/i);
    });
  });

  // ==========================================================================
  // Scenario B: Existing refresh session after suspension
  // ==========================================================================
  describe("Scenario B: Existing refresh session rejected after suspension", () => {
    it("MUST reject refresh attempt and revoke session family for suspended worker", async () => {
      // 1. Create active refresh session for Worker A
      const sessionResult = await sessionService.createSession({
        userId: WORKER_A_ID,
        userRole: UserRole.WORKER,
      });

      // 2. Admin suspends the worker
      await adminService.suspendWorker(WORKER_A_ID, { reason: "Terms violation" }, ADMIN_ID);

      // 3. Suspended worker attempts to refresh access token using the old refresh token
      const refreshRes = await request(app)
        .post("/api/auth/refresh")
        .send({ token: sessionResult.rawToken });

      expect(refreshRes.status).toBe(401);
      expect(refreshRes.body.success).toBe(false);
      // Either direct invalidation or account suspended rejection
      expect(["ACCOUNT_SUSPENDED", "INVALID_REFRESH_TOKEN", "REFRESH_TOKEN_REUSE"]).toContain(
        refreshRes.body.code
      );
      expect(refreshRes.body.data).toBeUndefined();
    });
  });

  // ==========================================================================
  // Scenario C: New login after suspension
  // ==========================================================================
  describe("Scenario C: New authentication rejected after suspension", () => {
    it("MUST reject password login for suspended worker", async () => {
      // Suspend worker
      await adminService.suspendWorker(WORKER_A_ID, { reason: "Suspended" }, ADMIN_ID);

      // Worker attempts password login
      const loginRes = await request(app)
        .post("/api/workers/login")
        .send({ phone: "+919876543210", password: "StrongPass123!" });

      expect(loginRes.status).toBe(401);
      expect(loginRes.body.success).toBe(false);
      expect(loginRes.body.token).toBeUndefined();
    });

    it("MUST reject OTP verification login for suspended worker", async () => {
      // Suspend worker
      await adminService.suspendWorker(WORKER_A_ID, { reason: "Fraud" }, ADMIN_ID);

      // Set up consumed OTP challenge
      const otpHashed = await bcrypt.hash("123456", 10);
      otpChallengeStore.push({
        id: "otp-challenge-1",
        phone: "+919876543210",
        purpose: "login",
        otp_hash: otpHashed,
        status: "ACTIVE",
        attempt_count: 0,
        expires_at: new Date(Date.now() + 600000),
      });

      // Worker attempts verify-otp
      const otpRes = await request(app)
        .post("/api/auth/verify-otp")
        .send({ phone: "+919876543210", otp: "123456", type: "login" });

      expect(otpRes.status).toBe(401);
      expect(otpRes.body.success).toBe(false);
      expect(otpRes.body.code).toBe("ACCOUNT_SUSPENDED");
      expect(otpRes.body.message).toMatch(/suspended/i);
    });
  });

  // ==========================================================================
  // Scenario D: Account deletion / deactivation
  // ==========================================================================
  describe("Scenario D: Soft-deleted / deactivated account rejected across all vectors", () => {
    it("MUST reject access token when customer is soft-deleted", async () => {
      const customerToken = signAccessToken({ id: CUSTOMER_ID, role: UserRole.CUSTOMER, phone: "+919876543220" });

      // Baseline: Customer accesses profile
      const beforeRes = await request(app)
        .get("/api/clients/me")
        .set("Authorization", `Bearer ${customerToken}`);
      expect(beforeRes.status).toBe(200);

      // Soft delete customer
      const cust = customerStore.find((c) => c.id === CUSTOMER_ID);
      if (cust) cust.deleted_at = new Date();

      // Access token must now be rejected centrally in authenticateJWT
      const afterRes = await request(app)
        .get("/api/clients/me")
        .set("Authorization", `Bearer ${customerToken}`);

      expect(afterRes.status).toBe(401);
      expect(afterRes.body.code).toBe("ACCOUNT_INACTIVE");
    });

    it("MUST reject refresh token for soft-deleted customer", async () => {
      const sessionResult = await sessionService.createSession({
        userId: CUSTOMER_ID,
        userRole: UserRole.CUSTOMER,
      });

      // Soft delete customer
      const cust = customerStore.find((c) => c.id === CUSTOMER_ID);
      if (cust) cust.deleted_at = new Date();

      // Refresh attempt must fail
      const refreshRes = await request(app)
        .post("/api/auth/refresh")
        .send({ token: sessionResult.rawToken });

      expect(refreshRes.status).toBe(401);
      expect(refreshRes.body.code).toBe("ACCOUNT_INACTIVE");
    });

    it("MUST reject password login for soft-deleted customer", async () => {
      const cust = customerStore.find((c) => c.id === CUSTOMER_ID);
      if (cust) cust.deleted_at = new Date();

      const loginRes = await request(app)
        .post("/api/clients/login")
        .send({ phone: "+919876543220", password: "StrongPass123!" });

      expect(loginRes.status).toBe(401);
      expect(loginRes.body.success).toBe(false);
    });
  });

  // ==========================================================================
  // Scenario E: Multi-device session revocation
  // ==========================================================================
  describe("Scenario E: Multi-device session revocation", () => {
    it("MUST revoke ALL active sessions across phone, tablet, and web when worker is suspended", async () => {
      // Create 3 sessions for Worker A
      const phoneSession = await sessionService.createSession({
        userId: WORKER_A_ID,
        userRole: UserRole.WORKER,
        deviceId: "device-phone-1",
        userAgent: "MobileApp/1.0",
      });

      const tabletSession = await sessionService.createSession({
        userId: WORKER_A_ID,
        userRole: UserRole.WORKER,
        deviceId: "device-tablet-1",
        userAgent: "TabletApp/1.0",
      });

      const webSession = await sessionService.createSession({
        userId: WORKER_A_ID,
        userRole: UserRole.WORKER,
        deviceId: "device-web-1",
        userAgent: "Mozilla/5.0",
      });

      expect(sessionStore.filter((s) => s.user_id === WORKER_A_ID && s.status === SESSION_STATUS.ACTIVE).length).toBe(3);

      // Admin suspends worker
      await adminService.suspendWorker(WORKER_A_ID, { reason: "Multi-device suspension" }, ADMIN_ID);

      // All sessions in store must now be REVOKED with reason SUSPENDED
      const workerSessions = sessionStore.filter((s) => s.user_id === WORKER_A_ID);
      expect(workerSessions.length).toBe(3);
      workerSessions.forEach((session) => {
        expect(session.status).toBe(SESSION_STATUS.REVOKED);
        expect(session.revoked_reason).toBe(REVOKE_REASON.SUSPENDED);
      });

      // Every device refresh attempt must fail
      const resPhone = await request(app).post("/api/auth/refresh").send({ token: phoneSession.rawToken });
      const resTablet = await request(app).post("/api/auth/refresh").send({ token: tabletSession.rawToken });
      const resWeb = await request(app).post("/api/auth/refresh").send({ token: webSession.rawToken });

      expect(resPhone.status).toBe(401);
      expect(resTablet.status).toBe(401);
      expect(resWeb.status).toBe(401);
    });
  });

  // ==========================================================================
  // Scenario F: Logout compatibility
  // ==========================================================================
  describe("Scenario F: Logout compatibility with suspended sessions", () => {
    it("MUST remain safe and idempotent when calling logout on an already-suspended session", async () => {
      const sessionResult = await sessionService.createSession({
        userId: WORKER_A_ID,
        userRole: UserRole.WORKER,
      });

      // Suspend worker
      await adminService.suspendWorker(WORKER_A_ID, { reason: "Suspended" }, ADMIN_ID);

      // User client triggers logout with old refresh token and bearer header
      const workerToken = signAccessToken({ id: WORKER_A_ID, role: UserRole.WORKER, phone: "+919876543210" });
      const logoutRes = await request(app)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${workerToken}`)
        .send({ refresh_token: sessionResult.rawToken });

      // Should either be rejected by auth middleware or safely succeed idempotently
      // In our design, authenticateJWT rejects suspended access token before reaching controller
      expect(logoutRes.status).toBe(401);
      expect(logoutRes.body.code).toBe("ACCOUNT_SUSPENDED");

      // Verify the session remains revoked and is not resurrected
      const s = sessionStore.find((item) => item.id === sessionResult.sessionId);
      expect(s?.status).toBe(SESSION_STATUS.REVOKED);
      expect(s?.revoked_reason).toBe(REVOKE_REASON.SUSPENDED);
    });
  });

  // ==========================================================================
  // Scenario G: Unsuspension / Reactivation isolation
  // ==========================================================================
  describe("Scenario G: Unsuspension isolation — old sessions remain permanently revoked", () => {
    it("MUST keep previously revoked sessions invalid after unsuspension; requires fresh authentication", async () => {
      const oldSession = await sessionService.createSession({
        userId: WORKER_A_ID,
        userRole: UserRole.WORKER,
      });

      // 1. Suspend worker
      await adminService.suspendWorker(WORKER_A_ID, { reason: "Temporary audit" }, ADMIN_ID);

      // 2. Admin unsuspends / verifies worker
      const worker = workerStore.find((w) => w.id === WORKER_A_ID);
      if (worker) {
        worker.verification_status = "verified";
        worker.deleted_at = null;
      }

      // 3. Attempting to use the old refresh token MUST FAIL (old session is still REVOKED)
      const refreshOld = await request(app)
        .post("/api/auth/refresh")
        .send({ token: oldSession.rawToken });

      expect(refreshOld.status).toBe(401);

      // 4. Fresh login works normally and issues a NEW valid session
      const freshLogin = await request(app)
        .post("/api/workers/login")
        .send({ phone: "+919876543210", password: "StrongPass123!" });

      expect(freshLogin.status).toBe(200);
      expect(freshLogin.body.success).toBe(true);
      expect(freshLogin.body.token).toBeDefined();
      expect(freshLogin.body.refreshToken).toBeDefined();
      expect(freshLogin.body.refreshToken).not.toBe(oldSession.rawToken);
    });
  });

  // ==========================================================================
  // Scenario H: Account isolation
  // ==========================================================================
  describe("Scenario H: Revocation account isolation", () => {
    it("MUST NOT revoke or disrupt Worker B sessions when Worker A is suspended", async () => {
      const sessionA = await sessionService.createSession({
        userId: WORKER_A_ID,
        userRole: UserRole.WORKER,
      });

      const sessionB = await sessionService.createSession({
        userId: WORKER_B_ID,
        userRole: UserRole.WORKER,
      });

      const tokenB = signAccessToken({ id: WORKER_B_ID, role: UserRole.WORKER, phone: "+919876543211" });

      // Suspend Worker A only
      await adminService.suspendWorker(WORKER_A_ID, { reason: "Alice suspended" }, ADMIN_ID);

      // Worker A sessions are revoked
      const storedA = sessionStore.find((s) => s.id === sessionA.sessionId);
      expect(storedA?.status).toBe(SESSION_STATUS.REVOKED);

      // Worker B sessions MUST remain ACTIVE
      const storedB = sessionStore.find((s) => s.id === sessionB.sessionId);
      expect(storedB?.status).toBe(SESSION_STATUS.ACTIVE);

      // Worker B access token MUST continue to work
      const bRes = await request(app)
        .get("/api/workers/me")
        .set("Authorization", `Bearer ${tokenB}`);
      expect(bRes.status).toBe(200);

      // Worker B refresh token MUST continue to work
      const bRefresh = await request(app)
        .post("/api/auth/refresh")
        .send({ token: sessionB.rawToken });
      expect(bRefresh.status).toBe(200);
      expect(bRefresh.body.data.token).toBeDefined();
    });
  });

  // ==========================================================================
  // Scenario I: Admin authorization
  // ==========================================================================
  describe("Scenario I: Privilege authorization for suspension endpoint", () => {
    it("MUST reject unauthenticated callers with 401", async () => {
      const res = await request(app).post(`/api/admin/workers/${WORKER_A_ID}/suspend`).send({});
      expect(res.status).toBe(401);
    });

    it("MUST reject worker callers with 403 Forbidden", async () => {
      const workerToken = signAccessToken({ id: WORKER_B_ID, role: UserRole.WORKER });
      const res = await request(app)
        .post(`/api/admin/workers/${WORKER_A_ID}/suspend`)
        .set("Authorization", `Bearer ${workerToken}`)
        .send({});
      expect(res.status).toBe(403);
    });

    it("MUST reject customer callers with 403 Forbidden", async () => {
      const customerToken = signAccessToken({ id: CUSTOMER_ID, role: UserRole.CUSTOMER });
      const res = await request(app)
        .post(`/api/admin/workers/${WORKER_A_ID}/suspend`)
        .set("Authorization", `Bearer ${customerToken}`)
        .send({});
      expect(res.status).toBe(403);
    });

    it("MUST allow authorized administrator with 200 OK", async () => {
      const res = await request(app)
        .post(`/api/admin/workers/${WORKER_A_ID}/suspend`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ reason: "Safety check" });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ==========================================================================
  // Scenario J: Audit event verification
  // ==========================================================================
  describe("Scenario J: Structured audit logging without credential leakage", () => {
    it("MUST emit structured audit record without passwords, hashes, or tokens", async () => {
      await adminService.suspendWorker(WORKER_A_ID, { reason: "Security violation" }, ADMIN_ID);

      expect((prisma as any).audit_log.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "WORKER_SUSPENDED",
            target_id: WORKER_A_ID,
            actor_id: ADMIN_ID,
            reason: "Security violation",
          }),
        })
      );

      const callArgs = ((prisma as any).audit_log.create as jest.Mock).mock.calls.find((call: any) =>
        call[0]?.data?.target_id === WORKER_A_ID
      );
      expect(callArgs).toBeDefined();
      const metadata = callArgs[0].data.metadata;
      expect(metadata?.newStatus).toBe("suspended");

      // Audit must NEVER contain passwords, hashes, or secrets
      const serialized = JSON.stringify(callArgs[0]);
      expect(serialized).not.toContain("StrongPass123!");
      expect(serialized).not.toContain("$2b$");
      expect(serialized).not.toContain("eyJ");
    });
  });

  // ==========================================================================
  // Scenario K: Idempotency under repeated suspension
  // ==========================================================================
  describe("Scenario K: Idempotency under repeated suspension", () => {
    it("MUST safely succeed when suspending an already-suspended worker without corruption", async () => {
      // First suspension
      const res1 = await adminService.suspendWorker(WORKER_A_ID, { reason: "First" }, ADMIN_ID);
      expect(res1?.verification_status).toBe("suspended");

      // Second suspension
      const res2 = await adminService.suspendWorker(WORKER_A_ID, { reason: "Second" }, ADMIN_ID);
      expect(res2?.verification_status).toBe("suspended");

      const worker = workerStore.find((w) => w.id === WORKER_A_ID);
      expect(worker?.verification_status).toBe("suspended");
      expect(worker?.deleted_at).not.toBeNull();
    });
  });

  // ==========================================================================
  // Scenario L: Socket.IO disconnection and handshake rejection
  // ==========================================================================
  describe("Scenario L: Socket.IO security enforcement", () => {
    it("MUST trigger disconnectUserSockets on worker suspension", async () => {
      const disconnectSpy = jest.spyOn(socketLifecycle, "disconnectUserSockets");

      await adminService.suspendWorker(WORKER_A_ID, { reason: "Socket invalidation test" }, ADMIN_ID);

      expect(disconnectSpy).toHaveBeenCalledWith(WORKER_A_ID, UserRole.WORKER);
      disconnectSpy.mockRestore();
    });

    it("MUST reject handshake in socketAuthMiddleware for suspended worker", async () => {
      // Suspend worker
      await adminService.suspendWorker(WORKER_A_ID, { reason: "Suspended" }, ADMIN_ID);

      const workerToken = signAccessToken({ id: WORKER_A_ID, role: UserRole.WORKER, phone: "+919876543210" });
      const mockSocket: any = {
        id: "mock-socket-1",
        handshake: {
          auth: { token: workerToken },
          headers: {},
        },
        data: {},
      };

      let nextError: any = null;
      await socketAuthMiddleware(mockSocket, (err) => {
        nextError = err;
      });

      expect(nextError).toBeDefined();
      expect(nextError?.message).toBe("Invalid authentication credentials");
      expect(mockSocket.data.user).toBeUndefined();
    });
  });
});
