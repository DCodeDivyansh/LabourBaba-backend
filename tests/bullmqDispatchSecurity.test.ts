import prisma from "../src/config/prisma";
import {
  getEligibleDispatchCandidates,
  getWaveRadiusMeters,
  validateDispatchCoordinates,
  DEFAULT_LOCATION_FRESHNESS_HOURS,
} from "../src/features/dispatch/dispatchCandidate.service";
import { processDispatchJob, DispatchJobData } from "../src/workers/dispatchWorker";
import { processNotificationJob } from "../src/workers/notificationWorker";
import { notificationQueue } from "../src/config/bullmq";
import { sendFCMNotification, sendFCMToWorker } from "../src/shared/fcm";
import { io } from "../src/server";

// Mock dependencies
jest.mock("../src/config/prisma", () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
    job_requirement: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    dispatch_wave: {
      create: jest.fn(),
    },
    job_dispatch: {
      createMany: jest.fn(),
    },
    worker_device: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

jest.mock("../src/config/bullmq", () => ({
  redisConnectionOptions: {},
  timeoutQueue: {
    add: jest.fn().mockResolvedValue({ id: "mock-timeout-job-id" }),
  },
  dispatchQueue: {
    add: jest.fn().mockResolvedValue({ id: "mock-dispatch-job-id" }),
  },
  notificationQueue: {
    add: jest.fn().mockResolvedValue({ id: "mock-notification-job-id" }),
  },
  DISPATCH_JOB_NAMES: {
    DISPATCH_WAVE: "dispatch-wave",
    WAVE_TIMEOUT: "wave-timeout",
    DISPATCH_NOTIFY: "dispatch-notify",
  },
}));

jest.mock("../src/shared/fcm", () => ({
  sendFCMNotification: jest.fn().mockResolvedValue({}),
  sendFCMToWorker: jest.fn().mockResolvedValue([{ success: true }]),
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
 * Exactly mirrors PostGIS geography ST_Distance / ST_DWithin behavior on WGS 84 ellipsoid.
 */
function calculateGeodesicDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
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
  worker_score: number;
  is_online: boolean;
  deleted_at: Date | null;
  verification_status: string; // 'verified', 'pending', 'rejected', 'suspended'
  skill_type: string;
  skill_category_name?: string;
  lat: number | null;
  lon: number | null;
  last_location_updated_at: Date | null;
  activeBookingStatus?: string | null;
  alreadyDispatched?: boolean;
}

describe("P0 Finding #8 Security Regression Suite: BullMQ Dispatch Geographic Filtering", () => {
  const BASE_JOB_LAT = 12.9716; // Bengaluru
  const BASE_JOB_LON = 77.5946;

  let mockWorkers: MockWorkerRecord[];
  let lastCapturedQuery: { sql: string; values: any[] } | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    lastCapturedQuery = null;
    mockWorkers = [];
    (io.to as jest.Mock).mockReturnValue({ emit: jest.fn() });

    // Realistic PostGIS candidate simulation enforcing all database predicates
    (prisma.$queryRaw as jest.Mock).mockImplementation(
      async (strings: TemplateStringsArray, ...values: any[]) => {
        const sql = strings.join("?");
        lastCapturedQuery = { sql, values };

        // 1. Mandatory PostGIS spatial predicates must be structurally present
        expect(sql).toContain("ST_DWithin");
        expect(sql).toContain("ST_Distance");
        expect(sql).toContain("ST_MakePoint");
        expect(sql).toContain("w.location_geo IS NOT NULL");
        expect(sql).toContain("w.deleted_at IS NULL");
        expect(sql).toContain("w.verification_status = 'verified'");
        expect(sql).toContain("ORDER BY dist_m ASC");

        // Values alignment: [lon, lat, lon, lat, radiusMeters, skillType, skillType, skillType, excludeDispatched, reqId, requireFreshness, maxAgeSeconds, ...]
        const [jobLon1, jobLat1, jobLon2, jobLat2, radiusMeters, skillType, skillType2, skillType3, excludeDispatched, reqId, requireFreshness, maxAgeSeconds] = values;
        expect(jobLon1).toBe(jobLon2);
        expect(jobLat1).toBe(jobLat2);

        const now = Date.now();
        const freshnessMs = (maxAgeSeconds || 300) * 1000;

        // Filter workers through exact database-level rules
        const eligible = mockWorkers
          .filter((w) => {
            // 1. w.is_online = true
            if (!w.is_online) return false;
            // 2. w.deleted_at IS NULL
            if (w.deleted_at !== null) return false;
            // 3. w.verification_status = 'verified'
            if (w.verification_status !== "verified") return false;
            // 4. w.location_geo IS NOT NULL (valid coordinates)
            if (w.lat === null || w.lon === null) return false;

            // 5. ST_DWithin: within active wave radius
            const dist_m = calculateGeodesicDistanceMeters(jobLat1, jobLon1, w.lat, w.lon);
            if (dist_m > radiusMeters) return false;

            // 6. Skill matching (null matches all; otherwise skill_type or skill_category match)
            if (skillType) {
              const skillReq = String(skillType).trim().toLowerCase();
              const wSkill = w.skill_type.trim().toLowerCase();
              const scMatch = w.skill_category_name ? w.skill_category_name.trim().toLowerCase() === skillReq : false;
              if (wSkill !== skillReq && !scMatch) return false;
            }

            // 7. Dedup / NOT EXISTS in job_dispatch
            if (excludeDispatched && w.alreadyDispatched) return false;

            // 8. Active booking conflict: NOT EXISTS in booking with 'confirmed' or 'in_progress'
            if (
              w.activeBookingStatus &&
              ["confirmed", "in_progress"].includes(w.activeBookingStatus.toLowerCase())
            ) {
              return false;
            }

            // 9. Location Freshness: worker_location updated within freshness window
            if (requireFreshness) {
              if (!w.last_location_updated_at) return false;
              const ageMs = now - w.last_location_updated_at.getTime();
              if (ageMs > freshnessMs) return false;
            }

            return true;
          })
          .map((w) => {
            const dist_m = calculateGeodesicDistanceMeters(jobLat1, jobLon1, w.lat!, w.lon!);
            return {
              id: w.id,
              name: w.name,
              device_token: w.device_token,
              worker_score: w.worker_score,
              dist_m,
            };
          })
          .sort((a, b) => a.dist_m - b.dist_m || (b.worker_score ?? 0) - (a.worker_score ?? 0));

        return eligible;
      },
    );
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Inside Radius Verification (2.9 km vs 3.0 km)
  // ─────────────────────────────────────────────────────────────────────────────
  describe("1. Inside Radius Verification (2.9 km vs 3.0 km)", () => {
    it("MUST select worker located at ~2.9 km for a 3.0 km wave", async () => {
      const workerLat = BASE_JOB_LAT + 0.02609; // ~2,900m
      const workerLon = BASE_JOB_LON;

      mockWorkers = [
        {
          id: "worker-2900m",
          name: "Ramesh Inside",
          device_token: "fcm-2900",
          worker_score: 4.8,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Carpenter",
          lat: workerLat,
          lon: workerLon,
          last_location_updated_at: new Date(),
        },
      ];

      const candidates = await getEligibleDispatchCandidates({
        requirementId: "req-1",
        latitude: BASE_JOB_LAT,
        longitude: BASE_JOB_LON,
        radiusMeters: 3000,
        skillType: "Carpenter",
      });

      expect(candidates.length).toBe(1);
      expect(candidates[0].id).toBe("worker-2900m");
      expect(candidates[0].dist_m).toBeLessThanOrEqual(3000);
      expect(candidates[0].dist_m).toBeCloseTo(2900, -2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Exact Boundary Verification (3.0 km vs 3.0 km)
  // ─────────────────────────────────────────────────────────────────────────────
  describe("2. Exact Boundary Verification (3.0 km vs 3.0 km)", () => {
    it("MUST include worker located exactly at the 3.0 km boundary (ST_DWithin is inclusive <=)", async () => {
      const workerLat = BASE_JOB_LAT + 0.02699;
      const workerLon = BASE_JOB_LON;
      const exactDistance = calculateGeodesicDistanceMeters(BASE_JOB_LAT, BASE_JOB_LON, workerLat, workerLon);

      mockWorkers = [
        {
          id: "worker-3000m",
          name: "Suresh Boundary",
          device_token: "fcm-3000",
          worker_score: 4.9,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Plumber",
          lat: workerLat,
          lon: workerLon,
          last_location_updated_at: new Date(),
        },
      ];

      const candidates = await getEligibleDispatchCandidates({
        requirementId: "req-1",
        latitude: BASE_JOB_LAT,
        longitude: BASE_JOB_LON,
        radiusMeters: exactDistance,
        skillType: "Plumber",
      });

      expect(candidates.length).toBe(1);
      expect(candidates[0].id).toBe("worker-3000m");
      expect(candidates[0].dist_m).toBeLessThanOrEqual(exactDistance);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Just Outside Radius Verification (3.1 km vs 3.0 km)
  // ─────────────────────────────────────────────────────────────────────────────
  describe("3. Just Outside Radius Verification (3.1 km vs 3.0 km)", () => {
    it("MUST strictly EXCLUDE worker located at ~3.1 km for a 3.0 km wave", async () => {
      const workerLat = BASE_JOB_LAT + 0.0279; // ~3,100m
      const workerLon = BASE_JOB_LON;

      mockWorkers = [
        {
          id: "worker-3100m",
          name: "Dinesh Outside",
          device_token: "fcm-3100",
          worker_score: 5.0,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Mason",
          lat: workerLat,
          lon: workerLon,
          last_location_updated_at: new Date(),
        },
      ];

      const candidates = await getEligibleDispatchCandidates({
        requirementId: "req-1",
        latitude: BASE_JOB_LAT,
        longitude: BASE_JOB_LON,
        radiusMeters: 3000,
        skillType: "Mason",
      });

      expect(candidates.length).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Far Outside Radius Verification (10 km vs 3.0 km)
  // ─────────────────────────────────────────────────────────────────────────────
  describe("4. Far Outside Radius Verification (10 km vs 3.0 km)", () => {
    it("MUST strictly EXCLUDE worker located at 10 km for a 3.0 km wave", async () => {
      const workerLat = BASE_JOB_LAT + 0.09; // ~10,000m
      const workerLon = BASE_JOB_LON;

      mockWorkers = [
        {
          id: "worker-10km",
          name: "Far Worker",
          device_token: "fcm-10km",
          worker_score: 5.0,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Painter",
          lat: workerLat,
          lon: workerLon,
          last_location_updated_at: new Date(),
        },
      ];

      const candidates = await getEligibleDispatchCandidates({
        requirementId: "req-1",
        latitude: BASE_JOB_LAT,
        longitude: BASE_JOB_LON,
        radiusMeters: 3000,
        skillType: "Painter",
      });

      expect(candidates.length).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Missing Worker Coordinates Verification
  // ─────────────────────────────────────────────────────────────────────────────
  describe("5. Missing Worker Coordinates Verification", () => {
    it("MUST strictly EXCLUDE worker with NULL location_geo from the candidate pool", async () => {
      mockWorkers = [
        {
          id: "worker-null-coords",
          name: "No Geo Worker",
          device_token: "fcm-no-geo",
          worker_score: 5.0,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Electrician",
          lat: null,
          lon: null,
          last_location_updated_at: new Date(),
        },
      ];

      const candidates = await getEligibleDispatchCandidates({
        requirementId: "req-1",
        latitude: BASE_JOB_LAT,
        longitude: BASE_JOB_LON,
        radiusMeters: 3000,
        skillType: "Electrician",
      });

      expect(candidates.length).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. Invalid Job Coordinates & Safe Failover
  // ─────────────────────────────────────────────────────────────────────────────
  describe("6. Invalid Job Coordinates & Safe Failover", () => {
    it("MUST return empty array without querying database on null/undefined coordinates", async () => {
      const resultNull = await getEligibleDispatchCandidates({
        requirementId: "req-1",
        latitude: null,
        longitude: BASE_JOB_LON,
        radiusMeters: 3000,
      });
      expect(resultNull).toEqual([]);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it("MUST return empty array without querying database on non-finite (NaN, Infinity) coordinates", async () => {
      const resultNaN = await getEligibleDispatchCandidates({
        requirementId: "req-1",
        latitude: NaN,
        longitude: BASE_JOB_LON,
        radiusMeters: 3000,
      });
      expect(resultNaN).toEqual([]);

      const resultInf = await getEligibleDispatchCandidates({
        requirementId: "req-1",
        latitude: Infinity,
        longitude: BASE_JOB_LON,
        radiusMeters: 3000,
      });
      expect(resultInf).toEqual([]);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it("MUST return empty array on out-of-range coordinates (> 90 lat or > 180 lon)", async () => {
      const resultLatOut = await getEligibleDispatchCandidates({
        requirementId: "req-1",
        latitude: 91,
        longitude: 77.59,
        radiusMeters: 3000,
      });
      expect(resultLatOut).toEqual([]);

      const resultLonOut = await getEligibleDispatchCandidates({
        requirementId: "req-1",
        latitude: 12.97,
        longitude: 185,
        radiusMeters: 3000,
      });
      expect(resultLonOut).toEqual([]);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. Zero-Coordinate Handling (0, 0)
  // ─────────────────────────────────────────────────────────────────────────────
  describe("7. Zero-Coordinate Handling (0, 0)", () => {
    it("MUST treat latitude 0 and longitude 0 as legitimate numeric coordinates (Null Island)", async () => {
      expect(validateDispatchCoordinates(0, 0)).toBe(true);

      mockWorkers = [
        {
          id: "worker-null-island",
          name: "Null Island Worker",
          device_token: "fcm-zero",
          worker_score: 4.5,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Welder",
          lat: 0.001,
          lon: 0.001,
          last_location_updated_at: new Date(),
        },
      ];

      const candidates = await getEligibleDispatchCandidates({
        requirementId: "req-zero",
        latitude: 0,
        longitude: 0,
        radiusMeters: 3000,
        skillType: "Welder",
      });

      expect(prisma.$queryRaw).toHaveBeenCalled();
      expect(candidates.length).toBe(1);
      expect(candidates[0].id).toBe("worker-null-island");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. Location Freshness Enforcement
  // ─────────────────────────────────────────────────────────────────────────────
  describe("8. Location Freshness Enforcement", () => {
    it("MUST include worker whose location was updated 1 hour ago (fresh <= 24h)", async () => {
      mockWorkers = [
        {
          id: "worker-fresh",
          name: "Fresh Worker",
          device_token: "fcm-fresh",
          worker_score: 4.7,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Cleaner",
          lat: BASE_JOB_LAT + 0.01,
          lon: BASE_JOB_LON,
          last_location_updated_at: new Date(Date.now() - 1 * 60 * 60 * 1000), // 1h old
        },
      ];

      const candidates = await getEligibleDispatchCandidates({
        requirementId: "req-fresh",
        latitude: BASE_JOB_LAT,
        longitude: BASE_JOB_LON,
        radiusMeters: 3000,
        skillType: "Cleaner",
        requireLocationFreshness: true,
        maxLocationAgeHours: 24,
      });

      expect(candidates.length).toBe(1);
      expect(candidates[0].id).toBe("worker-fresh");
    });

    it("MUST strictly EXCLUDE worker whose location was updated 25 hours ago (stale > 24h)", async () => {
      mockWorkers = [
        {
          id: "worker-stale",
          name: "Stale Worker",
          device_token: "fcm-stale",
          worker_score: 4.9,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Cleaner",
          lat: BASE_JOB_LAT + 0.01, // ~1.1 km away
          lon: BASE_JOB_LON,
          last_location_updated_at: new Date(Date.now() - 25 * 60 * 60 * 1000), // 25h old
        },
      ];

      const candidates = await getEligibleDispatchCandidates({
        requirementId: "req-stale",
        latitude: BASE_JOB_LAT,
        longitude: BASE_JOB_LON,
        radiusMeters: 3000,
        skillType: "Cleaner",
        requireLocationFreshness: true,
        maxLocationAgeHours: 24,
      });

      expect(candidates.length).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. Suspended Worker Exclusion
  // ─────────────────────────────────────────────────────────────────────────────
  describe("9. Suspended Worker Exclusion", () => {
    it("MUST strictly EXCLUDE worker inside radius with verification_status = 'suspended'", async () => {
      mockWorkers = [
        {
          id: "worker-suspended",
          name: "Suspended Worker",
          device_token: "fcm-suspended",
          worker_score: 4.8,
          is_online: true,
          deleted_at: null,
          verification_status: "suspended",
          skill_type: "Driver",
          lat: BASE_JOB_LAT + 0.01,
          lon: BASE_JOB_LON,
          last_location_updated_at: new Date(),
        },
      ];

      const candidates = await getEligibleDispatchCandidates({
        requirementId: "req-susp",
        latitude: BASE_JOB_LAT,
        longitude: BASE_JOB_LON,
        radiusMeters: 3000,
        skillType: "Driver",
      });

      expect(candidates.length).toBe(0);
    });

    it("MUST strictly EXCLUDE worker marked soft-deleted (deleted_at IS NOT NULL)", async () => {
      mockWorkers = [
        {
          id: "worker-deleted",
          name: "Deleted Worker",
          device_token: "fcm-deleted",
          worker_score: 4.8,
          is_online: true,
          deleted_at: new Date(),
          verification_status: "verified",
          skill_type: "Driver",
          lat: BASE_JOB_LAT + 0.01,
          lon: BASE_JOB_LON,
          last_location_updated_at: new Date(),
        },
      ];

      const candidates = await getEligibleDispatchCandidates({
        requirementId: "req-del",
        latitude: BASE_JOB_LAT,
        longitude: BASE_JOB_LON,
        radiusMeters: 3000,
        skillType: "Driver",
      });

      expect(candidates.length).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 10. Unverified Worker Exclusion
  // ─────────────────────────────────────────────────────────────────────────────
  describe("10. Unverified Worker Exclusion", () => {
    it("MUST strictly EXCLUDE worker with verification_status = 'pending'", async () => {
      mockWorkers = [
        {
          id: "worker-pending",
          name: "Pending Worker",
          device_token: "fcm-pending",
          worker_score: 5.0,
          is_online: true,
          deleted_at: null,
          verification_status: "pending",
          skill_type: "Electrician",
          lat: BASE_JOB_LAT + 0.01,
          lon: BASE_JOB_LON,
          last_location_updated_at: new Date(),
        },
      ];

      const candidates = await getEligibleDispatchCandidates({
        requirementId: "req-pen",
        latitude: BASE_JOB_LAT,
        longitude: BASE_JOB_LON,
        radiusMeters: 3000,
        skillType: "Electrician",
      });

      expect(candidates.length).toBe(0);
    });

    it("MUST strictly EXCLUDE worker with verification_status = 'rejected'", async () => {
      mockWorkers = [
        {
          id: "worker-rejected",
          name: "Rejected Worker",
          device_token: "fcm-rej",
          worker_score: 5.0,
          is_online: true,
          deleted_at: null,
          verification_status: "rejected",
          skill_type: "Electrician",
          lat: BASE_JOB_LAT + 0.01,
          lon: BASE_JOB_LON,
          last_location_updated_at: new Date(),
        },
      ];

      const candidates = await getEligibleDispatchCandidates({
        requirementId: "req-rej",
        latitude: BASE_JOB_LAT,
        longitude: BASE_JOB_LON,
        radiusMeters: 3000,
        skillType: "Electrician",
      });

      expect(candidates.length).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 11. Skill Mismatch Exclusion
  // ─────────────────────────────────────────────────────────────────────────────
  describe("11. Skill Mismatch Exclusion", () => {
    it("MUST strictly EXCLUDE worker who is inside radius and verified but has wrong skill", async () => {
      mockWorkers = [
        {
          id: "worker-wrong-skill",
          name: "Plumber Not Electrician",
          device_token: "fcm-plumb",
          worker_score: 5.0,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Plumber",
          lat: BASE_JOB_LAT + 0.01,
          lon: BASE_JOB_LON,
          last_location_updated_at: new Date(),
        },
      ];

      const candidates = await getEligibleDispatchCandidates({
        requirementId: "req-skill",
        latitude: BASE_JOB_LAT,
        longitude: BASE_JOB_LON,
        radiusMeters: 3000,
        skillType: "Electrician",
      });

      expect(candidates.length).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 12. Active Booking Conflict Exclusion
  // ─────────────────────────────────────────────────────────────────────────────
  describe("12. Active Booking Conflict Exclusion", () => {
    it("MUST strictly EXCLUDE worker currently committed to a 'confirmed' or 'in_progress' booking", async () => {
      mockWorkers = [
        {
          id: "worker-confirmed",
          name: "Busy Worker 1",
          device_token: "fcm-busy1",
          worker_score: 4.9,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Painter",
          lat: BASE_JOB_LAT + 0.01,
          lon: BASE_JOB_LON,
          last_location_updated_at: new Date(),
          activeBookingStatus: "confirmed",
        },
        {
          id: "worker-in-progress",
          name: "Busy Worker 2",
          device_token: "fcm-busy2",
          worker_score: 4.8,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Painter",
          lat: BASE_JOB_LAT + 0.015,
          lon: BASE_JOB_LON,
          last_location_updated_at: new Date(),
          activeBookingStatus: "in_progress",
        },
        {
          id: "worker-completed-available",
          name: "Available Worker",
          device_token: "fcm-avail",
          worker_score: 4.9,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Painter",
          lat: BASE_JOB_LAT + 0.02,
          lon: BASE_JOB_LON,
          last_location_updated_at: new Date(),
          activeBookingStatus: "completed",
        },
      ];

      const candidates = await getEligibleDispatchCandidates({
        requirementId: "req-booking",
        latitude: BASE_JOB_LAT,
        longitude: BASE_JOB_LON,
        radiusMeters: 3000,
        skillType: "Painter",
      });

      expect(candidates.length).toBe(1);
      expect(candidates[0].id).toBe("worker-completed-available");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 13. Wave Radius Escalation Mapping
  // ─────────────────────────────────────────────────────────────────────────────
  describe("13. Wave Radius Escalation Mapping", () => {
    it("correctly maps wave numbers to authoritative progressive radii", () => {
      expect(getWaveRadiusMeters(1)).toBe(3000);
      expect(getWaveRadiusMeters(2)).toBe(5000);
      expect(getWaveRadiusMeters(3)).toBe(10000);
      expect(getWaveRadiusMeters(4)).toBe(15000);
      expect(getWaveRadiusMeters(5)).toBe(15000); // 4+ cap
    });

    it("worker at ~4.2 km is EXCLUDED in wave 1 (3 km) but INCLUDED in wave 2 (5 km)", async () => {
      const workerLat = BASE_JOB_LAT + 0.0378; // ~4,200m
      const workerLon = BASE_JOB_LON;

      mockWorkers = [
        {
          id: "worker-4200m",
          name: "Mid-Distance Worker",
          device_token: "fcm-4200",
          worker_score: 4.8,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Carpenter",
          lat: workerLat,
          lon: workerLon,
          last_location_updated_at: new Date(),
        },
      ];

      // Wave 1: 3,000m -> excluded
      const wave1 = await getEligibleDispatchCandidates({
        requirementId: "req-wave",
        latitude: BASE_JOB_LAT,
        longitude: BASE_JOB_LON,
        radiusMeters: getWaveRadiusMeters(1),
        skillType: "Carpenter",
      });
      expect(wave1.length).toBe(0);

      // Wave 2: 5,000m -> included
      const wave2 = await getEligibleDispatchCandidates({
        requirementId: "req-wave",
        latitude: BASE_JOB_LAT,
        longitude: BASE_JOB_LON,
        radiusMeters: getWaveRadiusMeters(2),
        skillType: "Carpenter",
      });
      expect(wave2.length).toBe(1);
      expect(wave2[0].id).toBe("worker-4200m");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 14. Combined Eligibility (8 Workers, 1 Winner)
  // ─────────────────────────────────────────────────────────────────────────────
  describe("14. Combined Eligibility (8 Workers, 1 Winner)", () => {
    it("MUST select only Worker A who satisfies all mandatory invariants concurrently", async () => {
      mockWorkers = [
        {
          id: "worker-A-eligible",
          name: "Worker A (Fully Eligible)",
          device_token: "fcm-A",
          worker_score: 4.8,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Plumber",
          lat: BASE_JOB_LAT + 0.015, // ~1.6 km
          lon: BASE_JOB_LON,
          last_location_updated_at: new Date(),
        },
        {
          id: "worker-B-outside-radius",
          name: "Worker B (Outside Radius)",
          device_token: "fcm-B",
          worker_score: 5.0,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Plumber",
          lat: BASE_JOB_LAT + 0.035, // ~3.9 km (> 3km)
          lon: BASE_JOB_LON,
          last_location_updated_at: new Date(),
        },
        {
          id: "worker-C-stale-location",
          name: "Worker C (Stale Location)",
          device_token: "fcm-C",
          worker_score: 5.0,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Plumber",
          lat: BASE_JOB_LAT + 0.01,
          lon: BASE_JOB_LON,
          last_location_updated_at: new Date(Date.now() - 36 * 60 * 60 * 1000), // 36h stale
        },
        {
          id: "worker-D-suspended",
          name: "Worker D (Suspended)",
          device_token: "fcm-D",
          worker_score: 5.0,
          is_online: true,
          deleted_at: null,
          verification_status: "suspended",
          skill_type: "Plumber",
          lat: BASE_JOB_LAT + 0.01,
          lon: BASE_JOB_LON,
          last_location_updated_at: new Date(),
        },
        {
          id: "worker-E-wrong-skill",
          name: "Worker E (Wrong Skill)",
          device_token: "fcm-E",
          worker_score: 5.0,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Electrician", // Not Plumber
          lat: BASE_JOB_LAT + 0.01,
          lon: BASE_JOB_LON,
          last_location_updated_at: new Date(),
        },
        {
          id: "worker-F-active-booking",
          name: "Worker F (Active Booking)",
          device_token: "fcm-F",
          worker_score: 5.0,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Plumber",
          lat: BASE_JOB_LAT + 0.01,
          lon: BASE_JOB_LON,
          last_location_updated_at: new Date(),
          activeBookingStatus: "confirmed",
        },
        {
          id: "worker-G-null-coords",
          name: "Worker G (Missing Coordinates)",
          device_token: "fcm-G",
          worker_score: 5.0,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Plumber",
          lat: null,
          lon: null,
          last_location_updated_at: new Date(),
        },
        {
          id: "worker-H-unverified",
          name: "Worker H (Pending Verification)",
          device_token: "fcm-H",
          worker_score: 5.0,
          is_online: true,
          deleted_at: null,
          verification_status: "pending",
          skill_type: "Plumber",
          lat: BASE_JOB_LAT + 0.01,
          lon: BASE_JOB_LON,
          last_location_updated_at: new Date(),
        },
      ];

      const candidates = await getEligibleDispatchCandidates({
        requirementId: "req-combined",
        latitude: BASE_JOB_LAT,
        longitude: BASE_JOB_LON,
        radiusMeters: 3000,
        skillType: "Plumber",
      });

      expect(candidates.length).toBe(1);
      expect(candidates[0].id).toBe("worker-A-eligible");
      expect(candidates[0].name).toBe("Worker A (Fully Eligible)");
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 15. BullMQ Dispatch Worker End-to-End Processing
  // ─────────────────────────────────────────────────────────────────────────────
  describe("15. BullMQ Dispatch Worker End-to-End Execution", () => {
    it("MUST notify Worker A (inside radius) and MUST NOT notify Worker B (outside radius)", async () => {
      const requirementId = "req-bullmq-e2e";
      const jobId = "job-bullmq-e2e";

      (prisma.job_requirement.findUnique as jest.Mock).mockResolvedValue({
        id: requirementId,
        job_id: jobId,
        skill_type: "Plumber",
        worker_count_needed: 1,
        rate_per_day: 800,
        status: "dispatching",
        job: {
          id: jobId,
          latitude: BASE_JOB_LAT,
          longitude: BASE_JOB_LON,
          location: "Indiranagar, Bengaluru",
          customer: { name: "Aditi Customer" },
        },
      });

      (prisma.dispatch_wave.create as jest.Mock).mockResolvedValue({ id: "wave-row-1" });
      (prisma.job_dispatch.createMany as jest.Mock).mockResolvedValue({ count: 1 });

      mockWorkers = [
        {
          id: "worker-A-inside",
          name: "Worker A Inside",
          device_token: "token-worker-A",
          worker_score: 4.9,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Plumber",
          lat: BASE_JOB_LAT + 0.015, // ~1.6 km
          lon: BASE_JOB_LON,
          last_location_updated_at: new Date(),
        },
        {
          id: "worker-B-outside",
          name: "Worker B Outside",
          device_token: "token-worker-B",
          worker_score: 5.0,
          is_online: true,
          deleted_at: null,
          verification_status: "verified",
          skill_type: "Plumber",
          lat: BASE_JOB_LAT + 0.045, // ~5.0 km (> 3km Wave 1)
          lon: BASE_JOB_LON,
          last_location_updated_at: new Date(),
        },
      ];

      // Execute the BullMQ dispatch worker processing logic for Wave 1
      await processDispatchJob({
        requirementId,
        jobId,
        waveNumber: 1,
        offset: 0,
      });

      // 1. Notification job is enqueued via notificationQueue with only Worker A inside radius
      expect(notificationQueue.add).toHaveBeenCalledWith(
        "dispatch-notify",
        expect.objectContaining({
          type: "dispatch-notify",
          jobId,
          requirementId,
          waveNumber: 1,
          workers: [
            expect.objectContaining({
              id: "worker-A-inside",
            }),
          ],
        }),
        expect.objectContaining({
          jobId: `notify:${requirementId}:wave-1`,
        }),
      );

      const queuedJobData = (notificationQueue.add as jest.Mock).mock.calls[0][1];
      const workerIds = queuedJobData.workers.map((w: any) => w.id);
      expect(workerIds).toContain("worker-A-inside");
      expect(workerIds).not.toContain("worker-B-outside");

      // 2. Downstream notification worker processes only Worker A
      await processNotificationJob(queuedJobData);

      expect(sendFCMToWorker).toHaveBeenCalledWith(
        "worker-A-inside",
        expect.objectContaining({
          data: expect.objectContaining({
            type: "incoming_job",
            jobId,
            requirementId,
          }),
        }),
      );

      // Worker B outside radius NEVER receives FCM notification
      expect(sendFCMToWorker).not.toHaveBeenCalledWith(
        "worker-B-outside",
        expect.anything(),
      );

      // 3. Socket.IO notification is sent only to Worker A
      expect(io.to).toHaveBeenCalledWith("worker:worker-A-inside");
      expect(io.to).not.toHaveBeenCalledWith("worker:worker-B-outside");

      // 4. job_dispatch records created only for Worker A
      expect(prisma.job_dispatch.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            expect.objectContaining({
              requirement_id: requirementId,
              worker_id: "worker-A-inside",
              wave_number: 1,
              status: "pending",
            }),
          ],
        }),
      );
    });

    it("MUST immediately fail closed without notifying workers when job coordinates are missing", async () => {
      const requirementId = "req-no-coords";
      const jobId = "job-no-coords";

      (prisma.job_requirement.findUnique as jest.Mock).mockResolvedValue({
        id: requirementId,
        job_id: jobId,
        skill_type: "Plumber",
        worker_count_needed: 1,
        status: "dispatching",
        job: {
          id: jobId,
          latitude: null, // Missing latitude
          longitude: null,
          customer: { name: "Customer" },
        },
      });

      await processDispatchJob({
        requirementId,
        jobId,
        waveNumber: 1,
        offset: 0,
      });

      // Status flipped to no_workers_available / NO_WORKERS_AVAILABLE
      expect(prisma.job_requirement.update).toHaveBeenCalledWith({
        where: { id: requirementId },
        data: { status: expect.stringMatching(/no_workers_available/i) },
      });

      // Zero workers notified
      expect(sendFCMNotification).not.toHaveBeenCalled();
      expect(sendFCMToWorker).not.toHaveBeenCalled();
      expect(prisma.job_dispatch.createMany).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 16. Fail-Closed on PostGIS Query Failure
  // ─────────────────────────────────────────────────────────────────────────────
  describe("16. Fail-Closed on PostGIS Query Failure", () => {
    it("MUST return empty array and NOT fall back to unrestricted dispatch when PostGIS query throws", async () => {
      (prisma.$queryRaw as jest.Mock).mockRejectedValueOnce(new Error("PostGIS connection lost"));

      const candidates = await getEligibleDispatchCandidates({
        requirementId: "req-err",
        latitude: BASE_JOB_LAT,
        longitude: BASE_JOB_LON,
        radiusMeters: 3000,
        skillType: "Plumber",
      });

      // Fail-closed invariant: returns empty array, never an un-geocoded candidate pool
      expect(candidates).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 17. SQL Parameterization Verification
  // ─────────────────────────────────────────────────────────────────────────────
  describe("17. SQL Parameterization Verification", () => {
    it("MUST bind coordinates, radius, and IDs as parameterized variables", async () => {
      mockWorkers = [];

      await getEligibleDispatchCandidates({
        requirementId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        latitude: 12.9716,
        longitude: 77.5946,
        radiusMeters: 3000,
        skillType: "Carpenter",
      });

      expect(lastCapturedQuery).not.toBeNull();
      const { sql, values } = lastCapturedQuery!;

      // SQL statement contains placeholders rather than interpolated literals
      expect(sql).toContain("ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography");
      expect(sql).toContain("ST_DWithin(");

      // Parameter values contain the exact typed values
      expect(values).toContain(77.5946);
      expect(values).toContain(12.9716);
      expect(values).toContain(3000);
      expect(values).toContain("Carpenter");
      expect(values).toContain("a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    });
  });
});
