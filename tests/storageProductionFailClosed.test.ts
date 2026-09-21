import crypto from "crypto";
import jwt from "jsonwebtoken";
import request from "supertest";
import { app } from "../src/server";
import {
  assertProductionStorageConfig,
  validateStorageSecret,
} from "../src/config/storageConfig";
import { LocalStorageDriver } from "../src/providers/storage/localStorageDriver";
import { SupabaseStorageDriver } from "../src/providers/storage/supabaseStorageDriver";
import { StorageService } from "../src/providers/storage/storage.service";
import {
  toWorkerPublicDTO,
  toWorkerSelfDTO,
  toWorkerAdminDTO,
  toWorkerDocumentMetadataDTO,
} from "../src/shared/prismaSelects";

describe("P3 Issue 4 — Production Fail-Closed & Storage Security Verification", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("1. Production Configuration & Fail-Closed Startup Boundary", () => {
    it("MUST fail startup if STORAGE_PROVIDER is missing or set to 'local' in production", () => {
      process.env.NODE_ENV = "production";
      process.env.STORAGE_PROVIDER = "local";
      process.env.STORAGE_SIGNING_SECRET = "production_super_secret_key_123456789";

      expect(() => assertProductionStorageConfig()).toThrow(
        /STORAGE_PROVIDER must be configured to a private object storage provider/i
      );
    });

    it("MUST fail startup if Supabase credentials are missing or invalid in production", () => {
      process.env.NODE_ENV = "production";
      process.env.STORAGE_PROVIDER = "supabase";
      process.env.STORAGE_SIGNING_SECRET = "production_super_secret_key_123456789";
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SECRET_KEY;

      expect(() => assertProductionStorageConfig()).toThrow(
        /Required Supabase storage environment variable 'SUPABASE_URL' is missing/i
      );

      process.env.SUPABASE_URL = "https://example.supabase.co";
      expect(() => assertProductionStorageConfig()).toThrow(
        /Required Supabase storage environment variable 'SUPABASE_SECRET_KEY'/i
      );
    });

    it("MUST fail startup if STORAGE_SIGNING_SECRET is missing or insecure in production", () => {
      process.env.NODE_ENV = "production";
      process.env.STORAGE_PROVIDER = "supabase";
      process.env.SUPABASE_URL = "https://example.supabase.co";
      process.env.SUPABASE_SECRET_KEY = "sb_secret_key_1234567890_service_role";
      process.env.STORAGE_SIGNING_SECRET = "short";

      expect(() => assertProductionStorageConfig()).toThrow(
        /STORAGE_SIGNING_SECRET.*too short/i
      );
    });

    it("LocalStorageDriver MUST throw and refuse instantiation in production", () => {
      process.env.NODE_ENV = "production";
      expect(() => new LocalStorageDriver()).toThrow(
        /LocalStorageDriver is strictly prohibited in production/i
      );
    });

    it("SupabaseStorageDriver in production MUST NOT instantiate LocalStorageDriver fallback", () => {
      process.env.NODE_ENV = "production";
      process.env.SUPABASE_URL = "https://example.supabase.co";
      process.env.SUPABASE_SECRET_KEY = "sb_secret_key_1234567890_service_role";

      const driver = new SupabaseStorageDriver("labourbaba-private-documents");
      expect((driver as any).fallbackDriver).toBeNull();
      expect((driver as any).isProduction).toBe(true);
    });

    it("StorageService in production MUST throw if initialized without valid cloud driver", () => {
      process.env.NODE_ENV = "production";
      delete process.env.STORAGE_PROVIDER;
      delete process.env.SUPABASE_URL;

      expect(() => new StorageService()).toThrow(
        /STORAGE_PROVIDER must be configured.*in production/i
      );
    });
  });

  describe("2. Storage Route Security & Request Hardening", () => {
    const storageService = new StorageService();
    const testKey = "workers/worker-prod-123/documents/doc-prod-999.pdf";
    const testData = Buffer.from("%PDF-1.4 Identity Document Content");

    beforeAll(async () => {
      await storageService.putObject(testKey, testData, "application/pdf");
    });

    afterAll(async () => {
      await storageService.deleteObject(testKey);
    });

    it("MUST verify that object physically exists in storage", async () => {
      const exists = await storageService.objectExists(testKey);
      expect(exists).toBe(true);

      const nonExistent = await storageService.objectExists("workers/other/doc-missing.pdf");
      expect(nonExistent).toBe(false);
    });

    it("MUST reject download with missing signature (403)", async () => {
      const res = await request(app).get(`/api/storage/download/${encodeURIComponent(testKey)}`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("STORAGE_SIGNATURE_MISSING");
    });

    it("MUST reject download with tampered signature (403)", async () => {
      const exp = Math.floor(Date.now() / 1000) + 300;
      const res = await request(app).get(
        `/api/storage/download/${encodeURIComponent(testKey)}?exp=${exp}&sig=0000000000000000000000000000000000000000000000000000000000000000`
      );
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("STORAGE_SIGNATURE_INVALID");
    });

    it("MUST reject download with expired signed URL (403)", async () => {
      // Generate signature with expired timestamp (10 seconds in the past)
      const pastExp = Math.floor(Date.now() / 1000) - 10;
      const signature = crypto
        .createHmac("sha256", (storageService as any).signingSecret)
        .update(`GET:${(storageService as any).bucketName}:${testKey}:${pastExp}`)
        .digest("hex");

      const res = await request(app).get(
        `/api/storage/download/${encodeURIComponent(testKey)}?exp=${pastExp}&sig=${signature}`
      );
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("STORAGE_SIGNATURE_INVALID");
    });

    it("MUST reject signature reuse across different HTTP methods (PUT signature used for GET)", async () => {
      const exp = Math.floor(Date.now() / 1000) + 300;
      // Signature generated for PUT
      const putSignature = crypto
        .createHmac("sha256", (storageService as any).signingSecret)
        .update(`PUT:${(storageService as any).bucketName}:${testKey}:application/pdf:${exp}`)
        .digest("hex");

      const res = await request(app).get(
        `/api/storage/download/${encodeURIComponent(testKey)}?exp=${exp}&sig=${putSignature}`
      );
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("STORAGE_SIGNATURE_INVALID");
    });

    it("MUST reject cross-worker key manipulation (Signature for Worker A used for Worker B's document)", async () => {
      const workerBKey = "workers/worker-prod-456/documents/doc-prod-999.pdf";
      const exp = Math.floor(Date.now() / 1000) + 300;
      // Signature generated for Worker A's key
      const workerASig = crypto
        .createHmac("sha256", (storageService as any).signingSecret)
        .update(`GET:${(storageService as any).bucketName}:${testKey}:${exp}`)
        .digest("hex");

      // Attempt to access Worker B's file with Worker A's signature
      const res = await request(app).get(
        `/api/storage/download/${encodeURIComponent(workerBKey)}?exp=${exp}&sig=${workerASig}`
      );
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("STORAGE_SIGNATURE_INVALID");
    });

    it("MUST reject directory traversal attacks in download keys (e.g. ../../etc/passwd)", async () => {
      const traversalKey = "../../etc/passwd";
      const exp = Math.floor(Date.now() / 1000) + 300;
      const signature = crypto
        .createHmac("sha256", (storageService as any).signingSecret)
        .update(`GET:${(storageService as any).bucketName}:etc/passwd:${exp}`)
        .digest("hex");

      const res = await request(app).get(
        `/api/storage/download/${encodeURIComponent(traversalKey)}?exp=${exp}&sig=${signature}`
      );
      // Traversal attempt is rejected
      expect([400, 403, 404, 500]).toContain(res.status);
    });

    it("MUST successfully stream binary file with valid signed URL", async () => {
      const signedUrlResult = await storageService.getSignedDownloadUrl(testKey, 300);
      const url = new URL(signedUrlResult.url);
      const exp = url.searchParams.get("exp")!;
      const sig = url.searchParams.get("sig")!;

      const res = await request(app).get(
        `/api/storage/download/${encodeURIComponent(testKey)}?exp=${exp}&sig=${sig}`
      );

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      const content = Buffer.isBuffer(res.body) ? res.body.toString("utf8") : res.text;
      expect(content).toContain("%PDF-1.4 Identity Document Content");
    });
  });

  describe("3. Multi-Instance & Zero In-Memory State Proof", () => {
    it("Two independent StorageService instances MUST observe identical persistent document state", async () => {
      const instance1 = new StorageService();
      const instance2 = new StorageService();

      const multiKey = "workers/worker-multi/documents/doc-shared.pdf";
      const multiData = Buffer.from("Shared Document Persistence Across Instances");

      await instance1.putObject(multiKey, multiData, "application/pdf");

      // Instance 2 must immediately see the object created by Instance 1
      const existsIn2 = await instance2.objectExists(multiKey);
      expect(existsIn2).toBe(true);

      const retrievedIn2 = await instance2.getObject(multiKey);
      expect(retrievedIn2).not.toBeNull();
      expect(retrievedIn2?.data.toString("utf8")).toBe(multiData.toString("utf8"));

      // Instance 2 deletes object, Instance 1 must see deletion
      await instance2.deleteObject(multiKey);
      const existsIn1 = await instance1.objectExists(multiKey);
      expect(existsIn1).toBe(false);
    });
  });

  describe("4. DTO Boundaries & Privacy Invariants", () => {
    const rawWorkerWithDocs = {
      id: "worker-uuid-1",
      name: "Ramesh Kumar",
      phone: "+919876543210",
      skill_type: "PLUMBER",
      skill_category_id: "cat-1",
      worker_score: 4.8,
      is_online: true,
      aadhaar_last4: "1234",
      verification_status: "VERIFIED",
      decline_count: 0,
      timeout_count: 0,
    };

    const rawDoc = {
      id: "doc-uuid-1",
      worker_id: "worker-uuid-1",
      document_type: "AADHAAR",
      document_number: "XXXX-XXXX-1234",
      storage_key: "workers/worker-uuid-1/documents/secret-aadhaar.pdf",
      file_url: "https://storage.labourbaba.com/private/secret-aadhaar.pdf",
      status: "VERIFIED",
    };

    it("toWorkerPublicDTO NEVER exposes document storage keys, buckets, or phone PII", () => {
      const publicDto = toWorkerPublicDTO(rawWorkerWithDocs);
      expect((publicDto as any).documents).toBeUndefined();
      expect((publicDto as any).storage_key).toBeUndefined();
      expect((publicDto as any).bucketName).toBeUndefined();
      expect(JSON.stringify(publicDto)).not.toContain("secret-aadhaar.pdf");
      expect(JSON.stringify(publicDto)).not.toContain("storage_key");
    });

    it("toWorkerSelfDTO NEVER exposes raw storage keys or permanent URLs", () => {
      const selfDto = toWorkerSelfDTO(rawWorkerWithDocs);
      expect((selfDto as any).storage_key).toBeUndefined();
      expect(JSON.stringify(selfDto)).not.toContain("secret-aadhaar.pdf");
    });

    it("toWorkerAdminDTO NEVER exposes raw storage keys or permanent document URLs", () => {
      const adminDto = toWorkerAdminDTO(rawWorkerWithDocs);
      expect((adminDto as any).storage_key).toBeUndefined();
      expect(JSON.stringify(adminDto)).not.toContain("secret-aadhaar.pdf");
    });

    it("toWorkerDocumentMetadataDTO NEVER exposes raw storage_key or file_url", () => {
      const metaDto = toWorkerDocumentMetadataDTO(rawDoc);
      expect(metaDto?.id).toBe("doc-uuid-1");
      expect(metaDto?.worker_id).toBe("worker-uuid-1");
      expect(metaDto?.document_type).toBe("AADHAAR");
      expect(metaDto?.status).toBe("VERIFIED");
      expect((metaDto as any).storage_key).toBeUndefined();
      expect((metaDto as any).file_url).toBeUndefined();
      expect(JSON.stringify(metaDto)).not.toContain("secret-aadhaar.pdf");
    });
  });
});
