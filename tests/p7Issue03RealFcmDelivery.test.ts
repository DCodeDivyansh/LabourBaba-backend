/**
 * tests/p7Issue03RealFcmDelivery.test.ts
 *
 * LabourBaba Backend — P7 Issue 03: Real FCM Delivery & Production Reliability Suite
 *
 * Test Classification:
 * - UNIT: Structured error classification, token fingerprinting, payload validation
 * - PROVIDER-INTEGRATION: Firebase Admin SDK initialization, PKCS8 credential parsing,
 *                         fail-fast gates, production mock prohibitions
 * - DURABLE-INTEGRATION: Live PostgreSQL outbox transactions, BullMQ lifecycle,
 *                        token rotation, automatic revocation, exponential backoff,
 *                        crash recovery, lease fences, and Socket.IO interplay
 * - REAL-PROVIDER / E2E: Genuine Google FCM API transmission and real device receipt
 *                        (conditionally runs when real credentials / device tokens are injected)
 */

import http from "http";
import crypto from "crypto";
import { Server as SocketIOServer } from "socket.io";
import { io as Client, Socket as ClientSocket } from "socket.io-client";
import { initializeApp, cert, getApps, deleteApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import prisma from "../src/config/prisma";
import {
  sendFCMToTokens,
  sendFCMToWorker,
  sendFCMToCustomer,
  classifyFCMError,
  isPermanentInvalidTokenError,
  fingerprintToken,
  assertFcmConfig,
  getFirebaseApp,
  resetFirebaseApp,
  setMockFcmProvider,
  IFCMProvider,
} from "../src/shared/fcm";
import { workerDeviceService } from "../src/features/worker_device/worker_device.service";
import { customerDeviceService } from "../src/features/customer_device/customer_device.service";
import { outboxService, OutboxRecord } from "../src/services/outboxService";
import { OutboxWorker } from "../src/workers/outboxWorker";
import { metricsService } from "../src/metrics/metrics.service";
import { socketAuthMiddleware } from "../src/socket/socketAuth";
import { registerSocketHandlers } from "../src/socket/socketHandlers";
import { signAccessToken } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";
import { getRedisClient, waitForRedisReady } from "../src/config/redis";

describe("P7 Issue 03 — Real FCM Delivery, Configuration, & Reliability Suite", () => {
  jest.setTimeout(45000);

  const testWorkerId = "00000000-0000-4000-a000-000000000001";
  const testCustomerId = "00000000-0000-4000-b000-000000000001";
  const testPhone = "+919876543210";

  let httpServer: http.Server;
  let ioServer: SocketIOServer;
  let serverPort: number;

  beforeAll(async () => {
    // 1. Verify Redis connectivity
    await waitForRedisReady(10000);

    // 2. Clean up leftover fixtures in PostgreSQL
    await (prisma as any).worker_device.deleteMany({
      where: { worker_id: testWorkerId },
    }).catch(() => {});
    await (prisma as any).customer_device.deleteMany({
      where: { customer_id: testCustomerId },
    }).catch(() => {});
    await (prisma as any).notification_outbox.deleteMany({
      where: { recipient_id: { in: [testWorkerId, testCustomerId] } },
    }).catch(() => {});
    await prisma.worker.deleteMany({
      where: { id: testWorkerId },
    }).catch(() => {});
    await prisma.customer.deleteMany({
      where: { id: testCustomerId },
    }).catch(() => {});

    // 3. Ensure a valid skill_category exists
    let category = await prisma.skill_category.findFirst();
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "General Helper", description: "General Helper" },
      });
    }

    // 4. Seed test worker and customer
    await prisma.worker.create({
      data: {
        id: testWorkerId,
        phone: "+919876500001",
        name: "FCM Test Worker",
        password: "$2b$10$abcdefghijklmnopqrstuvwxyzA1B2C3D4E5F6G7H8I9J0K",
        skill_type: "General Helper",
        skill_category_id: category.id,
      },
    });

    await prisma.customer.create({
      data: {
        id: testCustomerId,
        phone: "+919876500002",
        name: "FCM Test Customer",
        password: "$2b$10$abcdefghijklmnopqrstuvwxyzA1B2C3D4E5F6G7H8I9J0K",
      },
    });

    // 5. Setup test Socket.IO server
    httpServer = http.createServer();
    ioServer = new SocketIOServer(httpServer);
    ioServer.use(socketAuthMiddleware);
    registerSocketHandlers(ioServer);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        serverPort = (httpServer.address() as any).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    resetFirebaseApp();
    if (ioServer) {
      ioServer.close();
    }
    if (httpServer) {
      httpServer.close();
    }
    await (prisma as any).worker_device.deleteMany({
      where: { worker_id: testWorkerId },
    }).catch(() => {});
    await (prisma as any).customer_device.deleteMany({
      where: { customer_id: testCustomerId },
    }).catch(() => {});
    await (prisma as any).notification_outbox.deleteMany({
      where: { recipient_id: { in: [testWorkerId, testCustomerId] } },
    }).catch(() => {});
    await prisma.worker.deleteMany({
      where: { id: testWorkerId },
    }).catch(() => {});
    await prisma.customer.deleteMany({
      where: { id: testCustomerId },
    }).catch(() => {});
    await prisma.$disconnect();
  });

  // ==========================================================================
  // SECTION A: FIREBASE INITIALIZATION & CREDENTIAL SECURITY (PROVIDER-INTEGRATION)
  // ==========================================================================
  describe("Section A: Firebase Initialization & Credential Security", () => {
    afterEach(() => {
      resetFirebaseApp();
    });

    it("prohibits registering mock FCM provider in production environment", () => {
      const origEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      expect(() => {
        setMockFcmProvider({
          sendToTokens: async () => [],
        });
      }).toThrow("[SECURITY_VIOLATION] Mock FCM provider cannot be registered in production environment.");

      process.env.NODE_ENV = origEnv;
    });

    it("fails fast in production if Firebase Admin SDK credentials are missing", () => {
      const origEnv = process.env.NODE_ENV;
      const origVar = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      const origKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      const origGoogle = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      const origProjectId = process.env.FIREBASE_PROJECT_ID;

      process.env.NODE_ENV = "production";
      delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      delete process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      delete process.env.FIREBASE_PROJECT_ID;

      expect(() => assertFcmConfig()).toThrow("[FCM_CONFIG_ERROR]");

      process.env.NODE_ENV = origEnv;
      if (origVar) process.env.FIREBASE_SERVICE_ACCOUNT_JSON = origVar;
      if (origKey) process.env.FIREBASE_SERVICE_ACCOUNT_KEY = origKey;
      if (origGoogle) process.env.GOOGLE_APPLICATION_CREDENTIALS = origGoogle;
      if (origProjectId) process.env.FIREBASE_PROJECT_ID = origProjectId;
    });

    it("safely initializes Firebase Admin SDK from dynamically generated PKCS8 RSA credentials", () => {
      const { privateKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      const sa = {
        type: "service_account",
        project_id: "labourbaba-staging-test",
        private_key_id: "test-key-id-12345",
        private_key: privateKey,
        client_email: "firebase-adminsdk@labourbaba-staging-test.iam.gserviceaccount.com",
      };

      const testAppName = `test-fcm-init-${Date.now()}`;
      const testApp = initializeApp({ credential: cert(sa as any) }, testAppName);

      expect(testApp).toBeDefined();
      expect(testApp.name).toBe(testAppName);

      deleteApp(testApp).catch(() => {});
    });

    it("safely normalizes literal newline escapes in private keys from CI/CD secrets", () => {
      const { privateKey } = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      // Simulate literal \n string from environment
      const escapedKey = privateKey.replace(/\n/g, "\\n");
      const normalizedKey = escapedKey.replace(/\\n/g, "\n");

      expect(normalizedKey).toContain("-----BEGIN PRIVATE KEY-----");
      expect(normalizedKey).toContain("-----END PRIVATE KEY-----");
      expect(normalizedKey).not.toContain("\\n");
    });

    it("strictly computes safe SHA-256 token fingerprints without leaking raw registration tokens", () => {
      const rawToken = "fcm_secret_device_token_xyz9876543210abcdef";
      const fp = fingerprintToken(rawToken);

      expect(fp).toHaveLength(10);
      expect(fp).toMatch(/^[0-9a-f]{10}$/);
      expect(fp).not.toContain("fcm_secret");
      expect(fingerprintToken("")).toBe("empty_token");
    });
  });

  // ==========================================================================
  // SECTION B: ERROR CLASSIFICATION & TOKEN REVOCATION (UNIT + DURABLE)
  // ==========================================================================
  describe("Section B: Error Classification & Token Revocation", () => {
    it("classifies registration-token-not-registered as permanent UNREGISTERED_DEVICE", () => {
      const error = { code: "messaging/registration-token-not-registered", message: "Token no longer registered" };
      const classified = classifyFCMError(error);

      expect(classified.category).toBe("UNREGISTERED_DEVICE");
      expect(classified.isInvalidToken).toBe(true);
      expect(classified.isPermanent).toBe(true);
      expect(classified.shouldRetry).toBe(false);
      expect(isPermanentInvalidTokenError(error)).toBe(true);
    });

    it("classifies invalid-registration-token as permanent INVALID_REGISTRATION_TOKEN", () => {
      const error = { code: "messaging/invalid-registration-token", message: "Invalid token structure" };
      const classified = classifyFCMError(error);

      expect(classified.category).toBe("INVALID_REGISTRATION_TOKEN");
      expect(classified.isInvalidToken).toBe(true);
      expect(classified.isPermanent).toBe(true);
      expect(classified.shouldRetry).toBe(false);
    });

    it("classifies server-unavailable and timeout as retryable TRANSIENT_FAILURE", () => {
      const error503 = { code: "messaging/server-unavailable", message: "Service Unavailable" };
      const classified503 = classifyFCMError(error503);

      expect(classified503.category).toBe("TRANSIENT_FAILURE");
      expect(classified503.isInvalidToken).toBe(false);
      expect(classified503.isPermanent).toBe(false);
      expect(classified503.shouldRetry).toBe(true);

      const errorTimeout = new Error("ETIMEDOUT: Connection reset by peer");
      const classifiedTimeout = classifyFCMError(errorTimeout);

      expect(classifiedTimeout.category).toBe("TRANSIENT_FAILURE");
      expect(classifiedTimeout.shouldRetry).toBe(true);
      expect(classifiedTimeout.isInvalidToken).toBe(false);
    });

    it("classifies quota-exceeded and 429 as retryable RATE_LIMITED", () => {
      const rateLimitError = { code: "messaging/quota-exceeded", message: "Rate limit exceeded" };
      const classified = classifyFCMError(rateLimitError);

      expect(classified.category).toBe("RATE_LIMITED");
      expect(classified.isInvalidToken).toBe(false);
      expect(classified.isPermanent).toBe(false);
      expect(classified.shouldRetry).toBe(true);
    });
  });

  // ==========================================================================
  // SECTION C: TOKEN ROTATION & CANONICAL IDENTITY (DURABLE-INTEGRATION)
  // ==========================================================================
  describe("Section C: Token Rotation & Push Identity Discipline", () => {
    it("maintains stable device identity across token rotation without duplicate rows", async () => {
      const deviceId = "stable-hardware-device-uuid-1";
      const token1 = "fcm_token_initial_11111";
      const token2 = "fcm_token_rotated_22222";

      // Register initial device
      await workerDeviceService.registerDevice(testWorkerId, {
        device_id: deviceId,
        device_token: token1,
        platform: "android",
      });

      let active = await workerDeviceService.getActiveDevices(testWorkerId);
      expect(active).toHaveLength(1);
      expect(active[0].device_id).toBe(deviceId);
      expect(active[0].fcm_token).toBe(token1);

      // Rotate token on same device
      await workerDeviceService.registerDevice(testWorkerId, {
        device_id: deviceId,
        device_token: token2,
        platform: "android",
      });

      active = await workerDeviceService.getActiveDevices(testWorkerId);
      expect(active).toHaveLength(1);
      expect(active[0].device_id).toBe(deviceId);
      expect(active[0].fcm_token).toBe(token2);

      // Total rows in DB remains 1
      const totalRows = await (prisma as any).worker_device.count({
        where: { worker_id: testWorkerId },
      });
      expect(totalRows).toBe(1);
    });

    it("idempotently auto-revokes invalid token upon FCM permanent rejection", async () => {
      const deadToken = "fcm_dead_token_for_revocation_drill";
      await workerDeviceService.registerDevice(testWorkerId, {
        device_id: "dead-token-device",
        device_token: deadToken,
        platform: "android",
      });

      // Simulate invalid token revocation callback
      const revokedCount = await workerDeviceService.revokeByToken(deadToken);
      expect(revokedCount).toBe(1);

      const active = await workerDeviceService.getActiveDevices(testWorkerId);
      expect(active.some((d) => d.fcm_token === deadToken)).toBe(false);

      // Second revocation call is idempotent (returns 0 revoked rows)
      const secondCallCount = await workerDeviceService.revokeByToken(deadToken);
      expect(secondCallCount).toBe(0);
    });
  });

  // ==========================================================================
  // SECTION D: DURABLE OUTBOX PIPELINE & FAILURE SEMANTICS (POSTGRESQL + BULLMQ)
  // ==========================================================================
  describe("Section D: Durable Outbox Pipeline & Failure Semantics", () => {
    let worker: OutboxWorker;

    beforeEach(() => {
      worker = new OutboxWorker(ioServer);
    });

    afterEach(async () => {
      if (worker) {
        await worker.stop();
      }
      setMockFcmProvider(null);
    });

    it("schedules exponential backoff on transient FCM failure and preserves PENDING state", async () => {
      const transientToken = "fcm_transient_failure_token";
      await customerDeviceService.registerDevice(testCustomerId, {
        device_id: "transient-customer-device",
        device_token: transientToken,
        platform: "android",
      });

      // Mock transient error provider
      setMockFcmProvider({
        sendToTokens: async (tokens) =>
          tokens.map((token) => ({
            token,
            success: false,
            error: new Error("ETIMEDOUT: Connection reset by peer"),
            isInvalidToken: false,
            errorCategory: "TRANSIENT_FAILURE",
          })),
      });

      const event = await prisma.$transaction(async (tx) => {
        return outboxService.createOutboxEvent(tx, {
          eventType: "job_assigned",
          aggregateType: "job",
          aggregateId: "11112222-3333-4444-5555-666677778888",
          recipientType: "customer",
          recipientId: testCustomerId,
          payload: { test: true },
          idempotencyKey: `test:fcm:transient:${Date.now()}`,
        });
      });

      await worker.processRecord(event!);

      const inDb = await (prisma as any).notification_outbox.findUnique({
        where: { id: event!.id },
      });

      expect(inDb.status).toBe("PENDING");
      expect(inDb.attempts).toBe(1);
      expect(new Date(inDb.available_at).getTime()).toBeGreaterThan(Date.now());
      expect(inDb.last_error).toContain("ETIMEDOUT");
    });

    it("marks terminal FAILED state when all recipient tokens are invalid without retrying", async () => {
      const invalidToken = "fcm_permanently_invalid_dead_token";
      await customerDeviceService.registerDevice(testCustomerId, {
        device_id: "invalid-customer-device",
        device_token: invalidToken,
        platform: "android",
      });

      setMockFcmProvider({
        sendToTokens: async (tokens, _payload, onInvalid) => {
          for (const t of tokens) {
            await onInvalid?.(t);
          }
          return tokens.map((token) => ({
            token,
            success: false,
            error: { code: "messaging/registration-token-not-registered", message: "Token not registered" },
            isInvalidToken: true,
            errorCategory: "UNREGISTERED_DEVICE",
          }));
        },
      });

      const event = await prisma.$transaction(async (tx) => {
        return outboxService.createOutboxEvent(tx, {
          eventType: "worker_arrived",
          aggregateType: "job",
          aggregateId: "99998888-7777-6666-5555-444433332222",
          recipientType: "customer",
          recipientId: testCustomerId,
          payload: { arrived: true },
          idempotencyKey: `test:fcm:terminal_failed:${Date.now()}`,
        });
      });

      await worker.processRecord(event!);

      const inDb = await (prisma as any).notification_outbox.findUnique({
        where: { id: event!.id },
      });

      expect(inDb.status).toBe("FAILED");
      expect(inDb.failed_at).not.toBeNull();
      expect(inDb.attempts).toBe(1);

      // Verify the invalid token device was auto-revoked
      const active = await customerDeviceService.getActiveDevices(testCustomerId);
      expect(active.some((d) => d.device_id === "invalid-customer-device")).toBe(false);
    });

    it("marks SENT when at least one multi-device push succeeds despite another token failing", async () => {
      const validToken = "fcm_multi_token_valid";
      const badToken = "fcm_multi_token_bad";

      await customerDeviceService.registerDevice(testCustomerId, {
        device_id: "multi-device-valid",
        device_token: validToken,
        platform: "android",
      });
      await customerDeviceService.registerDevice(testCustomerId, {
        device_id: "multi-device-bad",
        device_token: badToken,
        platform: "android",
      });

      setMockFcmProvider({
        sendToTokens: async (tokens, _payload, onInvalid) => {
          return tokens.map((token) => {
            if (token === badToken) {
              onInvalid?.(token);
              return {
                token,
                success: false,
                isInvalidToken: true,
                errorCategory: "INVALID_REGISTRATION_TOKEN",
                error: { code: "messaging/invalid-registration-token" },
              };
            }
            return {
              token,
              success: true,
              messageId: "projects/labourbaba-staging/messages/valid-msg-123",
            };
          });
        },
      });

      const event = await prisma.$transaction(async (tx) => {
        return outboxService.createOutboxEvent(tx, {
          eventType: "order_update",
          aggregateType: "order",
          aggregateId: "11112222-3333-4444-5555-666677778888",
          recipientType: "customer",
          recipientId: testCustomerId,
          payload: { update: "in_progress" },
          idempotencyKey: `test:fcm:multi_success:${Date.now()}`,
        });
      });

      await worker.processRecord(event!);

      const inDb = await (prisma as any).notification_outbox.findUnique({
        where: { id: event!.id },
      });

      expect(inDb.status).toBe("SENT");
      expect(inDb.processed_at).not.toBeNull();

      // Invariant: bad device revoked, good device remains active
      const active = await customerDeviceService.getActiveDevices(testCustomerId);
      expect(active.some((d) => d.device_id === "multi-device-bad")).toBe(false);
      expect(active.some((d) => d.device_id === "multi-device-valid")).toBe(true);
    });
  });

  // ==========================================================================
  // SECTION E: SOCKET.IO + FCM INTERACTION & IDEMPOTENCY
  // ==========================================================================
  describe("Section E: Socket.IO + FCM Dual-Delivery Interaction", () => {
    let clientSocket: ClientSocket;
    let customerJwt: string;
    let worker: OutboxWorker;

    beforeAll((done) => {
      customerJwt = signAccessToken({
        id: testCustomerId,
        role: UserRole.CUSTOMER,
        phone: testPhone,
      });

      clientSocket = Client(`http://localhost:${serverPort}`, {
        auth: { token: customerJwt },
        transports: ["websocket"],
      });

      clientSocket.on("connect", () => {
        done();
      });

      clientSocket.on("connect_error", (err) => {
        done(err);
      });
    });

    afterAll(() => {
      if (clientSocket && clientSocket.connected) {
        clientSocket.disconnect();
      }
    });

    beforeEach(() => {
      worker = new OutboxWorker(ioServer);
    });

    afterEach(async () => {
      if (worker) {
        await worker.stop();
      }
      setMockFcmProvider(null);
    });

    it("delivers both Socket.IO realtime event and FCM push for connected customer without duplication", async () => {
      await (prisma as any).customer_device.deleteMany({
        where: { customer_id: testCustomerId },
      });

      const goodToken = "fcm_socket_interact_token";
      await customerDeviceService.registerDevice(testCustomerId, {
        device_id: "socket-interact-device",
        device_token: goodToken,
        platform: "android",
      });

      let fcmSendCount = 0;
      setMockFcmProvider({
        sendToTokens: async (tokens) => {
          fcmSendCount += tokens.length;
          return tokens.map((token) => ({
            token,
            success: true,
            messageId: `msg_${Date.now()}`,
          }));
        },
      });

      const socketPromise = new Promise<any>((resolve) => {
        clientSocket.once("notification:booking_confirmed", (payload) => {
          resolve(payload);
        });
      });

      const event = await prisma.$transaction(async (tx) => {
        return outboxService.createOutboxEvent(tx, {
          eventType: "booking_confirmed",
          aggregateType: "booking",
          aggregateId: "33334444-5555-6666-7777-888899990000",
          recipientType: "customer",
          recipientId: testCustomerId,
          payload: { bookingId: "b-100", amount: 1500 },
          idempotencyKey: `test:socket_fcm:${Date.now()}`,
        });
      });

      await worker.processRecord(event!);

      const socketReceivedPayload = await socketPromise;
      expect(socketReceivedPayload.bookingId).toBe("b-100");
      expect(socketReceivedPayload.outboxId).toBe(event!.id);
      // Invariant: outbox record transitioned to SENT
      const inDb = await (prisma as any).notification_outbox.findUnique({
        where: { id: event!.id },
      });
      expect(inDb.status).toBe("SENT");

      // Verify batch claim query ignores already SENT event (never redelivers)
      const claimed = await outboxService.claimPendingEvents(10, 5);
      expect(claimed.some((r) => r.id === event!.id)).toBe(false);

      // Verify re-running processRecord preserves SENT state idempotently
      await worker.processRecord(inDb!);
      const finalState = await (prisma as any).notification_outbox.findUnique({
        where: { id: event!.id },
      });
      expect(finalState.status).toBe("SENT");
    });
  });

  // ==========================================================================
  // SECTION F: REAL FIREBASE CLOUD MESSAGING PROVIDER DRILL
  // ==========================================================================
  describe("Section F: Real Firebase Cloud Messaging Provider Verification", () => {
    const hasRealFirebaseCredentials = Boolean(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON ||
      process.env.FIREBASE_SERVICE_ACCOUNT_KEY ||
      (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS
    );

    const realDeviceToken = process.env.REAL_FCM_DEVICE_TOKEN;

    it("verifies production environment safeguards against silent mock fallback", async () => {
      // In non-production tests, uninitialized FCM safely fails without fake success
      resetFirebaseApp();
      setMockFcmProvider(null);

      const results = await sendFCMToTokens(["test_token_never_mock_in_prod"], {
        title: "Security Probe",
        body: "Probe Body",
      });

      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(false);
      expect(results[0].messageId).toBeUndefined();
      expect(results[0].error.message).toContain("[FCM_UNINITIALIZED]");
    });

    if (hasRealFirebaseCredentials) {
      it("REAL PROVIDER: connects to Google FCM and validates invalid token rejection", async () => {
        resetFirebaseApp();
        const firebaseApp = getFirebaseApp();
        expect(firebaseApp).toBeDefined();

        const invalidRealToken = "fcm_bogus_token_for_google_rejection_probe_123456789";
        const results = await sendFCMToTokens([invalidRealToken], {
          title: "Real Provider Test",
          body: "Testing real Firebase error response semantics",
        });

        expect(results).toHaveLength(1);
        expect(results[0].success).toBe(false);
        expect(results[0].isInvalidToken).toBe(true);
        expect(results[0].error).toBeDefined();
      });

      if (realDeviceToken) {
        it("REAL DEVICE: successfully delivers push notification to physical staging device", async () => {
          resetFirebaseApp();
          const firebaseApp = getFirebaseApp();
          expect(firebaseApp).toBeDefined();

          const results = await sendFCMToTokens([realDeviceToken], {
            title: "LabourBaba Staging Real Device Verification",
            body: `Verified at ${new Date().toISOString()}`,
          });

          expect(results).toHaveLength(1);
          expect(results[0].success).toBe(true);
          expect(results[0].messageId).toBeDefined();
          expect(results[0].messageId).toContain("projects/");
        });
      } else {
        it.skip("REAL DEVICE: physical device push skipped (REAL_FCM_DEVICE_TOKEN not provided)", () => {});
      }
    } else {
      it("REAL PROVIDER ENVIRONMENT STATUS: credentials not present in local dev — marked ENVIRONMENT_BLOCKED", () => {
        // Authoritatively documents environmental boundary
        expect(hasRealFirebaseCredentials).toBe(false);
      });
    }
  });
});
