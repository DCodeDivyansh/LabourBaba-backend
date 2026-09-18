import prisma from "../src/config/prisma";
import { findAvailableWorkers, dispatchJobSimple, JobForDispatch, RequirementForDispatch } from "../src/features/dispatch/simpleDispatch";
import { io } from "../src/server";

// Mock dependencies
jest.mock("../src/config/prisma", () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
    job_requirement: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    job_dispatch: {
      findMany: jest.fn(),
      createMany: jest.fn(),
      updateMany: jest.fn(),
    },
    booking: {
      findMany: jest.fn(),
    },
  },
}));

jest.mock("../src/shared/fcm", () => ({
  sendFCMNotification: jest.fn().mockResolvedValue({}),
}));

jest.mock("../src/server", () => ({
  io: {
    to: jest.fn().mockReturnValue({
      emit: jest.fn(),
    }),
  },
}));

/**
 * Standard Haversine geodesic distance formula (WGS 84 mean radius = 6,371,000m)
 * Matching PostGIS geography ST_Distance / ST_DWithin behavior.
 */
function calculateGeodesicDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // meters
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

interface MockWorkerRecord {
  id: string;
  name: string;
  device_token: string | null;
  is_online: boolean;
  deleted_at: Date | null;
  skill_type: string;
  lat: number | null;
  lon: number | null;
  activeBookingStatus?: string | null;
}

describe("P0 Finding #7 Security Regression Suite: Dispatch Radius Filtering", () => {
  const BASE_JOB_LAT = 12.9716; // Bengaluru
  const BASE_JOB_LON = 77.5946;

  let mockWorkers: MockWorkerRecord[];
  let lastCapturedQuery: { sql: string; values: any[] } | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    lastCapturedQuery = null;

    mockWorkers = [];

    // Implement realistic PostGIS candidate query simulation
    (prisma.$queryRaw as jest.Mock).mockImplementation(async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = strings.join("?");
      lastCapturedQuery = { sql, values };

      // Verify essential PostGIS predicates are structurally present in the raw SQL query
      expect(sql).toContain("ST_DWithin");
      expect(sql).toContain("ST_Distance");
      expect(sql).toContain("ST_MakePoint");
      expect(sql).toContain("w.location_geo IS NOT NULL");
      expect(sql).toContain("w.deleted_at IS NULL");
      expect(sql).toContain("ORDER BY dist_m ASC");

      // Extract query parameters: values are [job.longitude, job.latitude, job.longitude, job.latitude, radiusMeters, ...]
      const [jobLon1, jobLat1, jobLon2, jobLat2, radiusMeters] = values;
      expect(jobLon1).toBe(jobLon2);
      expect(jobLat1).toBe(jobLat2);

      // Filter workers according to exact PostGIS SQL clauses:
      const eligible = mockWorkers
        .filter((w) => {
          // 1. w.is_online = true
          if (!w.is_online) return false;
          // 2. w.deleted_at IS NULL
          if (w.deleted_at !== null) return false;
          // 3. w.location_geo IS NOT NULL
          if (w.lat === null || w.lon === null) return false;
          // 4. NOT EXISTS active booking
          if (w.activeBookingStatus && ["confirmed", "in_progress"].includes(w.activeBookingStatus)) return false;

          // 5. ST_DWithin(w.location_geo, ST_MakePoint(jobLon, jobLat)::geography, radiusMeters)
          const dist_m = calculateGeodesicDistanceMeters(jobLat1, jobLon1, w.lat, w.lon);
          // ST_DWithin is inclusive (dist <= radius)
          return dist_m <= radiusMeters;
        })
        .map((w) => {
          const dist_m = calculateGeodesicDistanceMeters(jobLat1, jobLon1, w.lat!, w.lon!);
          return {
            id: w.id,
            device_token: w.device_token,
            dist_m,
          };
        })
        .sort((a, b) => a.dist_m - b.dist_m);

      return eligible;
    });

    (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(prisma));
    (prisma.job_dispatch.createMany as jest.Mock).mockResolvedValue({ count: 1 });
  });

  describe("1. Inside Radius Verification (2.9 km vs 3.0 km)", () => {
    it("MUST include worker located at ~2.9 km for a 3.0 km dispatch wave", async () => {
      // Offset ~2,900 meters north (1 deg lat ~= 111,139 m -> 2,900m ~= 0.02609 deg)
      const workerLat = BASE_JOB_LAT + 0.02609;
      const workerLon = BASE_JOB_LON;

      mockWorkers = [
        {
          id: "worker-2900m",
          name: "Ramesh",
          device_token: "token-2900m",
          is_online: true,
          deleted_at: null,
          skill_type: "Plumbing",
          lat: workerLat,
          lon: workerLon,
        },
      ];

      const job: JobForDispatch = { id: "job-1", customer_id: "cust-1", latitude: BASE_JOB_LAT, longitude: BASE_JOB_LON };
      const req: RequirementForDispatch = { id: "req-1", skill_type: "Plumbing", workers_needed: 1 };

      const result = await findAvailableWorkers(job, req, 3000);

      expect(result.length).toBe(1);
      expect(result[0].id).toBe("worker-2900m");
      expect(result[0].dist_m).toBeLessThanOrEqual(3000);
      expect(result[0].dist_m).toBeCloseTo(2900, -2);
    });
  });

  describe("2. Exact Boundary Verification (3.0 km vs 3.0 km)", () => {
    it("MUST include worker located exactly at 3.0 km boundary (ST_DWithin is inclusive <=)", async () => {
      // Offset ~3,000 meters north
      const workerLat = BASE_JOB_LAT + 0.02699;
      const workerLon = BASE_JOB_LON;

      const exactDist = calculateGeodesicDistanceMeters(BASE_JOB_LAT, BASE_JOB_LON, workerLat, workerLon);

      mockWorkers = [
        {
          id: "worker-3000m",
          name: "Suresh",
          device_token: "token-3000m",
          is_online: true,
          deleted_at: null,
          skill_type: "Plumbing",
          lat: workerLat,
          lon: workerLon,
        },
      ];

      const job: JobForDispatch = { id: "job-1", customer_id: "cust-1", latitude: BASE_JOB_LAT, longitude: BASE_JOB_LON };
      const req: RequirementForDispatch = { id: "req-1", skill_type: "Plumbing", workers_needed: 1 };

      // Pass the exact distance as radius
      const result = await findAvailableWorkers(job, req, exactDist);

      expect(result.length).toBe(1);
      expect(result[0].id).toBe("worker-3000m");
      expect(result[0].dist_m).toBeLessThanOrEqual(exactDist);
    });
  });

  describe("3. Just Outside Radius Verification (3.1 km vs 3.0 km)", () => {
    it("MUST strictly EXCLUDE worker located at ~3.1 km for a 3.0 km dispatch wave", async () => {
      // Offset ~3,100 meters north
      const workerLat = BASE_JOB_LAT + 0.02789;
      const workerLon = BASE_JOB_LON;

      mockWorkers = [
        {
          id: "worker-3100m",
          name: "Mahesh",
          device_token: "token-3100m",
          is_online: true,
          deleted_at: null,
          skill_type: "Plumbing",
          lat: workerLat,
          lon: workerLon,
        },
      ];

      const job: JobForDispatch = { id: "job-1", customer_id: "cust-1", latitude: BASE_JOB_LAT, longitude: BASE_JOB_LON };
      const req: RequirementForDispatch = { id: "req-1", skill_type: "Plumbing", workers_needed: 1 };

      const result = await findAvailableWorkers(job, req, 3000);

      // Must be strictly excluded!
      expect(result.length).toBe(0);
    });
  });

  describe("4. Significantly Outside Radius Verification (10+ km vs 3.0 km)", () => {
    it("MUST strictly EXCLUDE worker located at 10+ km for a 3.0 km dispatch wave", async () => {
      const workerLat = BASE_JOB_LAT + 0.1; // ~11 km north
      const workerLon = BASE_JOB_LON;

      mockWorkers = [
        {
          id: "worker-10km",
          name: "FarWorker",
          device_token: "token-10km",
          is_online: true,
          deleted_at: null,
          skill_type: "Plumbing",
          lat: workerLat,
          lon: workerLon,
        },
      ];

      const job: JobForDispatch = { id: "job-1", customer_id: "cust-1", latitude: BASE_JOB_LAT, longitude: BASE_JOB_LON };
      const req: RequirementForDispatch = { id: "req-1", skill_type: "Plumbing", workers_needed: 1 };

      const result = await findAvailableWorkers(job, req, 3000);
      expect(result.length).toBe(0);
    });
  });

  describe("5. Missing Worker Coordinates Verification", () => {
    it("MUST strictly EXCLUDE worker with NULL location_geo from the candidate pool", async () => {
      mockWorkers = [
        {
          id: "worker-no-geo",
          name: "NoGeoWorker",
          device_token: "token-no-geo",
          is_online: true,
          deleted_at: null,
          skill_type: "Plumbing",
          lat: null,
          lon: null,
        },
      ];

      const job: JobForDispatch = { id: "job-1", customer_id: "cust-1", latitude: BASE_JOB_LAT, longitude: BASE_JOB_LON };
      const req: RequirementForDispatch = { id: "req-1", skill_type: "Plumbing", workers_needed: 1 };

      const result = await findAvailableWorkers(job, req, 3000);
      expect(result.length).toBe(0);
    });
  });

  describe("6. Missing Job Coordinates & Safe Failover", () => {
    it("MUST immediately fail safe without querying or notifying workers when job coordinates are missing", async () => {
      const job: JobForDispatch = { id: "job-null-coords", customer_id: "cust-1", latitude: null, longitude: null };
      const req: RequirementForDispatch = { id: "req-null-coords", skill_type: "Plumbing" };

      await dispatchJobSimple(job, [req]);

      // Verify requirement is marked 'no_workers_available'
      expect(prisma.job_requirement.update).toHaveBeenCalledWith({
        where: { id: "req-null-coords" },
        data: { status: "no_workers_available" },
      });

      // Verify no spatial query was executed
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      // Verify no dispatches were created
      expect(prisma.job_dispatch.createMany).not.toHaveBeenCalled();
    });

    it("returns empty candidate array if job has invalid non-finite coordinates", async () => {
      const job: JobForDispatch = { id: "job-bad", customer_id: "cust-1", latitude: NaN, longitude: Infinity };
      const req: RequirementForDispatch = { id: "req-bad", skill_type: "Plumbing" };

      const result = await findAvailableWorkers(job, req, 3000);
      expect(result).toEqual([]);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe("7. Zero-Coordinate Handling (0, 0)", () => {
    it("MUST treat latitude 0 and longitude 0 as valid geographic coordinates", async () => {
      const zeroLat = 0;
      const zeroLon = 0;

      // Worker ~1,000m away from (0, 0)
      const workerLat = 0.00898;
      const workerLon = 0;

      mockWorkers = [
        {
          id: "worker-zero-island",
          name: "NullIslandWorker",
          device_token: "token-zero",
          is_online: true,
          deleted_at: null,
          skill_type: "Plumbing",
          lat: workerLat,
          lon: workerLon,
        },
      ];

      const job: JobForDispatch = { id: "job-zero", customer_id: "cust-1", latitude: zeroLat, longitude: zeroLon };
      const req: RequirementForDispatch = { id: "req-zero", skill_type: "Plumbing", workers_needed: 1 };

      const result = await findAvailableWorkers(job, req, 3000);
      expect(result.length).toBe(1);
      expect(result[0].id).toBe("worker-zero-island");
      expect(result[0].dist_m).toBeCloseTo(1000, -2);
    });
  });

  describe("8. Multi-Worker Candidate Set & Ordering", () => {
    it("correctly filters multiple workers at different distances and orders nearest-first", async () => {
      // Create workers:
      // Worker A = ~1.0 km
      // Worker B = ~2.9 km
      // Worker C = ~3.0 km
      // Worker D = ~3.1 km
      // Worker E = ~10.0 km
      mockWorkers = [
        {
          id: "worker-E-10km",
          name: "E",
          device_token: "token-e",
          is_online: true,
          deleted_at: null,
          skill_type: "Carpentry",
          lat: BASE_JOB_LAT + 0.09, // ~10 km
          lon: BASE_JOB_LON,
        },
        {
          id: "worker-B-2900m",
          name: "B",
          device_token: "token-b",
          is_online: true,
          deleted_at: null,
          skill_type: "Carpentry",
          lat: BASE_JOB_LAT + 0.02609, // ~2.9 km
          lon: BASE_JOB_LON,
        },
        {
          id: "worker-D-3100m",
          name: "D",
          device_token: "token-d",
          is_online: true,
          deleted_at: null,
          skill_type: "Carpentry",
          lat: BASE_JOB_LAT + 0.02789, // ~3.1 km
          lon: BASE_JOB_LON,
        },
        {
          id: "worker-A-1000m",
          name: "A",
          device_token: "token-a",
          is_online: true,
          deleted_at: null,
          skill_type: "Carpentry",
          lat: BASE_JOB_LAT + 0.00898, // ~1.0 km
          lon: BASE_JOB_LON,
        },
        {
          id: "worker-C-3000m",
          name: "C",
          device_token: "token-c",
          is_online: true,
          deleted_at: null,
          skill_type: "Carpentry",
          lat: BASE_JOB_LAT + 0.02695, // ~2.99 km (safely <= 3.0 km)
          lon: BASE_JOB_LON,
        },
      ];

      const job: JobForDispatch = { id: "job-multi", customer_id: "cust-1", latitude: BASE_JOB_LAT, longitude: BASE_JOB_LON };
      const req: RequirementForDispatch = { id: "req-multi", skill_type: "Carpentry", workers_needed: 5 };

      // Query for Wave 1 (3,000m)
      const result = await findAvailableWorkers(job, req, 3000);

      // Must include only A, B, C; D and E are excluded
      expect(result.map((w) => w.id)).toEqual(["worker-A-1000m", "worker-B-2900m", "worker-C-3000m"]);
      // Nearest first
      expect(result[0].dist_m).toBeLessThan(result[1].dist_m);
      expect(result[1].dist_m).toBeLessThan(result[2].dist_m);
    });
  });

  describe("9. Wave Radius Escalation", () => {
    it("progressively expands candidate eligibility across configured wave radii (3km, 5km, 10km, 15km)", async () => {
      mockWorkers = [
        { id: "w-2km", name: "W1", device_token: "t1", is_online: true, deleted_at: null, skill_type: "Electrician", lat: BASE_JOB_LAT + 0.018, lon: BASE_JOB_LON }, // ~2 km
        { id: "w-4km", name: "W2", device_token: "t2", is_online: true, deleted_at: null, skill_type: "Electrician", lat: BASE_JOB_LAT + 0.036, lon: BASE_JOB_LON }, // ~4 km
        { id: "w-7km", name: "W3", device_token: "t3", is_online: true, deleted_at: null, skill_type: "Electrician", lat: BASE_JOB_LAT + 0.063, lon: BASE_JOB_LON }, // ~7 km
        { id: "w-12km", name: "W4", device_token: "t4", is_online: true, deleted_at: null, skill_type: "Electrician", lat: BASE_JOB_LAT + 0.108, lon: BASE_JOB_LON }, // ~12 km
      ];

      const job: JobForDispatch = { id: "job-wave", customer_id: "cust-1", latitude: BASE_JOB_LAT, longitude: BASE_JOB_LON };
      const req: RequirementForDispatch = { id: "req-wave", skill_type: "Electrician", workers_needed: 10 };

      // Wave 1: 3,000m
      const wave1 = await findAvailableWorkers(job, req, 3000);
      expect(wave1.map((w) => w.id)).toEqual(["w-2km"]);

      // Wave 2: 5,000m
      const wave2 = await findAvailableWorkers(job, req, 5000);
      expect(wave2.map((w) => w.id)).toEqual(["w-2km", "w-4km"]);

      // Wave 3: 10,000m
      const wave3 = await findAvailableWorkers(job, req, 10000);
      expect(wave3.map((w) => w.id)).toEqual(["w-2km", "w-4km", "w-7km"]);

      // Wave 4: 15,000m
      const wave4 = await findAvailableWorkers(job, req, 15000);
      expect(wave4.map((w) => w.id)).toEqual(["w-2km", "w-4km", "w-7km", "w-12km"]);
    });
  });

  describe("10. Deactivated Worker Exclusion", () => {
    it("MUST exclude worker inside radius if soft-deleted (deleted_at != null)", async () => {
      mockWorkers = [
        {
          id: "worker-deleted",
          name: "Deactivated",
          device_token: "token-deleted",
          is_online: true,
          deleted_at: new Date("2026-01-01"),
          skill_type: "Plumbing",
          lat: BASE_JOB_LAT + 0.005, // ~500m away
          lon: BASE_JOB_LON,
        },
      ];

      const job: JobForDispatch = { id: "job-1", customer_id: "cust-1", latitude: BASE_JOB_LAT, longitude: BASE_JOB_LON };
      const req: RequirementForDispatch = { id: "req-1", skill_type: "Plumbing", workers_needed: 1 };

      const result = await findAvailableWorkers(job, req, 3000);
      expect(result.length).toBe(0);
    });
  });

  describe("11. Active Booking Worker Exclusion", () => {
    it("MUST exclude worker inside radius who already has an active confirmed or in_progress booking", async () => {
      mockWorkers = [
        {
          id: "worker-busy-confirmed",
          name: "BusyConfirmed",
          device_token: "token-c",
          is_online: true,
          deleted_at: null,
          skill_type: "Plumbing",
          lat: BASE_JOB_LAT + 0.005,
          lon: BASE_JOB_LON,
          activeBookingStatus: "confirmed",
        },
        {
          id: "worker-busy-inprogress",
          name: "BusyInProgress",
          device_token: "token-p",
          is_online: true,
          deleted_at: null,
          skill_type: "Plumbing",
          lat: BASE_JOB_LAT + 0.006,
          lon: BASE_JOB_LON,
          activeBookingStatus: "in_progress",
        },
        {
          id: "worker-free",
          name: "FreeWorker",
          device_token: "token-f",
          is_online: true,
          deleted_at: null,
          skill_type: "Plumbing",
          lat: BASE_JOB_LAT + 0.007,
          lon: BASE_JOB_LON,
          activeBookingStatus: null,
        },
      ];

      const job: JobForDispatch = { id: "job-1", customer_id: "cust-1", latitude: BASE_JOB_LAT, longitude: BASE_JOB_LON };
      const req: RequirementForDispatch = { id: "req-1", skill_type: "Plumbing", workers_needed: 3 };

      const result = await findAvailableWorkers(job, req, 3000);
      expect(result.map((w) => w.id)).toEqual(["worker-free"]);
    });
  });

  describe("12. SQL Parameterization and Security Verification", () => {
    it("MUST use parameterized Prisma template tag to bind coordinates and radius", async () => {
      const job: JobForDispatch = { id: "job-sql", customer_id: "cust-1", latitude: 12.9716, longitude: 77.5946 };
      const req: RequirementForDispatch = { id: "req-sql", skill_type: "Plumbing", workers_needed: 2 };

      await findAvailableWorkers(job, req, 3000);

      expect(lastCapturedQuery).not.toBeNull();
      // Ensure values array contains parameters rather than string concatenation
      expect(lastCapturedQuery!.values).toContain(77.5946);
      expect(lastCapturedQuery!.values).toContain(12.9716);
      expect(lastCapturedQuery!.values).toContain(3000);
      expect(lastCapturedQuery!.values).toContain("req-sql");
    });
  });
});
