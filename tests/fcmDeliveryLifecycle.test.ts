import {
  sendFCMToTokens,
  sendFCMToWorker,
  isPermanentInvalidTokenError,
  assertFcmConfig,
  setMockFcmProvider,
  resetFirebaseApp,
} from "../src/shared/fcm";
import { workerDeviceService } from "../src/features/worker_device/worker_device.service";
import prisma from "../src/config/prisma";

describe("Issue 45 / P5 Issue 22 - FCM Delivery Lifecycle & Fail-Fast Guarantees", () => {
  const testWorkerId = "00000000-0000-4000-b000-000000000001";
  const dummyToken1 = "fcm_test_token_1_valid_alphanumeric_123456";
  const dummyToken2 = "fcm_test_token_2_valid_alphanumeric_654321";

  beforeAll(async () => {
    // Ensure a valid skill_category exists for FK
    let category = await prisma.skill_category.findFirst();
    if (!category) {
      category = await prisma.skill_category.create({
        data: { name: "Helper", description: "General Helper" },
      });
    }

    // Create test worker in database
    await prisma.worker.upsert({
      where: { id: testWorkerId },
      update: { phone: "+919999000001", skill_category_id: category.id },
      create: {
        id: testWorkerId,
        phone: "+919999000001",
        name: "FCM Test Worker",
        password: "hash",
        skill_type: "Helper",
        skill_category_id: category.id,
      },
    });
  });

  afterAll(async () => {
    setMockFcmProvider(null);
    resetFirebaseApp();
    await prisma.worker_device.deleteMany({
      where: { worker_id: testWorkerId },
    }).catch(() => {});
    await prisma.worker.deleteMany({
      where: { id: testWorkerId },
    }).catch(() => {});
    await prisma.$disconnect();
  });

  describe("Error Classification", () => {
    it("correctly identifies permanently invalid or unregistered registration tokens", () => {
      expect(isPermanentInvalidTokenError({ code: "messaging/registration-token-not-registered" })).toBe(true);
      expect(isPermanentInvalidTokenError({ code: "messaging/invalid-registration-token" })).toBe(true);
      expect(isPermanentInvalidTokenError({ message: "The registration token is not a valid FCM registration token" })).toBe(true);
      expect(isPermanentInvalidTokenError({ message: "Requested entity was not found." })).toBe(true);
    });

    it("does NOT classify transient network or timeout errors as invalid tokens", () => {
      expect(isPermanentInvalidTokenError({ code: "messaging/server-unavailable" })).toBe(false);
      expect(isPermanentInvalidTokenError({ message: "ETIMEDOUT" })).toBe(false);
      expect(isPermanentInvalidTokenError({ message: "Connection reset by peer" })).toBe(false);
    });
  });

  describe("Multi-Device Delivery & Explicit Provider Injection", () => {
    beforeEach(() => {
      // Inject explicit test mock provider
      setMockFcmProvider({
        sendToTokens: async (tokens, payload) => {
          return tokens.map((token) => ({
            token,
            success: true,
            messageId: `msg_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          }));
        },
      });
    });

    afterEach(() => {
      setMockFcmProvider(null);
    });

    it("registers multiple devices for a single worker and supports multi-device delivery via mock provider", async () => {
      // Register Device 1
      await workerDeviceService.registerDevice(testWorkerId, {
        device_id: "device-uuid-1",
        device_token: dummyToken1,
        platform: "android",
      });

      // Register Device 2
      await workerDeviceService.registerDevice(testWorkerId, {
        device_id: "device-uuid-2",
        device_token: dummyToken2,
        platform: "ios",
      });

      const active = await workerDeviceService.getActiveDevices(testWorkerId);
      expect(active.length).toBe(2);

      const results = await sendFCMToWorker(testWorkerId, {
        title: "Incoming Dispatch",
        body: "Wave 1 Opportunity",
      });

      expect(results.length).toBe(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(results[0].messageId).toBeDefined();
      expect(results[0].messageId).not.toBe("stub-message-id");
    });

    it("auto-revokes invalid device token when reported by FCM", async () => {
      const invalidToken = "invalid_fcm_token_to_revoke";

      // Register invalid device
      await workerDeviceService.registerDevice(testWorkerId, {
        device_id: "device-invalid-to-revoke",
        device_token: invalidToken,
        platform: "android",
      });

      // Simulate invalid token detection callback
      await workerDeviceService.revokeByToken(invalidToken);

      const active = await workerDeviceService.getActiveDevices(testWorkerId);
      const hasInvalid = active.some((d) => d.fcm_token === invalidToken);
      expect(hasInvalid).toBe(false);
    });
  });

  describe("Zero Stub Success Invariant", () => {
    it("returns success: false and never returns fake stub-message-id when uninitialized and no mock registered", async () => {
      setMockFcmProvider(null);
      resetFirebaseApp();

      const results = await sendFCMToTokens(["test_token_123"], {
        title: "Test Alert",
        body: "Test Body",
      });

      expect(results.length).toBe(1);
      expect(results[0].success).toBe(false);
      expect(results[0].messageId).toBeUndefined();
      expect(results[0].error).toBeDefined();
      expect(results[0].error.message).toContain("[FCM_UNINITIALIZED]");
    });
  });

  describe("Production Configuration Gatekeeper", () => {
    it("throws in production if Firebase configuration is missing", () => {
      const originalEnv = process.env.NODE_ENV;
      const originalVar = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      const originalGoogle = process.env.GOOGLE_APPLICATION_CREDENTIALS;

      process.env.NODE_ENV = "production";
      delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

      expect(() => assertFcmConfig()).toThrow("Production requires valid Firebase Admin SDK credentials");

      process.env.NODE_ENV = originalEnv;
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON = originalVar;
      process.env.GOOGLE_APPLICATION_CREDENTIALS = originalGoogle;
    });

    it("prohibits registering mock FCM provider in production environment", () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";

      expect(() => {
        setMockFcmProvider({
          sendToTokens: async () => [],
        });
      }).toThrow("[SECURITY_VIOLATION] Mock FCM provider cannot be registered in production environment.");

      process.env.NODE_ENV = originalEnv;
    });
  });
});
