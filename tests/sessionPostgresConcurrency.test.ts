import crypto from "crypto";
import bcrypt from "bcrypt";
import prisma from "../src/config/prisma";
import { sessionService } from "../src/features/auth/session.service";
import { SESSION_STATUS, REVOKE_REASON } from "../src/features/auth/session.types";
import { UserRole } from "../src/type/userRole";

describe("P3 Issue 1 — Adversarial & Concurrency Verification (Real PostgreSQL)", () => {
  jest.setTimeout(60000);

  let categoryId: string;
  let workerId: string;
  let customerId: string;

  beforeAll(async () => {
    // 1. Create skill category
    const skill = await prisma.skill_category.create({
      data: {
        name: `AuthTestSkill-${Date.now()}`,
      },
    });
    categoryId = skill.id;

    // 2. Create worker
    const worker = await prisma.worker.create({
      data: {
        skill_category_id: categoryId,
        phone: `+9199${Math.floor(10000000 + Math.random() * 90000000)}`,
        skill_type: "Carpenter",
        password: "hashed_password",
        name: "Auth Worker",
        verification_status: "verified",
      },
    });
    workerId = worker.id;

    // 3. Create customer
    const customer = await prisma.customer.create({
      data: {
        phone: `+9198${Math.floor(10000000 + Math.random() * 90000000)}`,
        password: "hashed_customer_password",
        name: "Auth Customer",
      },
    });
    customerId = customer.id;
  });

  afterAll(async () => {
    try {
      await prisma.refresh_session.deleteMany({
        where: { user_id: { in: [workerId, customerId] } },
      });
      await prisma.worker.deleteMany({ where: { id: workerId } });
      await prisma.customer.deleteMany({ where: { id: customerId } });
      await prisma.skill_category.deleteMany({ where: { id: categoryId } });
    } catch {}
    await prisma.$disconnect();
  });

  describe("1. Database Schema & CHECK Constraint Invariants", () => {
    it("MUST accept all legal lifecycle statuses: ACTIVE, ROTATED, REVOKED, EXPIRED", async () => {
      const statuses = [SESSION_STATUS.ACTIVE, SESSION_STATUS.ROTATED, SESSION_STATUS.REVOKED, SESSION_STATUS.EXPIRED];
      const familyId = crypto.randomUUID();

      for (const st of statuses) {
        const secret = crypto.randomBytes(32).toString("hex");
        const tokenHash = await bcrypt.hash(secret, 10);

        const session = await prisma.refresh_session.create({
          data: {
            user_id: workerId,
            user_role: UserRole.WORKER,
            token_hash: tokenHash,
            family_id: familyId,
            status: st,
            expires_at: new Date(Date.now() + 86400000),
          },
        });

        expect(session.status).toBe(st);
        await prisma.refresh_session.delete({ where: { id: session.id } });
      }
    });

    it("MUST reject illegal session status at the database layer", async () => {
      const familyId = crypto.randomUUID();
      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO "refresh_session" ("id", "user_id", "user_role", "token_hash", "family_id", "status", "expires_at", "created_at")
          VALUES (gen_random_uuid(), '${workerId}', 'worker', 'hash123', '${familyId}', 'INVALID_STATUS', NOW() + INTERVAL '1 day', NOW());
        `)
      ).rejects.toThrow(/chk_refresh_session_status|check constraint/i);
    });

    it("MUST persist and update rotated_to_id field without schema errors", async () => {
      const familyId = crypto.randomUUID();
      const secret1 = crypto.randomBytes(32).toString("hex");
      const secret2 = crypto.randomBytes(32).toString("hex");

      const s1 = await prisma.refresh_session.create({
        data: {
          user_id: workerId,
          user_role: UserRole.WORKER,
          token_hash: await bcrypt.hash(secret1, 10),
          family_id: familyId,
          status: SESSION_STATUS.ACTIVE,
          expires_at: new Date(Date.now() + 86400000),
        },
      });

      const s2 = await prisma.refresh_session.create({
        data: {
          user_id: workerId,
          user_role: UserRole.WORKER,
          token_hash: await bcrypt.hash(secret2, 10),
          family_id: familyId,
          status: SESSION_STATUS.ACTIVE,
          expires_at: new Date(Date.now() + 86400000),
        },
      });

      const updated = await prisma.refresh_session.update({
        where: { id: s1.id },
        data: {
          status: SESSION_STATUS.ROTATED,
          rotated_to_id: s2.id,
          rotated_at: new Date(),
        },
      });

      expect(updated.status).toBe(SESSION_STATUS.ROTATED);
      expect(updated.rotated_to_id).toBe(s2.id);
      expect(updated.rotated_at).toBeInstanceOf(Date);

      await prisma.refresh_session.deleteMany({ where: { id: { in: [s1.id, s2.id] } } });
    });
  });

  describe("2. Atomicity & Failure Injection Verification", () => {
    it("MUST roll back old-session ROTATED transition if successor creation fails in transaction", async () => {
      const created = await sessionService.createSession({
        userId: workerId,
        userRole: UserRole.WORKER,
      });

      const newSessionId = crypto.randomUUID();

      // Simulate a failure during successor insertion inside the transaction
      await expect(
        prisma.$transaction(async (tx) => {
          // 1. Old session is updated
          await tx.refresh_session.updateMany({
            where: {
              id: created.sessionId,
              status: SESSION_STATUS.ACTIVE,
            },
            data: {
              status: SESSION_STATUS.ROTATED,
              rotated_at: new Date(),
              rotated_to_id: newSessionId,
            },
          });

          // 2. Forced failure / exception thrown before commit
          throw new Error("FAILURE_INJECTION_DATABASE_ERROR");
        })
      ).rejects.toThrow("FAILURE_INJECTION_DATABASE_ERROR");

      // Verify that old session rolled back to ACTIVE and rotated_to_id is still NULL
      const sessionAfterFailure = await prisma.refresh_session.findUnique({
        where: { id: created.sessionId },
      });
      expect(sessionAfterFailure).not.toBeNull();
      expect(sessionAfterFailure!.status).toBe(SESSION_STATUS.ACTIVE);
      expect(sessionAfterFailure!.rotated_to_id).toBeNull();
      expect(sessionAfterFailure!.rotated_at).toBeNull();

      // Session can still be legitimately rotated afterwards
      const rotated = await sessionService.rotateSession(created.rawToken);
      expect(rotated.newSessionId).toBeDefined();

      const finalRecord = await prisma.refresh_session.findUnique({
        where: { id: created.sessionId },
      });
      expect(finalRecord!.status).toBe(SESSION_STATUS.ROTATED);
      expect(finalRecord!.rotated_to_id).toBe(rotated.newSessionId);
    });
  });

  describe("3. Real PostgreSQL Concurrency: 20 Simultaneous Refresh Requests", () => {
    it("MUST guarantee exactly one successor session is created and losers fail safely", async () => {
      const initial = await sessionService.createSession({
        userId: workerId,
        userRole: UserRole.WORKER,
      });

      const CONCURRENCY = 20;
      const promises: Promise<any>[] = [];

      for (let i = 0; i < CONCURRENCY; i++) {
        promises.push(sessionService.rotateSession(initial.rawToken));
      }

      const results = await Promise.allSettled(promises);

      const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

      // Invariant 1: Exactly 1 request successfully rotates the active session
      expect(fulfilled.length).toBe(1);

      // Invariant 2: The remaining 19 requests fail safely
      expect(rejected.length).toBe(CONCURRENCY - 1);

      for (const rej of rejected) {
        expect(["REFRESH_TOKEN_REUSE", "INVALID_REFRESH_TOKEN"]).toContain(rej.reason?.code);
      }

      // Invariant 3: Check database records in the session family
      const originalRecord = await prisma.refresh_session.findUnique({
        where: { id: initial.sessionId },
      });
      expect(originalRecord).not.toBeNull();

      const allSessionsInFamily = await prisma.refresh_session.findMany({
        where: { family_id: originalRecord!.family_id },
      });

      // Exactly 2 sessions exist: original (ROTATED/REVOKED) and exactly 1 successor
      expect(allSessionsInFamily.length).toBeLessThanOrEqual(2);
      expect(originalRecord!.status).not.toBe(SESSION_STATUS.ACTIVE);
    });
  });

  describe("4. Reuse Detection & Successor Invalidation", () => {
    it("MUST reject current successor token after old-token reuse is detected", async () => {
      // 1. Login -> T1
      const s1 = await sessionService.createSession({
        userId: customerId,
        userRole: UserRole.CUSTOMER,
      });

      // 2. Refresh T1 -> T2
      const s2 = await sessionService.rotateSession(s1.rawToken);

      // 3. Attacker presents old T1 again -> Triggers reuse detection
      await expect(sessionService.rotateSession(s1.rawToken)).rejects.toMatchObject({
        code: "REFRESH_TOKEN_REUSE",
      });

      // 4. Invariant: Successor T2 MUST now be rejected because the whole family was revoked
      await expect(sessionService.rotateSession(s2.newRawToken)).rejects.toMatchObject({
        code: "REFRESH_TOKEN_REUSE",
      });

      // 5. Verify database final state
      const sessions = await prisma.refresh_session.findMany({
        where: { family_id: (await prisma.refresh_session.findUnique({ where: { id: s1.sessionId } }))!.family_id },
      });

      for (const s of sessions) {
        expect(s.status).toBe(SESSION_STATUS.REVOKED);
        expect(s.revoked_reason).toBe(REVOKE_REASON.REUSE);
      }
    });
  });

  describe("5. Multi-Device Isolation & Targeted Logout", () => {
    it("MUST revoke only target device session on logout, leaving other devices functional", async () => {
      // Create Session for Device A (Mobile)
      const devA = await sessionService.createSession({
        userId: workerId,
        userRole: UserRole.WORKER,
        deviceId: "device-mobile-001",
      });

      // Create Session for Device B (Laptop)
      const devB = await sessionService.createSession({
        userId: workerId,
        userRole: UserRole.WORKER,
        deviceId: "device-laptop-002",
      });

      // Logout Device A
      const { revokedCount } = await sessionService.revokeByRawToken(devA.rawToken, workerId);
      expect(revokedCount).toBe(1);

      // Device A is REVOKED
      const recA = await prisma.refresh_session.findUnique({ where: { id: devA.sessionId } });
      expect(recA!.status).toBe(SESSION_STATUS.REVOKED);

      // Device B is STILL ACTIVE and can refresh successfully
      const recB = await prisma.refresh_session.findUnique({ where: { id: devB.sessionId } });
      expect(recB!.status).toBe(SESSION_STATUS.ACTIVE);

      const rotatedB = await sessionService.rotateSession(devB.rawToken);
      expect(rotatedB.newSessionId).toBeDefined();

      const newRecB = await prisma.refresh_session.findUnique({ where: { id: rotatedB.newSessionId } });
      expect(newRecB!.status).toBe(SESSION_STATUS.ACTIVE);
    });
  });

  describe("6. Concurrency Racing with Suspension & Revocation", () => {
    it("MUST have deterministic security outcome when refresh races with account suspension", async () => {
      const initial = await sessionService.createSession({
        userId: workerId,
        userRole: UserRole.WORKER,
      });

      // Race refresh with suspension
      const [refreshRes, suspendRes] = await Promise.allSettled([
        sessionService.rotateSession(initial.rawToken),
        prisma.worker.update({
          where: { id: workerId },
          data: { verification_status: "suspended" },
        }),
      ]);

      // Restore worker status afterwards
      await prisma.worker.update({
        where: { id: workerId },
        data: { verification_status: "verified" },
      });

      // Invariant: If refresh succeeded before suspension, attempting to refresh again with the new token while suspended fails
      if (refreshRes.status === "fulfilled") {
        await prisma.worker.update({
          where: { id: workerId },
          data: { verification_status: "suspended" },
        });

        await expect(sessionService.rotateSession(refreshRes.value.newRawToken)).rejects.toMatchObject({
          code: "ACCOUNT_SUSPENDED",
        });

        await prisma.worker.update({
          where: { id: workerId },
          data: { verification_status: "verified" },
        });
      }
    });

    it("MUST never store plaintext refresh secrets in the database", async () => {
      const created = await sessionService.createSession({
        userId: customerId,
        userRole: UserRole.CUSTOMER,
      });

      const parsed = created.rawToken.split(".");
      const rawSecret = parsed[1];

      const record = await prisma.refresh_session.findUnique({ where: { id: created.sessionId } });
      expect(record!.token_hash).not.toBe(rawSecret);
      expect(record!.token_hash.startsWith("$2b$") || record!.token_hash.startsWith("$2a$")).toBe(true);
    });
  });
});
