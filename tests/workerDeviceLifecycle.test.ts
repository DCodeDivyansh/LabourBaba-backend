/**
 * tests/workerDeviceLifecycle.test.ts
 *
 * Issue #9 — Complete WorkerDevice Lifecycle
 *
 * Verifies:
 * 1. Authentication / access control for device endpoints
 * 2. Device registration (new device creates a row)
 * 3. Token rotation (re-registering same device_id updates token, doesn t duplicate)
 * 4. Legacy device_id fallback (no device_id -> SHA-256 of fcm_token)
 * 5. GET /me/devices returns DTO without leaking fcm_token
 * 6. Revocation via DELETE /me/devices/:deviceId
 * 7. Cross-worker isolation (worker B cannot revoke worker A s device)
 * 8. Auto-revocation of invalid FCM token via revokeByToken()
 * 9. Batch active-device lookup (getActiveDevicesForWorkers)
 */

import request from "supertest";
import { app } from "../src/server";
import { generateToken } from "../src/utils/authUtils";
import { UserRole } from "../src/type/userRole";
import prisma from "../src/config/prisma";
import { workerDeviceService } from "../src/features/worker_device/worker_device.service";

// -- Mocks ---------------------------------------------------------------------

jest.mock("../src/config/bullmq", () => ({
  dispatchQueue: { add: jest.fn().mockResolvedValue({}) },
  timeoutQueue: { add: jest.fn().mockResolvedValue({}) },
  connection: {},
}));

jest.mock("../src/features/dispatch/simpleDispatch", () => ({
  dispatchJobSimple: jest.fn().mockResolvedValue({}),
}));

jest.mock("../src/config/prisma", () => ({
  __esModule: true,
  default: {
    worker: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    worker_device: {
      upsert: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn((cb: any) => cb(prisma)),
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
  },
}));

// -- Test Identities ------------------------------------------------------------

const WORKER_A_ID = "aaaa0001-0001-4001-a001-000000000001";
const WORKER_B_ID = "bbbb0002-0002-4002-a002-000000000002";
const CUSTOMER_ID = "cccc0003-0003-4003-a003-000000000003";

const workerAToken = generateToken({
  id: WORKER_A_ID,
  role: UserRole.WORKER,
  phone: "+919800000001",
});
const workerBToken = generateToken({
  id: WORKER_B_ID,
  role: UserRole.WORKER,
  phone: "+919800000002",
});
const customerToken = generateToken({
  id: CUSTOMER_ID,
  role: UserRole.CUSTOMER,
  phone: "+919800000003",
});

// -- Shared fixtures ------------------------------------------------------------

const FCM_TOKEN_A1 = "fcm-token-worker-a-device-1";
const FCM_TOKEN_A2 = "fcm-token-worker-a-device-1-rotated";
const FCM_TOKEN_A3 = "fcm-token-worker-a-device-2";
const DEVICE_ID_1 = "device-physical-id-001";
const DEVICE_ID_2 = "device-physical-id-002";

function makeDeviceRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: "row-uuid-001",
    worker_id: WORKER_A_ID,
    device_id: DEVICE_ID_1,
    fcm_token: FCM_TOKEN_A1,
    platform: "android",
    last_seen_at: new Date(),
    revoked_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// -- Test Suite -----------------------------------------------------------------

describe("Issue #9 — WorkerDevice Lifecycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.worker.findUnique as jest.Mock).mockResolvedValue({
      id: WORKER_A_ID,
      phone: "+919800000001",
      password: "hashed",
    });
  });

  // 1. Authentication & Role Enforcement

  describe("1. Authentication & Role Enforcement", () => {
    it("POST /me/devices -> 401 for unauthenticated request", async () => {
      const res = await request(app)
        .post("/api/workers/me/devices")
        .send({ device_token: FCM_TOKEN_A1, device_id: DEVICE_ID_1 });
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("GET /me/devices -> 401 for unauthenticated request", async () => {
      const res = await request(app).get("/api/workers/me/devices");
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("DELETE /me/devices/:deviceId -> 401 for unauthenticated request", async () => {
      const res = await request(app).delete(
        `/api/workers/me/devices/${DEVICE_ID_1}`,
      );
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("POST /me/devices -> 403 for CUSTOMER role", async () => {
      const res = await request(app)
        .post("/api/workers/me/devices")
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ device_token: FCM_TOKEN_A1 });
      expect(res.status).toBe(403);
    });

    it("GET /me/devices -> 403 for CUSTOMER role", async () => {
      const res = await request(app)
        .get("/api/workers/me/devices")
        .set("Authorization", `Bearer ${customerToken}`);
      expect(res.status).toBe(403);
    });
  });

  // 2. Input Validation

  describe("2. Input Validation", () => {
    it("POST /me/devices -> 400 if device_token is missing", async () => {
      const res = await request(app)
        .post("/api/workers/me/devices")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ device_id: DEVICE_ID_1 });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("POST /me/devices -> 400 if device_token is empty string", async () => {
      const res = await request(app)
        .post("/api/workers/me/devices")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ device_token: "" });
      expect(res.status).toBe(400);
    });
  });

  // 3. Device Registration

  describe("3. Device Registration (new device)", () => {
    it("POST /me/devices -> 200 and returns WorkerDeviceDTO (no fcm_token)", async () => {
      const row = makeDeviceRow();
      (prisma.worker_device.upsert as jest.Mock).mockResolvedValue(row);
      (prisma.worker.update as jest.Mock).mockResolvedValue({ id: WORKER_A_ID });

      const res = await request(app)
        .post("/api/workers/me/devices")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ device_token: FCM_TOKEN_A1, device_id: DEVICE_ID_1, platform: "android" });

      expect([200, 201]).toContain(res.status);
      expect(res.body.success).toBe(true);

      const dto = res.body.data;
      expect(dto).toBeDefined();
      expect(dto.fcm_token).toBeUndefined();
      expect(dto.device_id).toBeDefined();
      expect(dto.platform).toBe("android");
      expect(dto.is_active).toBe(true);
    });

    it("POST /me/devices with platform ios is stored correctly", async () => {
      const row = makeDeviceRow({ platform: "ios", fcm_token: FCM_TOKEN_A1 });
      (prisma.worker_device.upsert as jest.Mock).mockResolvedValue(row);
      (prisma.worker.update as jest.Mock).mockResolvedValue({ id: WORKER_A_ID });

      const res = await request(app)
        .post("/api/workers/me/devices")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ device_token: FCM_TOKEN_A1, device_id: DEVICE_ID_1, platform: "ios" });

      expect([200, 201]).toContain(res.status);
      expect(res.body.data.platform).toBe("ios");
    });
  });

  // 4. Token Rotation

  describe("4. Token Rotation (same device_id, new fcm_token)", () => {
    it("Re-registering same device_id calls upsert (updates, not creates duplicate)", async () => {
      const rotatedRow = makeDeviceRow({ fcm_token: FCM_TOKEN_A2 });
      (prisma.worker_device.upsert as jest.Mock).mockResolvedValue(rotatedRow);
      (prisma.worker.update as jest.Mock).mockResolvedValue({ id: WORKER_A_ID });

      await request(app)
        .post("/api/workers/me/devices")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ device_token: FCM_TOKEN_A2, device_id: DEVICE_ID_1 });

      expect(prisma.worker_device.upsert).toHaveBeenCalledTimes(1);
      const call = (prisma.worker_device.upsert as jest.Mock).mock.calls[0][0];
      expect(call.where.worker_id_device_id).toEqual({
        worker_id: WORKER_A_ID,
        device_id: DEVICE_ID_1,
      });
      expect(call.update.fcm_token).toBe(FCM_TOKEN_A2);
      expect(call.update.revoked_at).toBeNull();
    });

    it("Token rotation response DTO does not expose the raw token", async () => {
      const rotatedRow = makeDeviceRow({ fcm_token: FCM_TOKEN_A2 });
      (prisma.worker_device.upsert as jest.Mock).mockResolvedValue(rotatedRow);
      (prisma.worker.update as jest.Mock).mockResolvedValue({ id: WORKER_A_ID });

      const res = await request(app)
        .post("/api/workers/me/devices")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ device_token: FCM_TOKEN_A2, device_id: DEVICE_ID_1 });

      expect(res.body.data.fcm_token).toBeUndefined();
    });
  });

  // 5. Legacy device_id Fallback

  describe("5. Legacy device_id fallback (no device_id supplied)", () => {
    it("When no device_id is sent, upsert is still called (SHA-256 fallback)", async () => {
      const row = makeDeviceRow({ device_id: "sha-derived-id" });
      (prisma.worker_device.upsert as jest.Mock).mockResolvedValue(row);
      (prisma.worker.update as jest.Mock).mockResolvedValue({ id: WORKER_A_ID });

      const res = await request(app)
        .post("/api/workers/me/devices")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ device_token: FCM_TOKEN_A1 });

      expect([200, 201]).toContain(res.status);
      expect(prisma.worker_device.upsert).toHaveBeenCalledTimes(1);
    });
  });

  // 6. GET /me/devices -- DTO boundary

  describe("6. GET /me/devices — DTO field boundary", () => {
    it("Returns list of WorkerDeviceDTO objects — fcm_token MUST NOT appear", async () => {
      const rows = [
        makeDeviceRow({ id: "row-1", device_id: DEVICE_ID_1, fcm_token: FCM_TOKEN_A1 }),
        makeDeviceRow({
          id: "row-2",
          device_id: DEVICE_ID_2,
          fcm_token: FCM_TOKEN_A3,
          revoked_at: new Date(),
        }),
      ];
      (prisma.worker_device.findMany as jest.Mock).mockResolvedValue(rows);

      const res = await request(app)
        .get("/api/workers/me/devices")
        .set("Authorization", `Bearer ${workerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(2);

      for (const dto of res.body.data) {
        expect(dto.fcm_token).toBeUndefined();
        expect(dto.id).toBeDefined();
        expect(dto.device_id).toBeDefined();
        expect(dto.platform).toBeDefined();
        expect(typeof dto.is_active).toBe("boolean");
      }

      const revokedDto = res.body.data.find(
        (d: any) => d.device_id === DEVICE_ID_2,
      );
      expect(revokedDto?.is_active).toBe(false);
    });

    it("Worker B can only read their own devices (scoped to Worker B id)", async () => {
      (prisma.worker_device.findMany as jest.Mock).mockResolvedValue([]);

      await request(app)
        .get("/api/workers/me/devices")
        .set("Authorization", `Bearer ${workerBToken}`);

      const callArgs = (prisma.worker_device.findMany as jest.Mock).mock.calls[0][0];
      expect(callArgs.where?.worker_id).toBe(WORKER_B_ID);
    });
  });

  // 7. Soft Revocation

  describe("7. Soft Revocation — DELETE /me/devices/:deviceId", () => {
    it("Revokes a specific device by device_id", async () => {
      (prisma.worker_device.updateMany as jest.Mock).mockResolvedValue({
        count: 1,
      });

      const res = await request(app)
        .delete(`/api/workers/me/devices/${DEVICE_ID_1}`)
        .set("Authorization", `Bearer ${workerAToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data?.revokedCount).toBe(1);

      const callArgs = (prisma.worker_device.updateMany as jest.Mock).mock.calls[0][0];
      expect(callArgs.where?.worker_id).toBe(WORKER_A_ID);
      expect(callArgs.where?.device_id).toBe(DEVICE_ID_1);
      expect(callArgs.data?.revoked_at).toBeDefined();
    });

    it("Revoking a device that does not belong to this worker yields 0 affected rows", async () => {
      (prisma.worker_device.updateMany as jest.Mock).mockResolvedValue({
        count: 0,
      });

      const res = await request(app)
        .delete(`/api/workers/me/devices/${DEVICE_ID_1}`)
        .set("Authorization", `Bearer ${workerBToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data?.revokedCount).toBe(0);

      const callArgs = (prisma.worker_device.updateMany as jest.Mock).mock.calls[0][0];
      expect(callArgs.where?.worker_id).toBe(WORKER_B_ID);
    });
  });

  // 8. WorkerDeviceService Unit Tests

  describe("8. WorkerDeviceService unit tests", () => {
    describe("registerDevice()", () => {
      it("Upserts with correct compound key and returns DTO without fcm_token", async () => {
        const row = makeDeviceRow();
        (prisma.worker_device.upsert as jest.Mock).mockResolvedValue(row);
        (prisma.worker.update as jest.Mock).mockResolvedValue({ id: WORKER_A_ID });

        const dto = await workerDeviceService.registerDevice(WORKER_A_ID, {
          device_token: FCM_TOKEN_A1,
          device_id: DEVICE_ID_1,
          platform: "android",
        });

        expect(dto).toBeDefined();
        expect((dto as any).fcm_token).toBeUndefined();
        expect(dto.device_id).toBeDefined();
        expect(dto.is_active).toBe(true);
      });
    });

    describe("getActiveDevices()", () => {
      it("Returns only non-revoked devices", async () => {
        const activeRows = [makeDeviceRow({ id: "r1", revoked_at: null })];
        (prisma.worker_device.findMany as jest.Mock).mockResolvedValue(activeRows);

        const results = await workerDeviceService.getActiveDevices(WORKER_A_ID);

        expect(results.length).toBe(1);
        const callArgs = (prisma.worker_device.findMany as jest.Mock).mock.calls[0][0];
        expect(callArgs.where?.revoked_at).toBeNull();
      });
    });

    describe("getActiveDevicesForWorkers()", () => {
      it("Returns a Map keyed by worker_id, empty for unknown workers", async () => {
        (prisma.worker_device.findMany as jest.Mock).mockResolvedValue([]);

        const map = await workerDeviceService.getActiveDevicesForWorkers([
          "unknown-worker-id",
        ]);

        expect(map).toBeInstanceOf(Map);
        expect(map.size).toBe(0);
      });

      it("Groups devices correctly when multiple workers share the same batch", async () => {
        const rows = [
          makeDeviceRow({ id: "r1", worker_id: WORKER_A_ID, device_id: DEVICE_ID_1 }),
          makeDeviceRow({ id: "r2", worker_id: WORKER_A_ID, device_id: DEVICE_ID_2 }),
          makeDeviceRow({ id: "r3", worker_id: WORKER_B_ID, device_id: DEVICE_ID_1 }),
        ];
        (prisma.worker_device.findMany as jest.Mock).mockResolvedValue(rows);

        const map = await workerDeviceService.getActiveDevicesForWorkers([
          WORKER_A_ID,
          WORKER_B_ID,
        ]);

        expect(map.get(WORKER_A_ID)?.length).toBe(2);
        expect(map.get(WORKER_B_ID)?.length).toBe(1);
      });

      it("Returns empty Map for empty workerIds array (no DB call)", async () => {
        const map = await workerDeviceService.getActiveDevicesForWorkers([]);
        expect(map.size).toBe(0);
        expect(prisma.worker_device.findMany).not.toHaveBeenCalled();
      });
    });

    describe("revokeDevice()", () => {
      it("Calls updateMany with correct worker_id + device_id scope", async () => {
        (prisma.worker_device.updateMany as jest.Mock).mockResolvedValue({
          count: 1,
        });

        const result = await workerDeviceService.revokeDevice(
          WORKER_A_ID,
          DEVICE_ID_1,
        );

        expect(result.success).toBe(true);
        expect(result.revokedCount).toBe(1);

        const callArgs = (prisma.worker_device.updateMany as jest.Mock).mock.calls[0][0];
        expect(callArgs.where?.worker_id).toBe(WORKER_A_ID);
        expect(callArgs.where?.device_id).toBe(DEVICE_ID_1);
        expect(callArgs.where?.revoked_at).toBeNull();
        expect(callArgs.data?.revoked_at).toBeDefined();
      });
    });

    describe("revokeByToken() — auto-revoke on invalid FCM token", () => {
      it("Revokes all devices matching the invalid FCM token", async () => {
        (prisma.worker_device.updateMany as jest.Mock).mockResolvedValue({
          count: 2,
        });

        const count = await workerDeviceService.revokeByToken(FCM_TOKEN_A1);

        expect(count).toBe(2);
        const callArgs = (prisma.worker_device.updateMany as jest.Mock).mock.calls[0][0];
        expect(callArgs.where?.fcm_token).toBe(FCM_TOKEN_A1);
        expect(callArgs.where?.revoked_at).toBeNull();
        expect(callArgs.data?.revoked_at).toBeDefined();
      });

      it("Returns 0 and does nothing for empty token string", async () => {
        const count = await workerDeviceService.revokeByToken("");
        expect(count).toBe(0);
        expect(prisma.worker_device.updateMany).not.toHaveBeenCalled();
      });
    });

    describe("listDevices()", () => {
      it("Returns all devices (active and revoked), ordered by last_seen_at desc", async () => {
        const rows = [
          makeDeviceRow({ id: "r1", revoked_at: null }),
          makeDeviceRow({ id: "r2", revoked_at: new Date() }),
        ];
        (prisma.worker_device.findMany as jest.Mock).mockResolvedValue(rows);

        const dtos = await workerDeviceService.listDevices(WORKER_A_ID);

        expect(dtos.length).toBe(2);
        expect(dtos.find((d) => d.id === "r1")?.is_active).toBe(true);
        expect(dtos.find((d) => d.id === "r2")?.is_active).toBe(false);

        for (const dto of dtos) {
          expect((dto as any).fcm_token).toBeUndefined();
        }

        const callArgs = (prisma.worker_device.findMany as jest.Mock).mock.calls[0][0];
        expect(callArgs.orderBy?.last_seen_at).toBe("desc");
      });
    });
  });

  // 9. DTO Boundary regression

  describe("9. DTO Boundary regression", () => {
    it("POST /me/devices response body never contains fcm_token", async () => {
      const row = makeDeviceRow();
      (prisma.worker_device.upsert as jest.Mock).mockResolvedValue(row);
      (prisma.worker.update as jest.Mock).mockResolvedValue({ id: WORKER_A_ID });

      const res = await request(app)
        .post("/api/workers/me/devices")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ device_token: FCM_TOKEN_A1, device_id: DEVICE_ID_1 });

      const body = JSON.stringify(res.body);
      expect(body).not.toContain(FCM_TOKEN_A1);
      expect(body).not.toContain("password");
      expect(body).not.toContain("updated_at");
    });

    it("GET /me/devices response body never contains raw fcm_token values", async () => {
      const rows = [
        makeDeviceRow({ id: "r1", fcm_token: FCM_TOKEN_A1 }),
        makeDeviceRow({ id: "r2", fcm_token: FCM_TOKEN_A3, device_id: DEVICE_ID_2 }),
      ];
      (prisma.worker_device.findMany as jest.Mock).mockResolvedValue(rows);

      const res = await request(app)
        .get("/api/workers/me/devices")
        .set("Authorization", `Bearer ${workerAToken}`);

      const body = JSON.stringify(res.body);
      expect(body).not.toContain(FCM_TOKEN_A1);
      expect(body).not.toContain(FCM_TOKEN_A3);
    });
  });
});
