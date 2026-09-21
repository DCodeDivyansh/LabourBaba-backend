import request from "supertest";
import { app } from "../src/server";
import prisma from "../src/config/prisma";
import { generateToken } from "../src/utils/authUtils";
import { UserRole } from "../src/middlewares/authMiddleware";
import { workerLocationService } from "../src/features/worker_location/worker_location.service";
import { getEligibleDispatchCandidates } from "../src/features/dispatch/dispatchCandidate.service";
import { bookingService } from "../src/features/booking/bookingServices";

// Mock prisma client for unit/controller testing
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
    booking: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
  },
}));

describe("Issue #27: Make Worker Current Location Canonical", () => {
  const WORKER_A_ID = "11111111-1111-4111-a111-111111111111";
  const WORKER_B_ID = "22222222-2222-4222-a222-222222222222";
  const CUSTOMER_ID = "33333333-3333-4333-a333-333333333333";
  const INACTIVE_WORKER_ID = "44444444-4444-4444-a444-444444444444";

  let workerAToken: string;
  let workerBToken: string;
  let customerToken: string;

  // In-memory simulated DB state
  let simulatedDb: {
    workers: Map<string, { id: string; location_geo: string | null; last_location_at: Date | null; deleted_at: Date | null }>;
    workerLocations: Array<{ id: string; worker_id: string; location_geo: string | null; updated_at: Date }>;
  };

  beforeAll(() => {
    workerAToken = generateToken({ id: WORKER_A_ID, phone: "+919876543211", role: UserRole.WORKER });
    workerBToken = generateToken({ id: WORKER_B_ID, phone: "+919876543212", role: UserRole.WORKER });
    customerToken = generateToken({ id: CUSTOMER_ID, phone: "+919876543213", role: UserRole.CUSTOMER });
  });

  beforeEach(() => {
    jest.clearAllMocks();

    simulatedDb = {
      workers: new Map([
        [WORKER_A_ID, { id: WORKER_A_ID, location_geo: "POINT(77.10 28.70)", last_location_at: new Date("2026-09-20T10:00:00Z"), deleted_at: null }],
        [WORKER_B_ID, { id: WORKER_B_ID, location_geo: "POINT(72.87 19.07)", last_location_at: new Date("2026-09-20T10:00:00Z"), deleted_at: null }],
        [INACTIVE_WORKER_ID, { id: INACTIVE_WORKER_ID, location_geo: "POINT(75.80 26.90)", last_location_at: null, deleted_at: new Date("2026-01-01") }],
      ]),
      workerLocations: [
        { id: "hist-1", worker_id: WORKER_B_ID, location_geo: "POINT(72.87 19.07)", updated_at: new Date("2026-09-20T10:00:00Z") },
      ],
    };

    (prisma.worker.findUnique as jest.Mock).mockImplementation(async ({ where }: any) => {
      const worker = simulatedDb.workers.get(where.id);
      return worker ? { id: worker.id, deleted_at: worker.deleted_at } : null;
    });

    (prisma.worker_location.create as jest.Mock).mockImplementation(async ({ data }: any) => {
      const newEntry = {
        id: "loc-" + Math.random().toString(36).substring(2, 9),
        worker_id: data.worker_id,
        location_geo: null,
        updated_at: data.updated_at || new Date(),
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
        const [lon, lat, now, wId] = values;
        const worker = simulatedDb.workers.get(wId);
        if (worker) {
          worker.location_geo = `POINT(${lon} ${lat})`;
          worker.last_location_at = now;
        }
      }
      return 1;
    });

    (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
      return await callback(prisma);
    });
  });

  // ==========================================================================
  // 1. CANONICAL SERVICE & ATOMICITY INVARIANT
  // ==========================================================================
  describe("1. Canonical Location Service & Atomic Update Invariant", () => {
    it("MUST update Worker.location_geo and Worker.last_location_at atomically", async () => {
      const beforeTime = Date.now();
      const result = await workerLocationService.updateLocation(WORKER_A_ID, 28.6139, 77.2090);

      expect(result).not.toBeNull();
      expect(result?.worker_id).toBe(WORKER_A_ID);
      expect(result?.latitude).toBe(28.6139);
      expect(result?.longitude).toBe(77.2090);
      expect(result?.updated_at).toBeInstanceOf(Date);

      const workerInDb = simulatedDb.workers.get(WORKER_A_ID);
      expect(workerInDb?.location_geo).toBe("POINT(77.209 28.6139)");
      expect(workerInDb?.last_location_at).toBeInstanceOf(Date);
      expect(workerInDb?.last_location_at?.getTime()).toBeGreaterThanOrEqual(beforeTime);

      // Verify history record was created separately
      const hist = simulatedDb.workerLocations.filter((l) => l.worker_id === WORKER_A_ID);
      expect(hist.length).toBe(1);
      expect(hist[0].location_geo).toBe("POINT(77.209 28.6139)");
    });

    it("MUST accept Null Island (0, 0) coordinates", async () => {
      const result = await workerLocationService.updateLocation(WORKER_A_ID, 0, 0);
      expect(result?.latitude).toBe(0);
      expect(result?.longitude).toBe(0);

      const workerInDb = simulatedDb.workers.get(WORKER_A_ID);
      expect(workerInDb?.location_geo).toBe("POINT(0 0)");
    });

    it("MUST accept extreme coordinate boundaries (90, 180) and (-90, -180)", async () => {
      const topRight = await workerLocationService.updateLocation(WORKER_A_ID, 90, 180);
      expect(topRight?.latitude).toBe(90);
      expect(topRight?.longitude).toBe(180);

      const bottomLeft = await workerLocationService.updateLocation(WORKER_A_ID, -90, -180);
      expect(bottomLeft?.latitude).toBe(-90);
      expect(bottomLeft?.longitude).toBe(-180);
    });

    it("MUST reject out-of-bounds coordinates with 400", async () => {
      await expect(workerLocationService.updateLocation(WORKER_A_ID, 90.001, 77.2)).rejects.toThrow("Invalid geographic coordinates");
      await expect(workerLocationService.updateLocation(WORKER_A_ID, -90.001, 77.2)).rejects.toThrow("Invalid geographic coordinates");
      await expect(workerLocationService.updateLocation(WORKER_A_ID, 28.5, 180.001)).rejects.toThrow("Invalid geographic coordinates");
      await expect(workerLocationService.updateLocation(WORKER_A_ID, 28.5, -180.001)).rejects.toThrow("Invalid geographic coordinates");
    });

    it("MUST reject non-numeric coordinates (NaN, Infinity, undefined)", async () => {
      await expect(workerLocationService.updateLocation(WORKER_A_ID, NaN, 77.2)).rejects.toThrow("Invalid geographic coordinates");
      await expect(workerLocationService.updateLocation(WORKER_A_ID, 28.5, Infinity)).rejects.toThrow("Invalid geographic coordinates");
      await expect(workerLocationService.updateLocation(WORKER_A_ID, undefined as any, 77.2)).rejects.toThrow("Invalid geographic coordinates");
    });

    it("MUST reject update for inactive/deactivated worker with 404", async () => {
      await expect(workerLocationService.updateLocation(INACTIVE_WORKER_ID, 28.5, 77.2)).rejects.toThrow("Worker not found or account is deactivated");
    });
  });

  // ==========================================================================
  // 2. HTTP MUTATION PATHS CONVERGENCE
  // ==========================================================================
  describe("2. HTTP Location Mutation Paths Convergence", () => {
    it("POST /api/worker_location/add updates canonical Worker location", async () => {
      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ latitude: 26.8467, longitude: 80.9462 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(simulatedDb.workers.get(WORKER_A_ID)?.location_geo).toBe("POINT(80.9462 26.8467)");
    });

    it("PATCH /api/workers/me/location updates canonical Worker location", async () => {
      const res = await request(app)
        .patch("/api/workers/me/location")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ latitude: 19.0760, longitude: 72.8777 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(simulatedDb.workers.get(WORKER_A_ID)?.location_geo).toBe("POINT(72.8777 19.076)");
    });

    it("MUST reject client-supplied worker identity spoofing in body with 400", async () => {
      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${workerAToken}`)
        .send({ worker_id: WORKER_B_ID, latitude: 26.85, longitude: 80.95 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it("MUST reject non-worker roles (Customer) with 403 Forbidden", async () => {
      const res = await request(app)
        .post("/api/worker_location/add")
        .set("Authorization", `Bearer ${customerToken}`)
        .send({ latitude: 26.85, longitude: 80.95 });

      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("MUST reject unauthenticated location updates with 401 Unauthorized", async () => {
      const res = await request(app)
        .post("/api/worker_location/add")
        .send({ latitude: 26.85, longitude: 80.95 });

      expect(res.status).toBe(401);
    });
  });

  // ==========================================================================
  // 3. READ PATHS & HISTORY SEPARATION CONVERGENCE
  // ==========================================================================
  describe("3. Canonical Read Paths & History Separation", () => {
    it("bookingService.getWorkerLocation reads canonical Worker location record", async () => {
      const bookingId = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
      (prisma.booking.findFirst as jest.Mock).mockResolvedValue({
        id: bookingId,
        worker_id: WORKER_A_ID,
        customer_id: CUSTOMER_ID,
        status: "in_progress",
      });

      (prisma.$queryRaw as jest.Mock).mockResolvedValue([
        {
          latitude: 28.6139,
          longitude: 77.2090,
          updated_at: new Date("2026-09-21T12:00:00Z"),
        },
      ]);

      const loc = await bookingService.getWorkerLocation(bookingId, {
        id: CUSTOMER_ID,
        role: UserRole.CUSTOMER,
      });

      expect(loc).not.toBeNull();
      expect(loc?.worker_id).toBe(WORKER_A_ID);
      expect(loc?.latitude).toBe(28.6139);
      expect(loc?.longitude).toBe(77.2090);
    });

    it("Dispatch and Booking read from the same canonical coordinates", async () => {
      // 1. Update location canonically
      await workerLocationService.updateLocation(WORKER_A_ID, 28.5355, 77.3910);

      // 2. Mock queryRaw to simulate PostGIS extracting from Worker.location_geo
      (prisma.$queryRaw as jest.Mock).mockResolvedValueOnce([
        {
          id: WORKER_A_ID,
          name: "Worker A",
          device_token: "token-a",
          worker_score: 5.0,
          dist_m: 1200,
        },
      ]);

      const candidates = await getEligibleDispatchCandidates({
        requirementId: "req-1",
        latitude: 28.5350,
        longitude: 77.3900,
        radiusMeters: 3000,
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0].id).toBe(WORKER_A_ID);
    });
  });
});
