import { auditService } from "../src/features/audit/audit.service";
import { AuditAction } from "../src/features/audit/audit.types";
import { adminService } from "../src/features/admin/adminServices";
import prisma from "../src/config/prisma";

describe("Issue 49 - Admin & Security Audit Logging", () => {
  const testWorkerId = "00000000-0000-4000-d000-000000000001";
  const testAdminId = "00000000-0000-4000-d000-000000000002";

  beforeAll(async () => {
    let category = await prisma.skill_category.findFirst();
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "Helper", description: "General Helper" },
      });
    }

    await prisma.worker.upsert({
      where: { id: testWorkerId },
      update: { phone: "+919999000003", skill_category_id: category.id },
      create: {
        id: testWorkerId,
        phone: "+919999000003",
        name: "Audit Test Worker",
        password: "hash",
        skill_type: "Helper",
        skill_category_id: category.id,
      },
    });
  });

  afterAll(async () => {
    await (prisma as any).audit_log.deleteMany({
      where: {
        OR: [{ actor_id: testAdminId }, { target_id: testWorkerId }],
      },
    }).catch(() => {});
    await prisma.worker.deleteMany({
      where: { id: testWorkerId },
    }).catch(() => {});
    await prisma.$disconnect();
  });

  describe("Metadata Sanitization", () => {
    it("redacts sensitive fields (passwords, OTPs, tokens, secrets) from audit metadata", () => {
      const rawMetadata = {
        workerId: testWorkerId,
        password: "super_secret_password",
        otp: "123456",
        access_token: "jwt.header.payload",
        nested: {
          secret: "hidden_key",
          validField: "safe_value",
        },
      };

      const sanitized = auditService.sanitizeMetadata(rawMetadata);

      expect(sanitized?.password).toBe("[REDACTED]");
      expect(sanitized?.otp).toBe("[REDACTED]");
      expect(sanitized?.access_token).toBe("[REDACTED]");
      expect(sanitized?.nested?.secret).toBe("[REDACTED]");
      expect(sanitized?.nested?.validField).toBe("safe_value");
    });
  });

  describe("Durable Event Persistence & Transactional Guarantees", () => {
    it("persists audit events durably in PostgreSQL with correlation ID", async () => {
      const event = await auditService.recordEvent(prisma, {
        actorId: testAdminId,
        actorRole: "admin",
        action: AuditAction.WORKER_SUSPENDED,
        targetType: "worker",
        targetId: testWorkerId,
        reason: "Compliance violation test",
        metadata: { status: "suspended" },
      });

      expect(event.id).toBeDefined();
      expect(event.action).toBe(AuditAction.WORKER_SUSPENDED);
      expect(event.targetId).toBe(testWorkerId);

      // Verify in database
      const inDb = await (prisma as any).audit_log.findUnique({
        where: { id: event.id },
      });
      expect(inDb).toBeDefined();
      expect(inDb.actor_id).toBe(testAdminId);
    });

    it("records audit event atomically during admin worker suspension", async () => {
      await adminService.suspendWorker(testWorkerId, { reason: "Automated test suspension" }, testAdminId);

      // Check audit log
      const logs = await (prisma as any).audit_log.findMany({
        where: {
          actor_id: testAdminId,
          target_id: testWorkerId,
          action: AuditAction.WORKER_SUSPENDED,
        },
        orderBy: { created_at: "desc" },
      });

      expect(logs.length).toBeGreaterThanOrEqual(1);
      expect(logs[0].reason).toBe("Automated test suspension");
    });
  });

  describe("Audit Query Service", () => {
    it("supports querying audit logs by action and target with pagination", async () => {
      const results = await auditService.queryAuditLogs({
        action: AuditAction.WORKER_SUSPENDED,
        targetId: testWorkerId,
      });

      expect(results.items.length).toBeGreaterThanOrEqual(1);
      expect(results.total).toBeGreaterThanOrEqual(1);
      expect(results.items[0].targetId).toBe(testWorkerId);
    });
  });
});
