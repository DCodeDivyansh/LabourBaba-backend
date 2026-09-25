/**
 * tests/p5Issues6_10Comprehensive.test.ts
 *
 * Comprehensive Production-Grade Verification Suite for P5 Issues 6–10
 *
 * Issue 6: Consistent Resource Protection Across HTTP and Socket.IO (ABAC, Zero UUID Secrecy)
 * Issue 7: Real Private Object Storage, Contract MIME & Size Enforcement, Short-Lived Signed URLs
 * Issue 8: WorkerDevice as Sole Authoritative Push Identity Store (Zero Worker.device_token reads/writes)
 * Issue 9: Stable Device Identity Separate From Rotatable FCM Token (Concurrency Safe Upsert)
 * Issue 10: Single Consolidated Durable Notification Pipeline (Atomic Outbox, Zero Competing Pipelines)
 */

import request from "supertest";
import { Server as SocketIOServer } from "socket.io";
import { io as ClientSocket, Socket as ClientSocketType } from "socket.io-client";
import { app, httpServer } from "../src/server";
import prisma from "../src/config/prisma";
import { generateToken, hashPassword } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";
import { storageService } from "../src/providers/storage/storage.service";
import { storageConfig } from "../src/config/storageConfig";
import { workerDeviceService } from "../src/features/worker_device/worker_device.service";
import { outboxService } from "../src/services/outboxService";
import { outboxWorker } from "../src/workers/outboxWorker";
import { setMockFcmProvider } from "../src/shared/fcm";

describe("P5 Issues 6–10 Comprehensive Production Hardening Suite", () => {
  jest.setTimeout(45000);

  // Test Entities
  const CUSTOMER_A_ID = "66660000-0000-4000-a000-000000000001";
  const CUSTOMER_B_ID = "66660000-0000-4000-a000-000000000002";
  const WORKER_A_ID   = "66660000-0000-4000-b000-000000000001";
  const WORKER_B_ID   = "66660000-0000-4000-b000-000000000002";
  const WORKER_SUSPENDED_ID = "66660000-0000-4000-b000-000000000099";
  const ADMIN_ID      = "66660000-0000-4000-c000-000000000001";

  const JOB_A_ID      = "66660000-0000-4000-d000-000000000001";
  const REQ_A_ID      = "66660000-0000-4000-e000-000000000001";
  const BOOKING_A_ID  = "66660000-0000-4000-f000-000000000001";

  let customerAToken: string;
  let customerBToken: string;
  let workerAToken: string;
  let workerBToken: string;
  let workerSuspendedToken: string;
  let adminToken: string;

  let serverPort: number;
  let socketUrl: string;

  beforeAll(async () => {
    // 1. Ensure server is listening for Socket.IO tests
    if (!httpServer.listening) {
      await new Promise<void>((resolve) => {
        httpServer.listen(0, () => resolve());
      });
    }
    const address = httpServer.address() as any;
    serverPort = address.port;
    socketUrl = `http://localhost:${serverPort}`;

    // 2. Clean up previous test artifacts
    await prisma.notification_outbox.deleteMany({
      where: { aggregate_id: { in: [JOB_A_ID, REQ_A_ID, BOOKING_A_ID] } },
    }).catch(() => {});
    await prisma.worker_device.deleteMany({
      where: { worker_id: { in: [WORKER_A_ID, WORKER_B_ID, WORKER_SUSPENDED_ID] } },
    }).catch(() => {});
    await prisma.review.deleteMany({
      where: { booking_id: BOOKING_A_ID },
    }).catch(() => {});
    await prisma.message.deleteMany({
      where: { conversation: { booking_id: BOOKING_A_ID } },
    }).catch(() => {});
    await prisma.conversation.deleteMany({
      where: { booking_id: BOOKING_A_ID },
    }).catch(() => {});
    await prisma.payment.deleteMany({
      where: { booking_id: BOOKING_A_ID },
    }).catch(() => {});
    await prisma.booking.deleteMany({
      where: { id: BOOKING_A_ID },
    }).catch(() => {});
    await prisma.job_dispatch.deleteMany({
      where: { requirement_id: REQ_A_ID },
    }).catch(() => {});
    await prisma.dispatch_wave.deleteMany({
      where: { requirement_id: REQ_A_ID },
    }).catch(() => {});
    await prisma.job_requirement.deleteMany({
      where: { id: REQ_A_ID },
    }).catch(() => {});
    await prisma.job.deleteMany({
      where: { id: JOB_A_ID },
    }).catch(() => {});
    await prisma.worker_document.deleteMany({
      where: { worker_id: { in: [WORKER_A_ID, WORKER_B_ID] } },
    }).catch(() => {});
    await prisma.worker.deleteMany({
      where: { id: { in: [WORKER_A_ID, WORKER_B_ID, WORKER_SUSPENDED_ID] } },
    }).catch(() => {});
    await prisma.customer.deleteMany({
      where: { id: { in: [CUSTOMER_A_ID, CUSTOMER_B_ID] } },
    }).catch(() => {});

    // 3. Seed Skill Category
    let skillCat = await prisma.skill_category.findFirst({ where: { name: "P5TestCategory" } });
    if (!skillCat) {
      skillCat = await prisma.skill_category.create({
        data: { name: "P5TestCategory", is_active: true },
      });
    }

    const testPassword = await hashPassword("SecuredPassword123!");

    // 4. Seed Customers
    await prisma.customer.create({
      data: {
        id: CUSTOMER_A_ID,
        name: "Customer A P5",
        phone: "+919999000001",
        password: testPassword,
      },
    });
    await prisma.customer.create({
      data: {
        id: CUSTOMER_B_ID,
        name: "Customer B P5",
        phone: "+919999000002",
        password: testPassword,
      },
    });

    // 5. Seed Workers
    await prisma.worker.create({
      data: {
        id: WORKER_A_ID,
        name: "Worker A P5",
        phone: "+919999000011",
        password: testPassword,
        skill_type: "P5TestCategory",
        skill_category_id: skillCat.id,
        verification_status: "verified",
        is_online: true,
      },
    });
    await prisma.worker.create({
      data: {
        id: WORKER_B_ID,
        name: "Worker B P5",
        phone: "+919999000012",
        password: testPassword,
        skill_type: "P5TestCategory",
        skill_category_id: skillCat.id,
        verification_status: "verified",
        is_online: true,
      },
    });
    await prisma.worker.create({
      data: {
        id: WORKER_SUSPENDED_ID,
        name: "Worker Suspended P5",
        phone: "+919999000099",
        password: testPassword,
        skill_type: "P5TestCategory",
        skill_category_id: skillCat.id,
        verification_status: "suspended",
        is_online: false,
      },
    });

    // 6. Seed Job, Requirement, and Booking for Customer A + Worker A
    await prisma.job.create({
      data: {
        id: JOB_A_ID,
        customer_id: CUSTOMER_A_ID,
        location: "Mumbai",
        status: "BOOKED",
        latitude: 19.076,
        longitude: 72.8777,
      },
    });

    await prisma.job_requirement.create({
      data: {
        id: REQ_A_ID,
        job_id: JOB_A_ID,
        skill_id: skillCat.id,
        skill_type: "P5TestCategory",
        worker_count_needed: 1,
        worker_count_filled: 1,
        status: "FILLED",
        rate_per_day: 900,
      },
    });

    await prisma.booking.create({
      data: {
        id: BOOKING_A_ID,
        job_id: JOB_A_ID,
        requirement_id: REQ_A_ID,
        customer_id: CUSTOMER_A_ID,
        worker_id: WORKER_A_ID,
        status: "CONFIRMED",
      },
    });

    // Generate JWT tokens
    customerAToken = generateToken({ id: CUSTOMER_A_ID, role: UserRole.CUSTOMER, phone: "+919999000001" });
    customerBToken = generateToken({ id: CUSTOMER_B_ID, role: UserRole.CUSTOMER, phone: "+919999000002" });
    workerAToken   = generateToken({ id: WORKER_A_ID, role: UserRole.WORKER, phone: "+919999000011" });
    workerBToken   = generateToken({ id: WORKER_B_ID, role: UserRole.WORKER, phone: "+919999000012" });
    workerSuspendedToken = generateToken({ id: WORKER_SUSPENDED_ID, role: UserRole.WORKER, phone: "+919999000099" });
    adminToken     = generateToken({ id: ADMIN_ID, role: UserRole.ADMIN, phone: "+919999000000" });
  });

  afterAll(async () => {
    // Cleanup
    await prisma.notification_outbox.deleteMany({
      where: { aggregate_id: { in: [JOB_A_ID, REQ_A_ID, BOOKING_A_ID] } },
    }).catch(() => {});
    await prisma.worker_device.deleteMany({
      where: { worker_id: { in: [WORKER_A_ID, WORKER_B_ID, WORKER_SUSPENDED_ID] } },
    }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: BOOKING_A_ID } }).catch(() => {});
    await prisma.job_requirement.deleteMany({ where: { id: REQ_A_ID } }).catch(() => {});
    await prisma.job.deleteMany({ where: { id: JOB_A_ID } }).catch(() => {});
    await prisma.worker.deleteMany({ where: { id: { in: [WORKER_A_ID, WORKER_B_ID, WORKER_SUSPENDED_ID] } } }).catch(() => {});
    await prisma.customer.deleteMany({ where: { id: { in: [CUSTOMER_A_ID, CUSTOMER_B_ID] } } }).catch(() => {});
  });

  // ==========================================================================
  // Issue 6: Consistent Resource Protection Across HTTP and Socket.IO
  // ==========================================================================
  describe("Issue 6 — Consistent Resource Protection Across HTTP and Socket.IO", () => {
    it("Customer A CAN read own Job A via HTTP; Customer B CANNOT read Job A by UUID (404/403)", async () => {
      // Customer A (Owner) -> 200
      const resA = await request(app)
        .get(`/api/jobs/${JOB_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`);
      expect(resA.status).toBe(200);
      expect(resA.body.data.id).toBe(JOB_A_ID);

      // Customer B (Unrelated) -> 404 (RESOURCE_NOT_FOUND, zero disclosure)
      const resB = await request(app)
        .get(`/api/jobs/${JOB_A_ID}`)
        .set("Authorization", `Bearer ${customerBToken}`);
      expect([403, 404]).toContain(resB.status);
    });

    it("Unrelated Worker B CANNOT read Job A or Booking A solely by UUID", async () => {
      const resJob = await request(app)
        .get(`/api/jobs/${JOB_A_ID}`)
        .set("Authorization", `Bearer ${workerBToken}`);
      expect([403, 404]).toContain(resJob.status);

      const resBooking = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${workerBToken}`);
      expect([403, 404]).toContain(resBooking.status);
    });

    it("Customer A CAN access Booking A; Customer B CANNOT access Customer A's booking", async () => {
      const resA = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerAToken}`);
      expect(resA.status).toBe(200);

      const resB = await request(app)
        .get(`/api/bookings/${BOOKING_A_ID}`)
        .set("Authorization", `Bearer ${customerBToken}`);
      expect([403, 404]).toContain(resB.status);
    });

    it("Socket.IO Handshake rejects suspended worker identity", (done) => {
      const socket = ClientSocket(socketUrl, {
        auth: { token: workerSuspendedToken },
        transports: ["websocket"],
        reconnection: false,
      });

      socket.on("connect_error", (err) => {
        expect(err.message).toMatch(/Invalid authentication credentials|Authentication required/i);
        socket.disconnect();
        done();
      });

      socket.on("connect", () => {
        socket.disconnect();
        done(new Error("Suspended worker must not connect successfully"));
      });
    });

    it("Socket.IO: Authorized participant CAN join:job; Unrelated user is rejected", (done) => {
      const socketA = ClientSocket(socketUrl, {
        auth: { token: customerAToken },
        transports: ["websocket"],
        reconnection: false,
      });

      socketA.on("connect", () => {
        socketA.emit("join:job", { jobId: JOB_A_ID }, (res: any) => {
          expect(res.success).toBe(true);
          socketA.disconnect();

          // Now test Customer B (Unrelated)
          const socketB = ClientSocket(socketUrl, {
            auth: { token: customerBToken },
            transports: ["websocket"],
            reconnection: false,
          });

          socketB.on("connect", () => {
            socketB.emit("join:job", { jobId: JOB_A_ID }, (resB: any) => {
              expect(resB.success).toBe(false);
              expect(["FORBIDDEN", "RESOURCE_NOT_FOUND"]).toContain(resB.code);
              socketB.disconnect();
              done();
            });
          });
        });
      });
    });

    it("Socket.IO: Authorized participant CAN join:booking; Unrelated worker is rejected", (done) => {
      const socketWorkerA = ClientSocket(socketUrl, {
        auth: { token: workerAToken },
        transports: ["websocket"],
        reconnection: false,
      });

      socketWorkerA.on("connect", () => {
        socketWorkerA.emit("join:booking", { bookingId: BOOKING_A_ID }, (res: any) => {
          expect(res.success).toBe(true);
          socketWorkerA.disconnect();

          // Unrelated Worker B
          const socketWorkerB = ClientSocket(socketUrl, {
            auth: { token: workerBToken },
            transports: ["websocket"],
            reconnection: false,
          });

          socketWorkerB.on("connect", () => {
            socketWorkerB.emit("join:booking", { bookingId: BOOKING_A_ID }, (resB: any) => {
              expect(resB.success).toBe(false);
              expect(["FORBIDDEN", "RESOURCE_NOT_FOUND"]).toContain(resB.code);
              socketWorkerB.disconnect();
              done();
            });
          });
        });
      });
    });

    it("Malformed UUID follows disclosure policy and never leaks internal errors", async () => {
      const res = await request(app)
        .get("/api/jobs/invalid-not-a-uuid-1234")
        .set("Authorization", `Bearer ${customerAToken}`);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(JSON.stringify(res.body)).not.toContain("PrismaClientKnownRequestError");
    });
  });

  // ==========================================================================
  // Issue 7: Private Durable Object Storage, Contract MIME & Size Enforcement
  // ==========================================================================
  describe("Issue 7 — Replace Mock Storage With Real Private Object Storage", () => {
    let uploadUrl: string;
    let objectKey: string;

    it("Generates signed upload URL with explicit validated MIME type", async () => {
      const res = await request(app)
        .post("/api/workers/me/documents/upload-url")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({
          document_type: "AADHAAR",
          mime_type: "application/pdf",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.upload_url).toBeDefined();
      expect(res.body.data.object_key).toMatch(/^workers\/[0-9a-f-]+\/documents\/[0-9a-f-]+\.pdf$/i);
      expect(res.body.data.mime_type).toBe("application/pdf");

      uploadUrl = res.body.data.upload_url;
      objectKey = res.body.data.object_key;
    });

    it("Rejects request for unsupported MIME type (e.g. application/octet-stream or text/plain)", async () => {
      const res = await request(app)
        .post("/api/workers/me/documents/upload-url")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({
          document_type: "AADHAAR",
          mime_type: "application/x-msdownload",
        });

      expect([400, 422]).toContain(res.status);
    });

    it("Enforces MIME match: Uploading with wrong Content-Type is rejected (403/415)", async () => {
      const parsedUrl = new URL(uploadUrl);
      const pathname = parsedUrl.pathname;
      const search = parsedUrl.search;

      const res = await request(app)
        .put(`${pathname}${search}`)
        .set("Content-Type", "image/png") // Signed URL was created for application/pdf
        .send(Buffer.from("%PDF-1.5 test document content"));

      expect(res.status).toBe(403);
      expect(res.body.code).toBe("STORAGE_SIGNATURE_INVALID");
    });

    it("Enforces size limits: Empty buffer is rejected with 400", async () => {
      const parsedUrl = new URL(uploadUrl);
      const pathname = parsedUrl.pathname;
      const search = parsedUrl.search;

      const res = await request(app)
        .put(`${pathname}${search}`)
        .set("Content-Type", "application/pdf")
        .send(Buffer.from(""));

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("STORAGE_EMPTY_PAYLOAD");
    });

    it("Enforces size limits: Oversized file (> 5MB) is rejected with 413", async () => {
      // Request new upload URL for a fresh key
      const presign = await workerDeviceService && (await request(app)
        .post("/api/workers/me/documents/upload-url")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ document_type: "PAN", mime_type: "application/pdf" }));

      const targetUrl = new URL(presign.body.data.upload_url);
      const oversizedBuffer = Buffer.alloc(storageConfig.maxSizeBytes + 1024, "A");

      const res = await request(app)
        .put(`${targetUrl.pathname}${targetUrl.search}`)
        .set("Content-Type", "application/pdf")
        .send(oversizedBuffer);

      expect(res.status).toBe(413);
      expect(res.body.code).toBe("STORAGE_PAYLOAD_TOO_LARGE");
    });

    it("Persists valid object to backing storage and verifies physical existence", async () => {
      const parsedUrl = new URL(uploadUrl);
      const docContent = Buffer.from("%PDF-1.5 VERIFIED PRODUCTION STORAGE DOCUMENT");

      const uploadRes = await request(app)
        .put(`${parsedUrl.pathname}${parsedUrl.search}`)
        .set("Content-Type", "application/pdf")
        .send(docContent);

      expect(uploadRes.status).toBe(200);
      expect(uploadRes.body.success).toBe(true);

      // Verify physical persistence in storage backing store
      const exists = await storageService.objectExists(objectKey);
      expect(exists).toBe(true);

      const obj = await storageService.getObject(objectKey);
      expect(obj).not.toBeNull();
      expect(obj?.data.toString("utf8")).toBe(docContent.toString("utf8"));
    });

    it("Download authorization: Worker A can obtain signed download URL; Worker B cannot (IDOR)", async () => {
      // Create worker_document record pointing to objectKey
      const doc = await prisma.worker_document.create({
        data: {
          worker_id: WORKER_A_ID,
          document_type: "AADHAAR",
          file_url: objectKey,
          status: "VERIFIED",
        },
      });

      // Worker A -> 200
      const resA = await request(app)
        .get(`/api/workers/me/documents/${doc.id}/access`)
        .set("Authorization", `Bearer ${workerAToken}`);
      expect(resA.status).toBe(200);
      expect(resA.body.data.access_url).toContain("exp=");
      expect(resA.body.data.access_url).toContain("sig=");

      // Worker B -> 403 (IDOR blocked)
      const resB = await request(app)
        .get(`/api/workers/me/documents/${doc.id}/access`)
        .set("Authorization", `Bearer ${workerBToken}`);
      expect(resB.status).toBe(403);
    });
  });

  // ==========================================================================
  // Issue 8: WorkerDevice as Sole Authoritative Push Identity Store
  // ==========================================================================
  describe("Issue 8 — Make WorkerDevice the Sole Push-Identity Store", () => {
    it("Registration and update paths DO NOT modify Worker.device_token", async () => {
      const workerBefore = await prisma.worker.findUnique({
        where: { id: WORKER_A_ID },
        select: { device_token: true },
      });

      // Register device through API
      await request(app)
        .post("/api/workers/me/devices")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({
          device_id: "device-uuid-p5-001",
          device_token: "fcm_token_p5_aaa",
          platform: "android",
        })
        .expect(201);

      const workerAfter = await prisma.worker.findUnique({
        where: { id: WORKER_A_ID },
        select: { device_token: true },
      });

      // Worker.device_token must remain unaffected
      expect(workerAfter?.device_token).toBe(workerBefore?.device_token);

      // WorkerDevice must contain the active device
      const devices = await workerDeviceService.getActiveDevices(WORKER_A_ID);
      expect(devices.some((d) => d.device_id === "device-uuid-p5-001")).toBe(true);
    });

    it("Multiple devices can belong to a single worker independently", async () => {
      await request(app)
        .post("/api/workers/me/devices")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({
          device_id: "device-uuid-p5-002",
          device_token: "fcm_token_p5_bbb",
          platform: "ios",
        })
        .expect(201);

      const active = await workerDeviceService.getActiveDevices(WORKER_A_ID);
      const ids = active.map((d) => d.device_id);
      expect(ids).toContain("device-uuid-p5-001");
      expect(ids).toContain("device-uuid-p5-002");
    });

    it("Revoking one device leaves other active devices intact", async () => {
      await request(app)
        .delete("/api/workers/me/devices/device-uuid-p5-001")
        .set("Authorization", `Bearer ${workerAToken}`)
        .expect(200);

      const active = await workerDeviceService.getActiveDevices(WORKER_A_ID);
      const ids = active.map((d) => d.device_id);
      expect(ids).not.toContain("device-uuid-p5-001");
      expect(ids).toContain("device-uuid-p5-002");
    });
  });

  // ==========================================================================
  // Issue 9: Require Stable Device Identity Separate From FCM Token
  // ==========================================================================
  describe("Issue 9 — Require Stable Device Identity Separate From FCM Token", () => {
    it("Token rotation on same (worker_id, device_id) updates existing record without creating duplicate", async () => {
      const STABLE_DEVICE_ID = "stable-hardware-uuid-999";

      // 1. Initial registration with Token 1
      await request(app)
        .post("/api/workers/me/devices")
        .set("Authorization", `Bearer ${workerBToken}`)
        .send({
          device_id: STABLE_DEVICE_ID,
          device_token: "fcm_credential_v1",
          platform: "android",
        })
        .expect(201);

      const count1 = await prisma.worker_device.count({
        where: { worker_id: WORKER_B_ID, device_id: STABLE_DEVICE_ID },
      });
      expect(count1).toBe(1);

      // 2. FCM token rotation: same device_id, new fcm_token
      await request(app)
        .post("/api/workers/me/devices")
        .set("Authorization", `Bearer ${workerBToken}`)
        .send({
          device_id: STABLE_DEVICE_ID,
          device_token: "fcm_credential_v2_ROTATED",
          platform: "android",
        })
        .expect(201);

      const records = await prisma.worker_device.findMany({
        where: { worker_id: WORKER_B_ID, device_id: STABLE_DEVICE_ID },
      });

      expect(records.length).toBe(1);
      expect(records[0].fcm_token).toBe("fcm_credential_v2_ROTATED");
    });

    it("Legacy client fallback is deterministic and updates existing record on token rotation", async () => {
      // 1. Legacy client sends token without device_id
      await request(app)
        .post("/api/workers/me/devices")
        .set("Authorization", `Bearer ${workerBToken}`)
        .send({
          device_token: "legacy_fcm_token_initial",
          platform: "android",
        })
        .expect(201);

      const fallbackDeviceId = `legacy_${WORKER_B_ID}_default`;
      const row1 = await prisma.worker_device.findUnique({
        where: {
          worker_id_device_id: {
            worker_id: WORKER_B_ID,
            device_id: fallbackDeviceId,
          },
        },
      });
      expect(row1).not.toBeNull();
      expect(row1?.fcm_token).toBe("legacy_fcm_token_initial");

      // 2. Legacy client token rotates
      await request(app)
        .post("/api/workers/me/devices")
        .set("Authorization", `Bearer ${workerBToken}`)
        .send({
          device_token: "legacy_fcm_token_ROTATED",
          platform: "android",
        })
        .expect(201);

      const rowsAfter = await prisma.worker_device.findMany({
        where: {
          worker_id: WORKER_B_ID,
          device_id: fallbackDeviceId,
        },
      });
      expect(rowsAfter.length).toBe(1);
      expect(rowsAfter[0].fcm_token).toBe("legacy_fcm_token_ROTATED");
    });

    it("Concurrency stress: 20 simultaneous registrations on same (worker_id, device_id) yields exactly 1 record", async () => {
      const CONCURRENT_DEVICE_ID = "stress-test-device-uuid-concurrent";

      const requests = Array.from({ length: 20 }, (_, i) =>
        workerDeviceService.registerDevice(WORKER_A_ID, {
          device_id: CONCURRENT_DEVICE_ID,
          device_token: `token_stress_variant_${i}_${Date.now()}`,
          platform: "android",
        })
      );

      const results = await Promise.allSettled(requests);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled.length).toBe(20);

      const totalRows = await prisma.worker_device.findMany({
        where: {
          worker_id: WORKER_A_ID,
          device_id: CONCURRENT_DEVICE_ID,
        },
      });

      expect(totalRows.length).toBe(1);
    });
  });

  // ==========================================================================
  // Issue 10: Consolidate Notification Delivery Into One Durable Pipeline
  // ==========================================================================
  describe("Issue 10 — Consolidate Notification Delivery Into One Durable Pipeline", () => {
    it("Scenario A: Business transaction rollback leaves zero outbox records", async () => {
      const idempotencyKey = `p5:test:rollback:${Date.now()}`;

      try {
        await prisma.$transaction(async (tx) => {
          await outboxService.createOutboxEvent(tx, {
            eventType: "job_assigned",
            aggregateType: "job",
            aggregateId: JOB_A_ID,
            recipientType: "worker",
            recipientId: WORKER_A_ID,
            payload: { title: "Rollback Test" },
            idempotencyKey,
          });

          // Simulate business transaction failure
          throw new Error("Simulated business validation abort");
        });
      } catch (err: any) {
        expect(err.message).toBe("Simulated business validation abort");
      }

      const check = await prisma.notification_outbox.findUnique({
        where: { idempotency_key: idempotencyKey },
      });
      expect(check).toBeNull();
    });

    it("Scenario B: Business transaction commit creates exactly one durable outbox event", async () => {
      const idempotencyKey = `p5:test:commit:${Date.now()}`;

      const created = await prisma.$transaction(async (tx) => {
        return await outboxService.createOutboxEvent(tx, {
          eventType: "job_assigned",
          aggregateType: "job",
          aggregateId: JOB_A_ID,
          recipientType: "worker",
          recipientId: WORKER_A_ID,
          payload: { title: "Durable Notification Test" },
          idempotencyKey,
        });
      });

      expect(created).toBeDefined();

      const inDb = await prisma.notification_outbox.findUnique({
        where: { idempotency_key: idempotencyKey },
      });
      expect(inDb).not.toBeNull();
      expect(inDb?.status).toBe("PENDING");
      expect(inDb?.attempts).toBe(0);
    });

    it("Scenario C & E: Idempotency prevents duplicate outbox records and duplicate delivery chains", async () => {
      const idempotencyKey = `p5:test:idempotent:${Date.now()}`;

      // First insert
      const first = await prisma.$transaction(async (tx) => {
        return await outboxService.createOutboxEvent(tx, {
          eventType: "incoming_job",
          aggregateType: "requirement",
          aggregateId: REQ_A_ID,
          recipientType: "worker",
          recipientId: WORKER_A_ID,
          payload: { test: true },
          idempotencyKey,
        });
      });
      expect(first).toBeDefined();

      // Second attempt with exact same idempotencyKey
      const second = await prisma.$transaction(async (tx) => {
        return await outboxService.createOutboxEvent(tx, {
          eventType: "incoming_job",
          aggregateType: "requirement",
          aggregateId: REQ_A_ID,
          recipientType: "worker",
          recipientId: WORKER_A_ID,
          payload: { test: true },
          idempotencyKey,
        });
      });

      expect(second?.id).toBe(first?.id);

      const allMatching = await prisma.notification_outbox.findMany({
        where: { idempotency_key: idempotencyKey },
      });
      expect(allMatching.length).toBe(1);
    });

    it("Scenario F: Outbox worker processes batch and marks event SENT safely", async () => {
      setMockFcmProvider({
        sendToTokens: async () => [{ token: "mock-worker-token", success: true }],
      });

      const testKey = `p5:test:process:${Date.now()}`;
      const record = await prisma.$transaction(async (tx) => {
        return await outboxService.createOutboxEvent(tx, {
          eventType: "incoming_job",
          aggregateType: "requirement",
          aggregateId: REQ_A_ID,
          recipientType: "worker",
          recipientId: WORKER_A_ID,
          payload: { title: "Processed Outbox Notification" },
          idempotencyKey: testKey,
        });
      });

      expect(record).toBeDefined();

      // Process batch with outbox worker until our specific event is claimed and sent
      let check = await prisma.notification_outbox.findUnique({
        where: { id: record!.id },
      });
      for (let i = 0; i < 5 && check?.status === "PENDING"; i++) {
        await outboxWorker.processBatch(100);
        check = await prisma.notification_outbox.findUnique({
          where: { id: record!.id },
        });
      }

      expect(check?.status).toBe("SENT");
      expect(check?.processed_at).toBeDefined();
    });
  });
});
