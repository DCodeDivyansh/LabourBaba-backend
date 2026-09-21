import {
  isLocationFresh,
  getFreshnessCutoffDate,
  isWorkerLocationFresh,
} from '../src/features/dispatch/locationFreshnessPolicy';
import {
  getLocationFreshnessConfiguration,
  locationFreshnessConfig,
  DEFAULT_FRESHNESS_SECONDS,
} from '../src/config/locationFreshnessConfig';
import {
  locationFreshnessTelemetry,
} from '../src/features/dispatch/locationFreshnessTelemetry';
import {
  getEligibleDispatchCandidates,
  getEligibleCandidatePage,
  validateDispatchCoordinates,
} from '../src/features/dispatch/dispatchCandidate.service';
import prisma from '../src/config/prisma';

// Mock Prisma for deterministic candidate query testing
jest.mock('../src/config/prisma', () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
  },
}));

describe('Issue #28: Operational Location Freshness Policy & Candidate Eligibility', () => {
  const FIXED_NOW = new Date('2026-09-21T12:00:00.000Z');
  const FIXED_NOW_MS = FIXED_NOW.getTime();

  beforeEach(() => {
    jest.clearAllMocks();
    locationFreshnessTelemetry.reset();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Centralized Policy Unit Tests & Boundary Conditions
  // ─────────────────────────────────────────────────────────────────────────────
  describe('1. Location Freshness Policy (Deterministic Boundary Unit Tests)', () => {
    const thresholdSec = 300; // 5 minutes

    it('MUST return FRESH for a timestamp well inside threshold (e.g. 60s old)', () => {
      const ts = new Date(FIXED_NOW_MS - 60 * 1000);
      const result = isLocationFresh(ts, FIXED_NOW, thresholdSec);

      expect(result.isFresh).toBe(true);
      expect(result.reason).toBe('FRESH');
      expect(result.ageSeconds).toBe(60);
      expect(result.cutoffDate).toEqual(new Date(FIXED_NOW_MS - 300 * 1000));
    });

    it('MUST return FRESH at the exact boundary timestamp (now - threshold)', () => {
      const exactBoundary = new Date(FIXED_NOW_MS - 300 * 1000);
      const result = isLocationFresh(exactBoundary, FIXED_NOW, thresholdSec);

      expect(result.isFresh).toBe(true);
      expect(result.reason).toBe('FRESH');
      expect(result.ageSeconds).toBe(300);
    });

    it('MUST return FRESH at (now - threshold + 1ms)', () => {
      const boundaryPlus1ms = new Date(FIXED_NOW_MS - 300 * 1000 + 1);
      const result = isLocationFresh(boundaryPlus1ms, FIXED_NOW, thresholdSec);

      expect(result.isFresh).toBe(true);
      expect(result.reason).toBe('FRESH');
      expect(result.ageSeconds).toBeLessThan(300);
    });

    it('MUST return STALE at (now - threshold - 1ms)', () => {
      const boundaryMinus1ms = new Date(FIXED_NOW_MS - 300 * 1000 - 1);
      const result = isLocationFresh(boundaryMinus1ms, FIXED_NOW, thresholdSec);

      expect(result.isFresh).toBe(false);
      expect(result.reason).toBe('STALE');
      expect(result.ageSeconds).toBeGreaterThan(300);
    });

    it('MUST return STALE for timestamp beyond threshold (e.g. 10 minutes old)', () => {
      const staleTs = new Date(FIXED_NOW_MS - 600 * 1000);
      const result = isLocationFresh(staleTs, FIXED_NOW, thresholdSec);

      expect(result.isFresh).toBe(false);
      expect(result.reason).toBe('STALE');
      expect(result.ageSeconds).toBe(600);
    });

    it('MUST return MISSING for null or undefined last_location_at', () => {
      const resultNull = isLocationFresh(null, FIXED_NOW, thresholdSec);
      expect(resultNull.isFresh).toBe(false);
      expect(resultNull.reason).toBe('MISSING');

      const resultUndefined = isLocationFresh(undefined, FIXED_NOW, thresholdSec);
      expect(resultUndefined.isFresh).toBe(false);
      expect(resultUndefined.reason).toBe('MISSING');
    });

    it('MUST return INVALID for invalid date strings or non-dates', () => {
      const resultInvalidStr = isLocationFresh('not-a-valid-date', FIXED_NOW, thresholdSec);
      expect(resultInvalidStr.isFresh).toBe(false);
      expect(resultInvalidStr.reason).toBe('INVALID');

      const resultNaN = isLocationFresh(new Date(NaN), FIXED_NOW, thresholdSec);
      expect(resultNaN.isFresh).toBe(false);
      expect(resultNaN.reason).toBe('INVALID');
    });

    it('MUST return FRESH for moderate future timestamps within clock skew (e.g. +30s)', () => {
      const skewTs = new Date(FIXED_NOW_MS + 30 * 1000);
      const result = isLocationFresh(skewTs, FIXED_NOW, thresholdSec, 60_000);

      expect(result.isFresh).toBe(true);
      expect(result.reason).toBe('FRESH');
      expect(result.ageSeconds).toBe(0);
    });

    it('MUST return FUTURE_SKEW_EXCEEDED for distant future timestamps exceeding clock skew (e.g. +120s)', () => {
      const distantFuture = new Date(FIXED_NOW_MS + 120 * 1000);
      const result = isLocationFresh(distantFuture, FIXED_NOW, thresholdSec, 60_000);

      expect(result.isFresh).toBe(false);
      expect(result.reason).toBe('FUTURE_SKEW_EXCEEDED');
    });

    it('MUST correctly evaluate worker objects via isWorkerLocationFresh', () => {
      const freshWorker = { last_location_at: new Date(FIXED_NOW_MS - 50 * 1000) };
      expect(isWorkerLocationFresh(freshWorker, FIXED_NOW, thresholdSec).isFresh).toBe(true);

      const staleWorker = { last_location_at: new Date(FIXED_NOW_MS - 400 * 1000) };
      expect(isWorkerLocationFresh(staleWorker, FIXED_NOW, thresholdSec).isFresh).toBe(false);

      const noLocWorker = { last_location_at: null };
      expect(isWorkerLocationFresh(noLocWorker, FIXED_NOW, thresholdSec).isFresh).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Configuration Validation & Parser Tests
  // ─────────────────────────────────────────────────────────────────────────────
  describe('2. Operational Freshness Configuration Validation', () => {
    it('uses default 300s (5 minutes) when no environment variable is provided', () => {
      const config = getLocationFreshnessConfiguration({});
      expect(config.maxAgeSeconds).toBe(DEFAULT_FRESHNESS_SECONDS);
      expect(config.maxClockSkewMs).toBe(60_000);
    });

    it('parses valid LOCATION_FRESHNESS_MAX_AGE_SECONDS integer string', () => {
      const config = getLocationFreshnessConfiguration({
        LOCATION_FRESHNESS_MAX_AGE_SECONDS: '600',
      });
      expect(config.maxAgeSeconds).toBe(600);
    });

    it('supports alias DISPATCH_LOCATION_FRESHNESS_SECONDS', () => {
      const config = getLocationFreshnessConfiguration({
        DISPATCH_LOCATION_FRESHNESS_SECONDS: '180',
      });
      expect(config.maxAgeSeconds).toBe(180);
    });

    it('supports legacy DISPATCH_LOCATION_FRESHNESS_HOURS converted to seconds', () => {
      const config = getLocationFreshnessConfiguration({
        DISPATCH_LOCATION_FRESHNESS_HOURS: '0.5',
      });
      expect(config.maxAgeSeconds).toBe(1800);
    });

    it('throws Error on non-numeric or malformed configuration strings', () => {
      expect(() =>
        getLocationFreshnessConfiguration({
          LOCATION_FRESHNESS_MAX_AGE_SECONDS: 'not-a-number',
        }),
      ).toThrow('must be a positive integer');

      expect(() =>
        getLocationFreshnessConfiguration({
          LOCATION_FRESHNESS_MAX_AGE_SECONDS: '10.5.2',
        }),
      ).toThrow('must be a positive integer');
    });

    it('throws Error on negative, zero, or sub-minimum threshold (< 10 seconds)', () => {
      expect(() =>
        getLocationFreshnessConfiguration({
          LOCATION_FRESHNESS_MAX_AGE_SECONDS: '0',
        }),
      ).toThrow('must be a positive integer > 0');

      expect(() =>
        getLocationFreshnessConfiguration({
          LOCATION_FRESHNESS_MAX_AGE_SECONDS: '-50',
        }),
      ).toThrow('must be a positive integer');

      expect(() =>
        getLocationFreshnessConfiguration({
          LOCATION_FRESHNESS_MAX_AGE_SECONDS: '5',
        }),
      ).toThrow('cannot be less than 10 seconds');
    });

    it('throws Error on absurdly large threshold (> 86400 seconds)', () => {
      expect(() =>
        getLocationFreshnessConfiguration({
          LOCATION_FRESHNESS_MAX_AGE_SECONDS: '100000',
        }),
      ).toThrow('cannot exceed 86400 seconds');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Database SQL Query & Candidate Invariant Enforcement
  // ─────────────────────────────────────────────────────────────────────────────
  describe('3. Dispatch Candidate SQL Freshness Invariant Enforcement', () => {
    const JOB_LAT = 12.9716;
    const JOB_LON = 77.5946;

    interface MockWorker {
      id: string;
      name: string;
      is_online: boolean;
      deleted_at: Date | null;
      verification_status: string;
      skill_type: string;
      lat: number | null;
      lon: number | null;
      last_location_at: Date | null;
    }

    let mockDbWorkers: MockWorker[] = [];

    beforeEach(() => {
      (prisma.$queryRaw as jest.Mock).mockImplementation(
        async (strings: TemplateStringsArray, ...values: any[]) => {
          const sql = strings.join('?');

          // Verify SQL structure includes freshness predicate on worker table
          expect(sql).toContain('w.last_location_at IS NOT NULL');
          expect(sql).toContain('w.last_location_at >= NOW() -');
          expect(sql).toContain('seconds');
          expect(sql).toContain('w.last_location_at <= NOW() + interval');

          const [
            lon1, lat1, lon2, lat2, radiusMeters,
            skillReq, skillReq2, skillReq3,
            excludeDispatched, reqId,
            requireFreshness, maxAgeSeconds,
          ] = values;

          const now = FIXED_NOW.getTime();
          const freshnessWindowMs = (maxAgeSeconds ?? locationFreshnessConfig.maxAgeSeconds) * 1000;
          const clockSkewMs = 60_000;

          return mockDbWorkers
            .filter((w) => {
              if (!w.is_online) return false;
              if (w.deleted_at !== null) return false;
              if (w.verification_status !== 'verified') return false;
              if (w.lat === null || w.lon === null) return false;

              // Freshness predicate
              if (requireFreshness) {
                if (w.last_location_at === null || w.last_location_at === undefined) {
                  return false;
                }
                const ts = w.last_location_at.getTime();
                if (Number.isNaN(ts)) return false;
                if (ts > now + clockSkewMs) return false; // future skew
                if (ts < now - freshnessWindowMs) return false; // stale
              }

              return true;
            })
            .map((w) => ({
              id: w.id,
              name: w.name,
              device_token: `token-${w.id}`,
              worker_score: 4.8,
              dist_m: 1000,
            }));
        },
      );
    });

    it('MUST include a worker whose location was updated 2 minutes ago (fresh <= 5 min)', async () => {
      mockDbWorkers = [
        {
          id: 'worker-fresh-2m',
          name: 'Fresh Worker',
          is_online: true,
          deleted_at: null,
          verification_status: 'verified',
          skill_type: 'Plumber',
          lat: JOB_LAT + 0.005,
          lon: JOB_LON,
          last_location_at: new Date(FIXED_NOW_MS - 120 * 1000), // 2 min old
        },
      ];

      const candidates = await getEligibleDispatchCandidates({
        requirementId: 'req-1',
        latitude: JOB_LAT,
        longitude: JOB_LON,
        radiusMeters: 3000,
        skillType: 'Plumber',
        maxLocationAgeSeconds: 300,
      });

      expect(candidates.length).toBe(1);
      expect(candidates[0].id).toBe('worker-fresh-2m');
    });

    it('MUST strictly EXCLUDE a worker whose location was updated 10 minutes ago (stale > 5 min)', async () => {
      mockDbWorkers = [
        {
          id: 'worker-stale-10m',
          name: 'Stale Worker',
          is_online: true,
          deleted_at: null,
          verification_status: 'verified',
          skill_type: 'Plumber',
          lat: JOB_LAT + 0.005,
          lon: JOB_LON,
          last_location_at: new Date(FIXED_NOW_MS - 600 * 1000), // 10 min old
        },
      ];

      const candidates = await getEligibleDispatchCandidates({
        requirementId: 'req-2',
        latitude: JOB_LAT,
        longitude: JOB_LON,
        radiusMeters: 3000,
        skillType: 'Plumber',
        maxLocationAgeSeconds: 300,
      });

      expect(candidates.length).toBe(0);
    });

    it('MUST strictly EXCLUDE a worker with NULL last_location_at even if online and verified', async () => {
      mockDbWorkers = [
        {
          id: 'worker-null-loc',
          name: 'No Timestamp Worker',
          is_online: true,
          deleted_at: null,
          verification_status: 'verified',
          skill_type: 'Plumber',
          lat: JOB_LAT + 0.005,
          lon: JOB_LON,
          last_location_at: null,
        },
      ];

      const candidates = await getEligibleDispatchCandidates({
        requirementId: 'req-3',
        latitude: JOB_LAT,
        longitude: JOB_LON,
        radiusMeters: 3000,
        skillType: 'Plumber',
      });

      expect(candidates.length).toBe(0);
    });

    it('MUST strictly EXCLUDE a worker with future-dated location beyond clock skew (> 60s)', async () => {
      mockDbWorkers = [
        {
          id: 'worker-future-skew',
          name: 'Future Timestamp Worker',
          is_online: true,
          deleted_at: null,
          verification_status: 'verified',
          skill_type: 'Plumber',
          lat: JOB_LAT + 0.005,
          lon: JOB_LON,
          last_location_at: new Date(FIXED_NOW_MS + 300 * 1000), // 5 min in future
        },
      ];

      const candidates = await getEligibleDispatchCandidates({
        requirementId: 'req-4',
        latitude: JOB_LAT,
        longitude: JOB_LON,
        radiusMeters: 3000,
        skillType: 'Plumber',
      });

      expect(candidates.length).toBe(0);
    });

    it('demonstrates transition: stale worker becomes eligible upon fresh location update', async () => {
      // 1. Initial state: Stale worker
      mockDbWorkers = [
        {
          id: 'worker-dyn',
          name: 'Dynamic Worker',
          is_online: true,
          deleted_at: null,
          verification_status: 'verified',
          skill_type: 'Electrician',
          lat: JOB_LAT + 0.005,
          lon: JOB_LON,
          last_location_at: new Date(FIXED_NOW_MS - 500 * 1000), // 500s old (> 300s)
        },
      ];

      const initialCandidates = await getEligibleDispatchCandidates({
        requirementId: 'req-dyn',
        latitude: JOB_LAT,
        longitude: JOB_LON,
        radiusMeters: 3000,
        skillType: 'Electrician',
        maxLocationAgeSeconds: 300,
      });
      expect(initialCandidates.length).toBe(0);

      // 2. Worker updates location: last_location_at becomes NOW (fresh)
      mockDbWorkers[0].last_location_at = new Date(FIXED_NOW_MS - 5 * 1000); // 5s old

      const updatedCandidates = await getEligibleDispatchCandidates({
        requirementId: 'req-dyn',
        latitude: JOB_LAT,
        longitude: JOB_LON,
        radiusMeters: 3000,
        skillType: 'Electrician',
        maxLocationAgeSeconds: 300,
      });
      expect(updatedCandidates.length).toBe(1);
      expect(updatedCandidates[0].id).toBe('worker-dyn');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Telemetry & Observability
  // ─────────────────────────────────────────────────────────────────────────────
  describe('4. Telemetry & Low-Cardinality Observability', () => {
    it('records evaluation and exclusion events correctly without high cardinality labels', () => {
      locationFreshnessTelemetry.recordEvaluation('FRESH');
      locationFreshnessTelemetry.recordEvaluation('FRESH');
      locationFreshnessTelemetry.recordEvaluation('STALE');
      locationFreshnessTelemetry.recordEvaluation('MISSING');
      locationFreshnessTelemetry.recordEvaluation('INVALID');
      locationFreshnessTelemetry.recordEvaluation('FUTURE_SKEW_EXCEEDED');

      locationFreshnessTelemetry.recordExclusion('STALE_LOCATION');
      locationFreshnessTelemetry.recordExclusion('MISSING_LOCATION');

      const metrics = locationFreshnessTelemetry.getMetrics();

      expect(metrics.evaluationsTotal.fresh).toBe(2);
      expect(metrics.evaluationsTotal.stale).toBe(1);
      expect(metrics.evaluationsTotal.missing).toBe(1);
      expect(metrics.evaluationsTotal.invalid).toBe(1);
      expect(metrics.evaluationsTotal.future_skew_exceeded).toBe(1);

      expect(metrics.exclusionsTotal.stale_location).toBe(1);
      expect(metrics.exclusionsTotal.missing_location).toBe(1);
      expect(metrics.exclusionsTotal.invalid_location).toBe(0);
    });
  });
});
