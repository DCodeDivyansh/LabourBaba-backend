import request from "supertest";
import { app } from "../src/server";
import { generateToken } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";
import prisma from "../src/config/prisma";
import { storageService } from "../src/providers/storage/storage.service";
import {
  toWorkerPublicDTO,
  toWorkerSelfDTO,
  toWorkerAdminDTO,
} from "../src/shared/prismaSelects";

// Mock BullMQ queues
jest.mock("../src/config/bullmq", () => ({
  dispatchQueue: { add: jest.fn().mockResolvedValue({}) },
  timeoutQueue: { add: jest.fn().mockResolvedValue({}) },
  connection: {},
}));

jest.mock("../src/features/dispatch/simpleDispatch", () => ({
  dispatchJobSimple: jest.fn().mockResolvedValue({}),
}));

// Mock Prisma
jest.mock("../src/config/prisma", () => ({
  __esModule: true,
  default: {
    worker: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    customer: {
      findUnique: jest.fn(),
    },
    worker_document: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn((cb) => cb(prisma)),
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

// Test UUIDs
const WORKER_A_ID = "11111111-1111-4111-a111-111111111111";
const WORKER_B_ID = "22222222-2222-4222-a222-222222222222";
const CUSTOMER_ID = "33333333-3333-4333-a333-333333333333";
const ADMIN_ID    = "99999999-9999-4999-a999-999999999999";

const DOC_A_ID    = "aaaa1111-1111-4111-a111-111111111111";
const DOC_B_ID    = "bbbb2222-2222-4222-a222-222222222222";

const workerAToken = generateToken({ id: WORKER_A_ID, role: UserRole.WORKER, phone: "+919876543210" });
const workerBToken = generateToken({ id: WORKER_B_ID, role: UserRole.WORKER, phone: "+919876543211" });
const customerToken = generateToken({ id: CUSTOMER_ID, role: UserRole.CUSTOMER, phone: "+919876543212" });
const adminToken   = generateToken({ id: ADMIN_ID, role: UserRole.ADMIN, phone: "+919876543213" });

describe("Issue #8 — Harden Worker-Document Access", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("1. Authentication & Token Integrity", () => {
    it("Anonymous request to GET /api/workers/me/documents is rejected (401)", async () => {
      const res = await request(app).get("/api/workers/me/documents");
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("Anonymous request to POST /api/workers/me/documents/upload-url is rejected (401)", async () => {
      const res = await request(app)
        .post("/api/workers/me/documents/upload-url")
        .send({ document_type: "AADHAAR" });
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("Anonymous request to GET /api/workers/me/documents/:documentId/access is rejected (401)", async () => {
      const res = await request(app).get(`/api/workers/me/documents/${DOC_A_ID}/access`);
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("Request with invalid or expired token is rejected (401)", async () => {
      const res = await request(app)
        .get(`/api/workers/me/documents/${DOC_A_ID}/access`)
        .set("Authorization", "Bearer invalid-expired-token");
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  describe("2. Worker Document Authorization & IDOR Protection", () => {
    it("Worker A CAN access their own document signed URL (200, short-lived signed URL)", async () => {
      (prisma.worker_document.findUnique as jest.Mock).mockResolvedValue({
        id: DOC_A_ID,
        worker_id: WORKER_A_ID,
        document_type: "AADHAAR",
        file_url: `workers/${WORKER_A_ID}/documents/doc-uuid-123.pdf`,
        status: "VERIFIED",
      });

      const res = await request(app)
        .get(`/api/workers/me/documents/${DOC_A_ID}/access`)
        .set("Authorization", `Bearer ${workerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.document_id).toBe(DOC_A_ID);
      expect(res.body.data.worker_id).toBe(WORKER_A_ID);
      expect(res.body.data.document_type).toBe("AADHAAR");
      expect(res.body.data.access_url).toContain("https://storage.labourbaba.com/download/");
      expect(res.body.data.access_url).toContain("exp=");
      expect(res.body.data.access_url).toContain("sig=");
      expect(res.body.data.expires_in).toBe(900);
    });

    it("Worker B CANNOT access Worker A's document (IDOR attempt -> 403)", async () => {
      (prisma.worker_document.findUnique as jest.Mock).mockResolvedValue({
        id: DOC_A_ID,
        worker_id: WORKER_A_ID, // Owned by Worker A
        document_type: "AADHAAR",
        file_url: `workers/${WORKER_A_ID}/documents/doc-uuid-123.pdf`,
        status: "VERIFIED",
      });

      const res = await request(app)
        .get(`/api/workers/me/documents/${DOC_A_ID}/access`)
        .set("Authorization", `Bearer ${workerBToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Forbidden");
    });

    it("Signed URL expiry CANNOT be manipulated by the client via query parameters", async () => {
      (prisma.worker_document.findUnique as jest.Mock).mockResolvedValue({
        id: DOC_A_ID,
        worker_id: WORKER_A_ID,
        document_type: "AADHAAR",
        file_url: `workers/${WORKER_A_ID}/documents/doc-uuid-123.pdf`,
        status: "VERIFIED",
      });

      // Attacker attempts to request a 24-hour expiry (86400s)
      const res = await request(app)
        .get(`/api/workers/me/documents/${DOC_A_ID}/access?expiresIn=86400&ttl=86400`)
        .set("Authorization", `Bearer ${workerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.expires_in).toBe(900); // Strictly enforced server-side
    });

    it("Non-existent document returns 404", async () => {
      (prisma.worker_document.findUnique as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/workers/me/documents/00000000-0000-4000-a000-000000000000/access`)
        .set("Authorization", `Bearer ${workerAToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it("Invalid documentId format is rejected immediately by validation (400)", async () => {
      const res = await request(app)
        .get("/api/workers/me/documents/invalid-non-uuid/access")
        .set("Authorization", `Bearer ${workerAToken}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe("3. Presigned Upload URL & Key Derivation Security", () => {
    it("Worker A can request pre-signed upload URL scoped to their worker identity", async () => {
      const res = await request(app)
        .post("/api/workers/me/documents/upload-url")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ document_type: "AADHAAR", file_extension: "pdf" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.upload_url).toContain("https://storage.labourbaba.com/upload/");
      expect(res.body.data.object_key).toMatch(new RegExp(`^workers/${WORKER_A_ID}/documents/[a-f0-9-]+\\.pdf$`));
      expect(res.body.data.expires_in).toBe(900);
    });

    it("Document object key never exposes Aadhaar numbers or PII", () => {
      const key = storageService.generateDocumentKey(WORKER_A_ID, "pdf");
      expect(key).not.toContain("123456789012"); // No Aadhaar
      expect(key).not.toContain("+91"); // No phone
      expect(key).toMatch(new RegExp(`^workers/${WORKER_A_ID}/documents/[a-f0-9-]+\\.pdf$`));
    });

    it("Worker A CANNOT upload document with mismatched client-controlled worker_id (400)", async () => {
      const res = await request(app)
        .post("/api/workers/me/documents")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({
          worker_id: WORKER_B_ID, // Attempting to spoof worker B
          document_type: "AADHAAR",
          file_url: `workers/${WORKER_A_ID}/documents/doc.pdf`,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Client-controlled worker identity is not permitted");
    });

    it("Worker A CANNOT attach a private storage key belonging to Worker B (403)", async () => {
      const res = await request(app)
        .post("/api/workers/me/documents")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({
          document_type: "AADHAAR",
          file_url: `workers/${WORKER_B_ID}/documents/secret-doc.pdf`, // Worker B's file!
        });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Cannot attach document key belonging to another worker");
    });
  });

  describe("4. Customer Isolation & Zero Document Access", () => {
    it("Customer CANNOT list worker documents via /api/workers/me/documents (403)", async () => {
      const res = await request(app)
        .get("/api/workers/me/documents")
        .set("Authorization", `Bearer ${customerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("Customer CANNOT request upload URL via /api/workers/me/documents/upload-url (403)", async () => {
      const res = await request(app)
        .post("/api/workers/me/documents/upload-url")
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ document_type: "AADHAAR" });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("Customer CANNOT access worker document signed URL via /api/workers/me/documents/:docId/access (403)", async () => {
      const res = await request(app)
        .get(`/api/workers/me/documents/${DOC_A_ID}/access`)
        .set("Authorization", `Bearer ${customerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("Customer CANNOT access admin worker documents endpoint (403)", async () => {
      const res = await request(app)
        .get(`/api/admin/workers/${WORKER_A_ID}/documents`)
        .set("Authorization", `Bearer ${customerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("Customer CANNOT access admin worker document access endpoint (403)", async () => {
      const res = await request(app)
        .get(`/api/admin/workers/${WORKER_A_ID}/documents/${DOC_A_ID}/access`)
        .set("Authorization", `Bearer ${customerToken}`);

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });
  });

  describe("5. Admin Access & Durable Audit Logging", () => {
    it("Admin CAN list document metadata for a worker (200)", async () => {
      (prisma.worker_document.findMany as jest.Mock).mockResolvedValue([
        {
          id: DOC_A_ID,
          worker_id: WORKER_A_ID,
          document_type: "AADHAAR",
          file_url: `workers/${WORKER_A_ID}/documents/aadhaar.pdf`,
          status: "PENDING",
        },
      ]);

      const res = await request(app)
        .get(`/api/admin/workers/${WORKER_A_ID}/documents`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe(DOC_A_ID);
    });

    it("Admin CAN access worker document signed URL and it generates an audit log entry", async () => {
      const consoleSpy = jest.spyOn(console, "log").mockImplementation(() => {});

      (prisma.worker_document.findFirst as jest.Mock).mockResolvedValue({
        id: DOC_A_ID,
        worker_id: WORKER_A_ID,
        document_type: "AADHAAR",
        file_url: `workers/${WORKER_A_ID}/documents/aadhaar.pdf`,
        status: "PENDING",
      });

      const res = await request(app)
        .get(`/api/admin/workers/${WORKER_A_ID}/documents/${DOC_A_ID}/access`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.access_url).toContain("https://storage.labourbaba.com/download/");

      // Verify audit log call occurred
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(`[AUDIT] Admin ${ADMIN_ID} viewed document ${DOC_A_ID} of worker ${WORKER_A_ID}`)
      );

      // Verify the signed URL itself is NEVER logged
      const loggedMessages = consoleSpy.mock.calls.map(call => call.join(" ")).join("\n");
      expect(loggedMessages).not.toContain(res.body.data.access_url);
      expect(loggedMessages).not.toContain("sig=");

      consoleSpy.mockRestore();
    });

    it("Admin access to mismatched worker and document returns 404", async () => {
      (prisma.worker_document.findFirst as jest.Mock).mockResolvedValue(null);

      const res = await request(app)
        .get(`/api/admin/workers/${WORKER_B_ID}/documents/${DOC_A_ID}/access`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  describe("6. DTO Boundaries & Privacy Invariants", () => {
    it("toWorkerPublicDTO NEVER exposes document URLs, storage keys, or signed URLs", () => {
      const poisonWorker = {
        id: WORKER_A_ID,
        name: "Test Worker",
        phone: "+919876543210",
        skill_type: "Plumber",
        skill_category_id: "c1111111-1111-4111-a111-111111111111",
        file_url: "https://storage.labourbaba.com/secret.pdf",
        storage_key: "workers/secret/aadhaar.pdf",
        document_url: "https://storage.labourbaba.com/download/doc",
        documents: [{ file_url: "leak" }],
      };

      const dto = toWorkerPublicDTO(poisonWorker);
      expect(dto).not.toHaveProperty("file_url");
      expect(dto).not.toHaveProperty("storage_key");
      expect(dto).not.toHaveProperty("document_url");
      expect(dto).not.toHaveProperty("documents");
    });

    it("toWorkerSelfDTO NEVER exposes document URLs or storage keys", () => {
      const poisonWorker = {
        id: WORKER_A_ID,
        name: "Test Worker",
        phone: "+919876543210",
        skill_type: "Plumber",
        skill_category_id: "c1111111-1111-4111-a111-111111111111",
        file_url: "https://storage.labourbaba.com/secret.pdf",
        storage_key: "workers/secret/aadhaar.pdf",
        document_url: "https://storage.labourbaba.com/download/doc",
      };

      const dto = toWorkerSelfDTO(poisonWorker);
      expect(dto).not.toHaveProperty("file_url");
      expect(dto).not.toHaveProperty("storage_key");
      expect(dto).not.toHaveProperty("document_url");
    });

    it("toWorkerAdminDTO NEVER exposes document storage keys or signed URLs", () => {
      const poisonWorker = {
        id: WORKER_A_ID,
        name: "Test Worker",
        phone: "+919876543210",
        skill_type: "Plumber",
        skill_category_id: "c1111111-1111-4111-a111-111111111111",
        file_url: "https://storage.labourbaba.com/secret.pdf",
        storage_key: "workers/secret/aadhaar.pdf",
        document_url: "https://storage.labourbaba.com/download/doc",
      };

      const dto = toWorkerAdminDTO(poisonWorker);
      expect(dto).not.toHaveProperty("file_url");
      expect(dto).not.toHaveProperty("storage_key");
      expect(dto).not.toHaveProperty("document_url");
    });
  });
});
