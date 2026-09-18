import request from "supertest";
import bcrypt from "bcrypt";
import crypto from "crypto";
import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { sessionService } from "../src/features/auth/session.service";
import {
  SESSION_STATUS,
  REVOKE_REASON,
  REFRESH_TOKEN_SEPARATOR,
} from "../src/features/auth/session.types";
import { UserRole } from "../src/type/userRole";
import { signAccessToken, verifyAccessToken } from "../src/utils/authUtils";

// Mock dependencies that should not make real network calls
jest.mock("../src/config/bullmq", () => ({
  dispatchQueue: { add: jest.fn().mockResolvedValue({}) },
  timeoutQueue: { add: jest.fn().mockResolvedValue({}) },
}));

// In-memory backing store for mock prisma.refresh_session
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

let sessionStore: MockSession[] = [];

jest.mock("../src/config/prisma", () => {
  return {
    __esModule: true,
    default: {
      refresh_session: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
      },
      customer: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      worker: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      otp_challenge: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      $connect: jest.fn().mockResolvedValue(undefined),
      $disconnect: jest.fn().mockResolvedValue(undefined),
      $transaction: jest.fn(),
    },
  };
});

describe("P2 Security Suite — Issue #10: Server-Side Refresh Sessions", () => {
  const TEST_USER_ID = "11111111-1111-4111-a111-111111111111";
  const TEST_USER_ROLE = UserRole.CUSTOMER;
  const OTHER_USER_ID = "22222222-2222-4222-a222-222222222222";

  function setupPrismaSessionMock() {
    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
      if (typeof cb === "function") {
        return await cb(prisma);
      }
      return cb;
    });

    (prisma.refresh_session.create as jest.Mock).mockImplementation(async ({ data }: any) => {
      const record: MockSession = {
        id: crypto.randomUUID(),
        user_id: data.user_id,
        user_role: data.user_role,
        token_hash: data.token_hash,
        family_id: data.family_id,
        device_id: data.device_id ?? null,
        user_agent: data.user_agent ?? null,
        ip_address: data.ip_address ?? null,
        status: data.status || SESSION_STATUS.ACTIVE,
        revoked_reason: null,
        rotated_to_id: null,
        created_at: new Date(),
        last_used_at: null,
        expires_at: data.expires_at,
      };
      sessionStore.push(record);
      return { id: record.id, expires_at: record.expires_at };
    });

    (prisma.refresh_session.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => {
      const match = sessionStore.find((s) => s.id === where.id);
      return match ? { ...match } : null;
    });

    (prisma.refresh_session.findFirst as jest.Mock).mockImplementation(async ({ where }: any) => {
      const match = sessionStore.find((s) => {
        if (where.id && s.id !== where.id) return false;
        if (where.user_id && s.user_id !== where.user_id) return false;
        if (where.status && s.status !== where.status) return false;
        return true;
      });
      return match ? { ...match } : null;
    });

    (prisma.refresh_session.findMany as jest.Mock).mockImplementation(async ({ where, orderBy, select }: any) => {
      let matches = sessionStore.filter((s) => {
        if (where.user_id && s.user_id !== where.user_id) return false;
        if (where.status && s.status !== where.status) return false;
        if (where.expires_at?.gt && s.expires_at <= where.expires_at.gt) return false;
        return true;
      });

      if (orderBy?.created_at === "desc") {
        matches.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      }

      if (select) {
        return matches.map((m) => {
          const res: any = {};
          for (const key of Object.keys(select)) {
            if (select[key]) res[key] = (m as any)[key];
          }
          return res;
        });
      }

      return matches.map((m) => ({ ...m }));
    });

    (prisma.refresh_session.update as jest.Mock).mockImplementation(async ({ where, data }: any) => {
      const match = sessionStore.find((s) => s.id === where.id);
      if (!match) throw new Error("Record to update not found");
      Object.assign(match, data);
      return { ...match };
    });

    (prisma.refresh_session.updateMany as jest.Mock).mockImplementation(async ({ where, data }: any) => {
      let count = 0;
      for (const s of sessionStore) {
        let matches = true;
        if (where.id && s.id !== where.id) matches = false;
        if (where.user_id && s.user_id !== where.user_id) matches = false;
        if (where.family_id && s.family_id !== where.family_id) matches = false;
        if (where.status) {
          if (typeof where.status === "string" && s.status !== where.status) matches = false;
          if (where.status.not && s.status === where.status.not) matches = false;
          if (where.status.in && !where.status.in.includes(s.status)) matches = false;
        }

        if (matches) {
          Object.assign(s, data);
          count++;
        }
      }
      return { count };
    });

    (prisma.refresh_session.deleteMany as jest.Mock).mockImplementation(async ({ where }: any) => {
      const before = sessionStore.length;
      sessionStore = sessionStore.filter((s) => {
        if (where.expires_at?.lt && s.expires_at < where.expires_at.lt) return false;
        return true;
      });
      return { count: before - sessionStore.length };
    });
  }

  beforeEach(() => {
    sessionStore = [];
    jest.clearAllMocks();
    setupPrismaSessionMock();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. SESSION CREATION & INVARIANTS
  // ─────────────────────────────────────────────────────────────────────────────
  describe("1. Session Creation & Security Invariants", () => {
    it("MUST issue an opaque token in <sessionId>.<secret> format", async () => {
      const result = await sessionService.createSession({
        userId: TEST_USER_ID,
        userRole: TEST_USER_ROLE,
      });

      expect(result.rawToken).toBeDefined();
      const parts = result.rawToken.split(REFRESH_TOKEN_SEPARATOR);
      expect(parts.length).toBe(2);

      const [sessionId, secret] = parts;
      expect(sessionId).toBe(result.sessionId);
      expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(secret.length).toBe(64); // 32 bytes in hex = 64 characters
    });

    it("MUST NEVER persist the raw token or secret in plaintext; must store bcrypt hash", async () => {
      const result = await sessionService.createSession({
        userId: TEST_USER_ID,
        userRole: TEST_USER_ROLE,
      });

      const [, secret] = result.rawToken.split(REFRESH_TOKEN_SEPARATOR);
      const stored = sessionStore.find((s) => s.id === result.sessionId);

      expect(stored).toBeDefined();
      expect(stored!.token_hash).not.toBe(secret);
      expect(stored!.token_hash).not.toBe(result.rawToken);
      expect(stored!.token_hash.startsWith("$2")).toBe(true);

      const isMatch = await bcrypt.compare(secret, stored!.token_hash);
      expect(isMatch).toBe(true);
    });

    it("MUST initialize session with ACTIVE status and a unique family_id", async () => {
      const s1 = await sessionService.createSession({ userId: TEST_USER_ID, userRole: TEST_USER_ROLE });
      const s2 = await sessionService.createSession({ userId: TEST_USER_ID, userRole: TEST_USER_ROLE });

      const stored1 = sessionStore.find((s) => s.id === s1.sessionId)!;
      const stored2 = sessionStore.find((s) => s.id === s2.sessionId)!;

      expect(stored1.status).toBe(SESSION_STATUS.ACTIVE);
      expect(stored2.status).toBe(SESSION_STATUS.ACTIVE);
      expect(stored1.family_id).toBeDefined();
      expect(stored2.family_id).toBeDefined();
      expect(stored1.family_id).not.toBe(stored2.family_id);
    });

    it("MUST record optional device metadata (deviceId, userAgent, ipAddress)", async () => {
      const result = await sessionService.createSession({
        userId: TEST_USER_ID,
        userRole: TEST_USER_ROLE,
        deviceId: "device-xyz-123",
        userAgent: "Mozilla/5.0 TestBrowser",
        ipAddress: "192.168.1.100",
      });

      const stored = sessionStore.find((s) => s.id === result.sessionId)!;
      expect(stored.device_id).toBe("device-xyz-123");
      expect(stored.user_agent).toBe("Mozilla/5.0 TestBrowser");
      expect(stored.ip_address).toBe("192.168.1.100");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. SESSION ROTATION
  // ─────────────────────────────────────────────────────────────────────────────
  describe("2. Session Rotation Lifecycle", () => {
    it("MUST rotate active session: invalidate old, link rotated_to_id, issue new token in same family", async () => {
      const initial = await sessionService.createSession({
        userId: TEST_USER_ID,
        userRole: TEST_USER_ROLE,
      });

      const rotated = await sessionService.rotateSession(initial.rawToken);

      expect(rotated.newRawToken).toBeDefined();
      expect(rotated.newRawToken).not.toBe(initial.rawToken);
      expect(rotated.userId).toBe(TEST_USER_ID);
      expect(rotated.userRole).toBe(TEST_USER_ROLE);

      const oldSession = sessionStore.find((s) => s.id === initial.sessionId)!;
      const newSession = sessionStore.find((s) => s.id === rotated.newSessionId)!;

      expect(oldSession.status).toBe(SESSION_STATUS.ROTATED);
      expect(oldSession.rotated_to_id).toBe(newSession.id);
      expect(newSession.status).toBe(SESSION_STATUS.ACTIVE);
      expect(newSession.family_id).toBe(oldSession.family_id);
    });

    it("MUST allow chaining multiple rotations in the same family", async () => {
      const s1 = await sessionService.createSession({ userId: TEST_USER_ID, userRole: TEST_USER_ROLE });
      const s2 = await sessionService.rotateSession(s1.rawToken);
      const s3 = await sessionService.rotateSession(s2.newRawToken);

      const rec1 = sessionStore.find((s) => s.id === s1.sessionId)!;
      const rec2 = sessionStore.find((s) => s.id === s2.newSessionId)!;
      const rec3 = sessionStore.find((s) => s.id === s3.newSessionId)!;

      expect(rec1.status).toBe(SESSION_STATUS.ROTATED);
      expect(rec2.status).toBe(SESSION_STATUS.ROTATED);
      expect(rec3.status).toBe(SESSION_STATUS.ACTIVE);

      expect(rec1.family_id).toBe(rec2.family_id);
      expect(rec2.family_id).toBe(rec3.family_id);
    });

    it("HTTP POST /api/auth/refresh MUST return new access token and rotated refreshToken", async () => {
      const session = await sessionService.createSession({
        userId: TEST_USER_ID,
        userRole: TEST_USER_ROLE,
      });

      const res = await request(app)
        .post("/api/auth/refresh")
        .send({ token: session.rawToken });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.token).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
      expect(res.body.data.refreshToken).not.toBe(session.rawToken);

      const verified = verifyAccessToken(res.body.data.token);
      expect(verified).not.toBeNull();
      expect(verified.id).toBe(TEST_USER_ID);
      expect(verified.role).toBe(TEST_USER_ROLE);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. REUSE DETECTION & TOKEN FAMILY REVOCATION (CRITICAL P0 INVARIANT)
  // ─────────────────────────────────────────────────────────────────────────────
  describe("3. Reuse Detection & Family Revocation", () => {
    it("MUST detect reuse of an already-rotated token and revoke the ENTIRE token family", async () => {
      // Step 1: Create session (token A)
      const sessionA = await sessionService.createSession({
        userId: TEST_USER_ID,
        userRole: TEST_USER_ROLE,
      });

      // Step 2: Legitimate rotation (token A -> token B)
      const sessionB = await sessionService.rotateSession(sessionA.rawToken);

      // Step 3: Attacker replays token A (which was already rotated)
      await expect(sessionService.rotateSession(sessionA.rawToken)).rejects.toMatchObject({
        code: "REFRESH_TOKEN_REUSE",
      });

      // Verification: Both sessions in family must now be REVOKED
      const recA = sessionStore.find((s) => s.id === sessionA.sessionId)!;
      const recB = sessionStore.find((s) => s.id === sessionB.newSessionId)!;

      expect(recA.status).toBe(SESSION_STATUS.REVOKED);
      expect(recA.revoked_reason).toBe(REVOKE_REASON.REUSE);
      expect(recB.status).toBe(SESSION_STATUS.REVOKED);
      expect(recB.revoked_reason).toBe(REVOKE_REASON.REUSE);

      // Step 4: Subsequent use of token B must now ALSO fail
      await expect(sessionService.rotateSession(sessionB.newRawToken)).rejects.toThrow();
    });

    it("HTTP POST /api/auth/refresh MUST return 401 REFRESH_TOKEN_REUSE when replaying old token", async () => {
      const sessionA = await sessionService.createSession({
        userId: TEST_USER_ID,
        userRole: TEST_USER_ROLE,
      });

      // Rotate once
      await request(app)
        .post("/api/auth/refresh")
        .send({ token: sessionA.rawToken });

      // Replay token A
      const replayRes = await request(app)
        .post("/api/auth/refresh")
        .send({ token: sessionA.rawToken });

      expect(replayRes.status).toBe(401);
      expect(replayRes.body.success).toBe(false);
      expect(replayRes.body.code).toBe("REFRESH_TOKEN_REUSE");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. EXPIRATION ENFORCEMENT
  // ─────────────────────────────────────────────────────────────────────────────
  describe("4. Session Expiration Enforcement", () => {
    it("MUST reject rotation if session has expired past expires_at", async () => {
      const session = await sessionService.createSession({
        userId: TEST_USER_ID,
        userRole: TEST_USER_ROLE,
        ttlDays: -1, // Already expired in the past
      });

      await expect(sessionService.rotateSession(session.rawToken)).rejects.toMatchObject({
        code: "REFRESH_SESSION_EXPIRED",
      });
    });

    it("HTTP POST /api/auth/refresh MUST return 401 REFRESH_SESSION_EXPIRED for expired session", async () => {
      const session = await sessionService.createSession({
        userId: TEST_USER_ID,
        userRole: TEST_USER_ROLE,
        ttlDays: -1,
      });

      const res = await request(app)
        .post("/api/auth/refresh")
        .send({ token: session.rawToken });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("REFRESH_SESSION_EXPIRED");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. LOGOUT & REVOCATION
  // ─────────────────────────────────────────────────────────────────────────────
  describe("5. Logout & Revocation Semantics", () => {
    it("MUST revoke the session on POST /api/auth/logout with valid token and bearer auth", async () => {
      const session = await sessionService.createSession({
        userId: TEST_USER_ID,
        userRole: TEST_USER_ROLE,
      });

      const accessToken = signAccessToken({ id: TEST_USER_ID, role: TEST_USER_ROLE });

      const res = await request(app)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ refresh_token: session.rawToken });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const stored = sessionStore.find((s) => s.id === session.sessionId)!;
      expect(stored.status).toBe(SESSION_STATUS.REVOKED);
      expect(stored.revoked_reason).toBe(REVOKE_REASON.LOGOUT);

      // Attempting to refresh using revoked session must now fail
      const refreshRes = await request(app)
        .post("/api/auth/refresh")
        .send({ token: session.rawToken });

      expect(refreshRes.status).toBe(401);
    });

    it("MUST reject logout attempt without Authorization header", async () => {
      const session = await sessionService.createSession({
        userId: TEST_USER_ID,
        userRole: TEST_USER_ROLE,
      });

      const res = await request(app)
        .post("/api/auth/logout")
        .send({ refresh_token: session.rawToken });

      expect(res.status).toBe(401);
    });

    it("MUST prevent cross-user revocation: User A cannot revoke User B session", async () => {
      const sessionB = await sessionService.createSession({
        userId: OTHER_USER_ID,
        userRole: TEST_USER_ROLE,
      });

      // User A tries to logout User B's session
      const accessTokenA = signAccessToken({ id: TEST_USER_ID, role: TEST_USER_ROLE });

      const res = await request(app)
        .post("/api/auth/logout")
        .set("Authorization", `Bearer ${accessTokenA}`)
        .send({ refresh_token: sessionB.rawToken });

      // The call succeeds idempotently without error leakage, BUT sessionB was NOT revoked
      expect(res.status).toBe(200);

      const storedB = sessionStore.find((s) => s.id === sessionB.sessionId)!;
      expect(storedB.status).toBe(SESSION_STATUS.ACTIVE); // Untouched!
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. SESSION MANAGEMENT (GET / SESSIONS & DELETE / SESSIONS)
  // ─────────────────────────────────────────────────────────────────────────────
  describe("6. Session Management Endpoints", () => {
    it("GET /api/auth/sessions MUST list only active sessions for the calling user, never leaking token_hash", async () => {
      await sessionService.createSession({ userId: TEST_USER_ID, userRole: TEST_USER_ROLE, deviceId: "phone-1" });
      await sessionService.createSession({ userId: TEST_USER_ID, userRole: TEST_USER_ROLE, deviceId: "laptop-1" });
      await sessionService.createSession({ userId: OTHER_USER_ID, userRole: TEST_USER_ROLE, deviceId: "other-user-device" });

      const accessToken = signAccessToken({ id: TEST_USER_ID, role: TEST_USER_ROLE });

      const res = await request(app)
        .get("/api/auth/sessions")
        .set("Authorization", `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBe(2);

      for (const item of res.body.data) {
        expect(item.token_hash).toBeUndefined();
        expect(item.secret).toBeUndefined();
        expect(item.user_id).toBe(TEST_USER_ID);
      }
    });

    it("DELETE /api/auth/sessions/:sessionId MUST allow user to revoke their own session", async () => {
      const session = await sessionService.createSession({
        userId: TEST_USER_ID,
        userRole: TEST_USER_ROLE,
      });

      const accessToken = signAccessToken({ id: TEST_USER_ID, role: TEST_USER_ROLE });

      const res = await request(app)
        .delete(`/api/auth/sessions/${session.sessionId}`)
        .set("Authorization", `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const stored = sessionStore.find((s) => s.id === session.sessionId)!;
      expect(stored.status).toBe(SESSION_STATUS.REVOKED);
    });

    it("DELETE /api/auth/sessions/:sessionId MUST NOT allow user A to revoke user B session", async () => {
      const sessionB = await sessionService.createSession({
        userId: OTHER_USER_ID,
        userRole: TEST_USER_ROLE,
      });

      const accessTokenA = signAccessToken({ id: TEST_USER_ID, role: TEST_USER_ROLE });

      const res = await request(app)
        .delete(`/api/auth/sessions/${sessionB.sessionId}`)
        .set("Authorization", `Bearer ${accessTokenA}`);

      expect(res.status).toBe(200);

      const storedB = sessionStore.find((s) => s.id === sessionB.sessionId)!;
      expect(storedB.status).toBe(SESSION_STATUS.ACTIVE); // Still active!
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. INPUT SANITIZATION & MALFORMED TOKENS
  // ─────────────────────────────────────────────────────────────────────────────
  describe("7. Malformed Token & Error Handling", () => {
    it("MUST reject tokens with missing separator or invalid UUID without 500 error", async () => {
      const badTokens = [
        "not-a-valid-token",
        "invalid-uuid.1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
        "11111111-1111-4111-a111-111111111111.shortsecret",
        "",
      ];

      for (const badToken of badTokens) {
        const res = await request(app)
          .post("/api/auth/refresh")
          .send({ token: badToken });

        expect(res.status).toBe(badToken === "" ? 400 : 401);
        expect(res.body.success).toBe(false);
      }
    });

    it("MUST reject tampered secret with valid UUID (bcrypt mismatch)", async () => {
      const session = await sessionService.createSession({
        userId: TEST_USER_ID,
        userRole: TEST_USER_ROLE,
      });

      // Tamper the secret part with 64 characters of zeroes
      const tamperedToken = `${session.sessionId}.${"0".repeat(64)}`;

      const res = await request(app)
        .post("/api/auth/refresh")
        .send({ token: tamperedToken });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe("INVALID_REFRESH_TOKEN");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. MAINTENANCE & EXPIRED CLEANUP
  // ─────────────────────────────────────────────────────────────────────────────
  describe("8. Session Cleanup / Maintenance", () => {
    it("MUST delete expired/revoked sessions older than retention days and preserve active ones", async () => {
      const activeSession = await sessionService.createSession({
        userId: TEST_USER_ID,
        userRole: TEST_USER_ROLE,
      });

      // Manually add an old expired session
      sessionStore.push({
        id: crypto.randomUUID(),
        user_id: TEST_USER_ID,
        user_role: TEST_USER_ROLE,
        token_hash: "hash",
        family_id: crypto.randomUUID(),
        device_id: null,
        user_agent: null,
        ip_address: null,
        status: SESSION_STATUS.REVOKED,
        revoked_reason: REVOKE_REASON.LOGOUT,
        rotated_to_id: null,
        created_at: new Date(Date.now() - 100 * 86400000),
        last_used_at: null,
        expires_at: new Date(Date.now() - 60 * 86400000),
      });

      const { deletedCount } = await sessionService.cleanupExpiredSessions(30);
      expect(deletedCount).toBe(1);

      const remaining = sessionStore.find((s) => s.id === activeSession.sessionId);
      expect(remaining).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. ACCOUNT REVOCATION & ADMIN ACTIONS
  // ─────────────────────────────────────────────────────────────────────────────
  describe("9. Account Suspension & Bulk Revocation", () => {
    it("MUST revoke all active and rotated sessions for a suspended user without affecting other users", async () => {
      // User 1 has 2 sessions
      const u1s1 = await sessionService.createSession({ userId: TEST_USER_ID, userRole: TEST_USER_ROLE });
      const u1s2 = await sessionService.createSession({ userId: TEST_USER_ID, userRole: TEST_USER_ROLE });
      // User 2 has 1 session
      const u2s1 = await sessionService.createSession({ userId: OTHER_USER_ID, userRole: TEST_USER_ROLE });

      const revokedCount = await sessionService.revokeAllUserSessions(TEST_USER_ID, REVOKE_REASON.SUSPENDED);
      expect(revokedCount).toBe(2);

      const rec1 = sessionStore.find((s) => s.id === u1s1.sessionId)!;
      const rec2 = sessionStore.find((s) => s.id === u1s2.sessionId)!;
      const recOther = sessionStore.find((s) => s.id === u2s1.sessionId)!;

      expect(rec1.status).toBe(SESSION_STATUS.REVOKED);
      expect(rec1.revoked_reason).toBe(REVOKE_REASON.SUSPENDED);
      expect(rec2.status).toBe(SESSION_STATUS.REVOKED);
      expect(rec2.revoked_reason).toBe(REVOKE_REASON.SUSPENDED);

      // Other user unaffected
      expect(recOther.status).toBe(SESSION_STATUS.ACTIVE);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. MULTI-DEVICE LIFECYCLE
  // ─────────────────────────────────────────────────────────────────────────────
  describe("10. Multi-Device Session Isolation", () => {
    it("MUST allow independent lifecycle for different devices: revoking device A leaves device B functional", async () => {
      const phoneSession = await sessionService.createSession({
        userId: TEST_USER_ID,
        userRole: TEST_USER_ROLE,
        deviceId: "phone-device-id",
      });

      const laptopSession = await sessionService.createSession({
        userId: TEST_USER_ID,
        userRole: TEST_USER_ROLE,
        deviceId: "laptop-device-id",
      });

      // Revoke phone session
      await sessionService.revokeSession(phoneSession.sessionId, TEST_USER_ID, REVOKE_REASON.LOGOUT);

      const phoneRec = sessionStore.find((s) => s.id === phoneSession.sessionId)!;
      const laptopRec = sessionStore.find((s) => s.id === laptopSession.sessionId)!;

      expect(phoneRec.status).toBe(SESSION_STATUS.REVOKED);
      expect(laptopRec.status).toBe(SESSION_STATUS.ACTIVE);

      // Laptop session can still rotate successfully
      const rotatedLaptop = await sessionService.rotateSession(laptopSession.rawToken);
      expect(rotatedLaptop.newRawToken).toBeDefined();

      const newLaptopRec = sessionStore.find((s) => s.id === rotatedLaptop.newSessionId)!;
      expect(newLaptopRec.status).toBe(SESSION_STATUS.ACTIVE);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. CONCURRENT ROTATION RACE CONDITION SIMULATION
  // ─────────────────────────────────────────────────────────────────────────────
  describe("11. Concurrency Safety Gate", () => {
    it("MUST detect mid-air race condition where atomic updateMany returns count 0, revoking the family", async () => {
      const session = await sessionService.createSession({
        userId: TEST_USER_ID,
        userRole: TEST_USER_ROLE,
      });

      // Simulate a race condition where DB updateMany returns 0 (another worker updated it first)
      const origUpdateMany = prisma.refresh_session.updateMany;
      (prisma.refresh_session.updateMany as jest.Mock).mockImplementationOnce(async () => {
        return { count: 0 };
      });

      await expect(sessionService.rotateSession(session.rawToken)).rejects.toMatchObject({
        code: "REFRESH_TOKEN_REUSE",
      });

      // Restore
      (prisma.refresh_session.updateMany as jest.Mock).mockImplementation(origUpdateMany);
    });
  });
});
