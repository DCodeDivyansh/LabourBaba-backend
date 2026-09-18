import request from "supertest";
import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { generateToken } from "../src/utils/authUtils";
import { UserRole } from "../src/middlewares/authMiddleware";

// Mock prisma client
jest.mock("../src/config/prisma", () => ({
  __esModule: true,
  default: {
    worker: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    worker_location: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
  },
}));

describe("P0 Finding #6 Security Regression Suite: Worker Location Identity Spoofing", () => {
  const WORKER_A_ID = "11111111-1111-4111-a111-111111111111";
  const WORKER_B_ID = "22222222-2222-4222-a222-222222222222";
  const CUSTOMER_ID = "33333333-3333-4333-a333-333333333333";
  const INACTIVE_WORKER_ID = "44444444-4444-4444-a444-444444444444";

  let workerAToken: string;
  let workerBToken: string;
  let customerToken: string;
  let inactiveWorkerToken: string;

  // In-memory simulated DB state to verify database isolation
  let simulatedDb: {
    workers: Map<string, { id: string; location_geo: string | null; deleted_at: Date | null }>;
    workerLocations: Array<{ id: string; worker_id: string; location_geo: string | null; created_at: Date }>;
  };

  beforeAll(() => {
    workerAToken = generateToken({ id: WORKER_A_ID, phone: "+919876543211", role: UserRole.WORKER });
    workerBToken = generateToken({ id: WORKER_B_ID, phone: "+919876543212", role: UserRole.WORKER });
    customerToken = generateToken({ id: CUSTOMER_ID, phone: "+919876543213", role: UserRole.CUSTOMER });
    inactiveWorkerToken = generateToken({ id: INACTIVE_WORKER_ID, phone: "+919876543214", role: UserRole.WORKER });
  });

  beforeEach(() => {
    jest.clearAllMocks();

    simulatedDb = {
      workers: new Map([
        [WORKER_A_ID, { id: WORKER_A_ID, location_geo: "POINT(77.10 28.70)", deleted_at: null }],
        [WORKER_B_ID, { id: WORKER_B_ID, location_geo: "POINT(72.87 19.07)", deleted_at: null }],
        [INACTIVE_WORKER_ID, { id: INACTIVE_WORKER_ID, location_geo: "POINT(75.80 26.90)", deleted_at: new Date("2026-01-01") }],
      ]),
      workerLocations: [
        { id: "initial-hist-b", worker_id: WORKER_B_ID, location_geo: "POINT(72.87 19.07)", created_at: new Date("2026-01-01") },
      ],
    };

    // Default mock behavior routing through simulatedDb
    (prisma.worker.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => {
      const worker = simulatedDb.workers.get(where.id);
      return worker ? { id: worker.id, deleted_at: worker.deleted_at } : null;
    });

    (prisma.worker_location.create as jest.Mock).mockImplementation(async ({ data }: any) => {
      const newEntry = {
        id: "loc-" + Math.random().toString(36).substring(2, 9),
        worker_id: data.worker_id,
        location_geo: null,
        created_at: new Date(),
      };
      simulatedDb.workerLocations.push(newEntry);
      return newEntry;
    });

    (prisma.$executeRaw as jest.Mock).mockImplementation(async (strings: TemplateStringsArray, ...values: any[]) => {
      const query = strings.join("?");
      if (query.includes("UPDATE worker_location")) {
        const [lon, lat, locId] = values;
        const entry = simulatedDb.workerLocations.find((l) => l.id === locId);
        if (entry) {
          entry.location_geo = `POINT(${lon} ${lat})`;
        }
      } else if (query.includes("UPDATE worker")) {
        const [lon, lat, wId] = values;
        const worker = simulatedDb.workers.get(wId);
        if (worker) {
          worker.location_geo = `POINT(${lon} ${lat})`;
        }
      }
      return 1;
    });

    (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
      return await callback(prisma);
    });
  });

  describe("A. Unauthenticated Requests (401 Unauthorized)", () => {
    it("POST /api/worker_location/add must reject unauthenticated requests with 401", async () => {
      const res = await request(app)
        .post("/api/worker_location/add")
        .send({ latitude: 26.85, longitude: 80.95 });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("PATCH /api/workers/me/location must reject unauthenticated requests with 401", async () => {
      const res = await request(app)
        .patch("/api/workers/me/location")
        .send({ latitude: 26.85, longitude: 80.95 });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  describe("B. Non-Worker Role Authorization (403 Forbidden)", () => {
    it("POST /api/worker_location/add must reject Customer role with 403 Forbidden", async () => {
      const initialBGeo = simulatedDb.workers.get(WORKER_B_ID)?.location_geo;

      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ latitude: 26.85, longitude: 80.95 });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/forbidden/i);

      // Verify no DB mutations occurred
      expect(simulatedDb.workers.get(WORKER_B_ID)?.location_geo).toBe(initialBGeo);
    });

    it("PATCH /api/workers/me/location must reject Customer role with 403 Forbidden", async () => {
      const res = await request(app)
        .patch("/api/workers/me/location")
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ latitude: 26.85, longitude: 80.95 });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/forbidden/i);
    });
  });

  describe("C. Authenticated Worker Self-Update (200 OK)", () => {
    it("POST /api/worker_location/add updates authenticated Worker A's location successfully", async () => {
      const newLat = 26.85;
      const newLon = 80.95;

      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ latitude: newLat, longitude: newLon });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // DB verification: Worker A has updated location
      expect(simulatedDb.workers.get(WORKER_A_ID)?.location_geo).toBe(`POINT(${newLon} ${newLat})`);
      // Worker B remains completely untouched
      expect(simulatedDb.workers.get(WORKER_B_ID)?.location_geo).toBe("POINT(72.87 19.07)");
    });

    it("PATCH /api/workers/me/location updates authenticated Worker A's location successfully", async () => {
      const newLat = 28.61;
      const newLon = 77.20;

      const res = await request(app)
        .patch("/api/workers/me/location")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ latitude: newLat, longitude: newLon });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(simulatedDb.workers.get(WORKER_A_ID)?.location_geo).toBe(`POINT(${newLon} ${newLat})`);
      expect(simulatedDb.workers.get(WORKER_B_ID)?.location_geo).toBe("POINT(72.87 19.07)");
    });
  });

  describe("D. worker_id Spoofing Prevention", () => {
    it("POST /api/worker_location/add rejects request containing body.worker_id with 400", async () => {
      const initialBGeo = simulatedDb.workers.get(WORKER_B_ID)?.location_geo;
      const initialHistCount = simulatedDb.workerLocations.filter((l) => l.worker_id === WORKER_B_ID).length;

      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({
          worker_id: WORKER_B_ID,
          latitude: 26.85,
          longitude: 80.95,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);

      // Verify Worker B's current location and history remain completely untouched
      expect(simulatedDb.workers.get(WORKER_B_ID)?.location_geo).toBe(initialBGeo);
      const postHistCount = simulatedDb.workerLocations.filter((l) => l.worker_id === WORKER_B_ID).length;
      expect(postHistCount).toBe(initialHistCount);
    });

    it("PATCH /api/workers/me/location rejects request containing body.worker_id with 400", async () => {
      const initialBGeo = simulatedDb.workers.get(WORKER_B_ID)?.location_geo;

      const res = await request(app)
        .patch("/api/workers/me/location")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({
          worker_id: WORKER_B_ID,
          latitude: 26.85,
          longitude: 80.95,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(simulatedDb.workers.get(WORKER_B_ID)?.location_geo).toBe(initialBGeo);
    });
  });

  describe("E. workerId Spoofing Prevention", () => {
    it("POST /api/worker_location/add rejects request containing body.workerId with 400", async () => {
      const initialBGeo = simulatedDb.workers.get(WORKER_B_ID)?.location_geo;

      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({
          workerId: WORKER_B_ID,
          latitude: 26.85,
          longitude: 80.95,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(simulatedDb.workers.get(WORKER_B_ID)?.location_geo).toBe(initialBGeo);
    });

    it("PATCH /api/workers/me/location rejects request containing body.workerId with 400", async () => {
      const initialBGeo = simulatedDb.workers.get(WORKER_B_ID)?.location_geo;

      const res = await request(app)
        .patch("/api/workers/me/location")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({
          workerId: WORKER_B_ID,
          latitude: 26.85,
          longitude: 80.95,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(simulatedDb.workers.get(WORKER_B_ID)?.location_geo).toBe(initialBGeo);
    });
  });

  describe("F. Query Parameter Spoofing Prevention", () => {
    it("POST /api/worker_location/add rejects query parameter ?worker_id=WORKER_B_ID with 400", async () => {
      const initialBGeo = simulatedDb.workers.get(WORKER_B_ID)?.location_geo;

      const res = await request(app)
        .post(`/api/worker_location/add?worker_id=${WORKER_B_ID}`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({
          latitude: 26.85,
          longitude: 80.95,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(simulatedDb.workers.get(WORKER_B_ID)?.location_geo).toBe(initialBGeo);
    });

    it("PATCH /api/workers/me/location rejects query parameter ?workerId=WORKER_B_ID with 400", async () => {
      const initialBGeo = simulatedDb.workers.get(WORKER_B_ID)?.location_geo;

      const res = await request(app)
        .patch(`/api/workers/me/location?workerId=${WORKER_B_ID}`)
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({
          latitude: 26.85,
          longitude: 80.95,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(simulatedDb.workers.get(WORKER_B_ID)?.location_geo).toBe(initialBGeo);
    });
  });

  describe("G. Database-Level Isolation & Invariant Verification", () => {
    it("Proves conclusively that Worker A's update modifies only Worker A and NEVER Worker B", async () => {
      const workerBInitialLocation = simulatedDb.workers.get(WORKER_B_ID)?.location_geo;
      const workerBInitialHistory = simulatedDb.workerLocations.filter((l) => l.worker_id === WORKER_B_ID);

      const targetLat = 13.0827;
      const targetLon = 80.2707;

      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ latitude: targetLat, longitude: targetLon });

      expect(res.status).toBe(200);

      // Verify Worker A is updated
      expect(simulatedDb.workers.get(WORKER_A_ID)?.location_geo).toBe(`POINT(${targetLon} ${targetLat})`);

      // Verify Worker B is 100% UNCHANGED
      expect(simulatedDb.workers.get(WORKER_B_ID)?.location_geo).toBe(workerBInitialLocation);
      const workerBPostHistory = simulatedDb.workerLocations.filter((l) => l.worker_id === WORKER_B_ID);
      expect(workerBPostHistory).toEqual(workerBInitialHistory);

      // History added belongs ONLY to Worker A
      const workerAHistory = simulatedDb.workerLocations.filter((l) => l.worker_id === WORKER_A_ID);
      expect(workerAHistory.length).toBeGreaterThan(0);
      expect(workerAHistory[workerAHistory.length - 1].worker_id).toBe(WORKER_A_ID);
    });
  });

  describe("H. Coordinate Boundary and Validation Tests", () => {
    it("accepts boundary coordinates: latitude -90 and longitude -180", async () => {
      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ latitude: -90, longitude: -180 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("accepts boundary coordinates: latitude 90 and longitude 180", async () => {
      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ latitude: 90, longitude: 180 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("explicitly allows zero coordinates: latitude 0 and longitude 0", async () => {
      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ latitude: 0, longitude: 0 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(simulatedDb.workers.get(WORKER_A_ID)?.location_geo).toBe("POINT(0 0)");
    });

    it("rejects latitude exceeding bounds (> 90)", async () => {
      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ latitude: 90.000001, longitude: 80.95 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("rejects latitude below bounds (< -90)", async () => {
      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ latitude: -90.000001, longitude: 80.95 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("rejects longitude exceeding bounds (> 180)", async () => {
      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ latitude: 26.85, longitude: 180.000001 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("rejects longitude below bounds (< -180)", async () => {
      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ latitude: 26.85, longitude: -180.000001 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("rejects non-numeric coordinates (strings)", async () => {
      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ latitude: "not-a-number", longitude: 80.95 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("rejects missing coordinate properties", async () => {
      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ latitude: 26.85 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });
  });

  describe("I. Deactivated / Inactive Workers", () => {
    it("rejects location updates from a deactivated worker with 401", async () => {
      // Issue #11: authenticateJWT now performs an authoritative DB check.
      // Workers with deleted_at != null are rejected at the middleware level (401)
      // before reaching the controller, so the response is 401 ACCOUNT_SUSPENDED.
      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${inactiveWorkerToken}`)
        .send({ latitude: 26.85, longitude: 80.95 });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("ACCOUNT_SUSPENDED");
    });

    it("rejects location updates from a non-existent worker with 401", async () => {
      // Issue #11: authenticateJWT returns null for missing workers, yielding 401
      // before the controller is invoked. Unknown worker IDs cannot pass auth.
      const unknownToken = generateToken({
        id: "99999999-9999-4999-a999-999999999999",
        phone: "+919876543299",
        role: UserRole.WORKER,
      });

      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${unknownToken}`)
        .send({ latitude: 26.85, longitude: 80.95 });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe("ACCOUNT_SUSPENDED");
    });
  });
});
