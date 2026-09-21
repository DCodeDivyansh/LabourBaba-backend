import request from 'supertest';
import { app } from '../src/server';
import {
  validateCoordinatePair,
  validateOptionalCoordinatePair,
  isValidLatitude,
  isValidLongitude,
} from '../src/utils/coordinateValidator';
import {
  convertToGeography,
  convertToGeoJSON,
  parseGeography,
} from '../src/utils/locationUtils';
import {
  UpdateWorkerLocationReqSchema,
  CreateJobReqSchema,
  LocateWorkerReqSchema,
} from '../src/schemas';
import { generateToken } from '../src/utils/authUtils';
import { UserRole } from '../src/type/userRole';
import prisma from '../src/config/prisma';

// Mock dependencies
jest.mock('../src/config/prisma', () => ({
  __esModule: true,
  default: {
    worker: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    worker_location: {
      create: jest.fn(),
    },
    job: {
      create: jest.fn(),
    },
    job_requirement: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(1),
  },
}));

jest.mock('../src/config/bullmq', () => ({
  dispatchQueue: {
    add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
  },
}));

describe('Issue #29: Hardened Coordinate Validation Suite', () => {
  const WORKER_ID = 'aaaaaaaa-1111-4aaa-aaaa-111111111111';
  const CUSTOMER_ID = 'bbbbbbbb-2222-4bbb-bbbb-222222222222';

  const workerToken = generateToken({ id: WORKER_ID, role: UserRole.WORKER });
  const customerToken = generateToken({ id: CUSTOMER_ID, role: UserRole.CUSTOMER });

  beforeEach(() => {
    jest.clearAllMocks();

    (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
      if (typeof callback === 'function') {
        return callback(prisma);
      }
      return callback;
    });

    (prisma.worker.findUnique as jest.Mock).mockResolvedValue({
      id: WORKER_ID,
      deleted_at: null,
    });

    (prisma.worker_location.create as jest.Mock).mockResolvedValue({
      id: 'loc-1234',
      worker_id: WORKER_ID,
      updated_at: new Date(),
    });

    (prisma.job.create as jest.Mock).mockResolvedValue({
      id: 'job-1234',
      customer_id: CUSTOMER_ID,
      latitude: 12.9716,
      longitude: 77.5946,
      status: 'OPEN',
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Centralized Coordinate Validator Unit Tests
  // ─────────────────────────────────────────────────────────────────────────────
  describe('1. Centralized Coordinate Validator (Unit Tests)', () => {
    describe('A. Valid Coordinates', () => {
      it('accepts (0, 0) - Null Island', () => {
        const res = validateCoordinatePair(0, 0);
        expect(res.isValid).toBe(true);
        expect(res.latitude).toBe(0);
        expect(res.longitude).toBe(0);
      });

      it('accepts (0, 77.5) and (28.6139, 0) - Zero Latitude / Longitude', () => {
        expect(validateCoordinatePair(0, 77.5).isValid).toBe(true);
        expect(validateCoordinatePair(28.6139, 0).isValid).toBe(true);
      });

      it('accepts extreme boundary values (-90, -180) and (90, 180)', () => {
        const minBound = validateCoordinatePair(-90, -180);
        expect(minBound.isValid).toBe(true);
        expect(minBound.latitude).toBe(-90);
        expect(minBound.longitude).toBe(-180);

        const maxBound = validateCoordinatePair(90, 180);
        expect(maxBound.isValid).toBe(true);
        expect(maxBound.latitude).toBe(90);
        expect(maxBound.longitude).toBe(180);
      });

      it('accepts standard positive and negative decimal coordinates', () => {
        const bengaluru = validateCoordinatePair(12.9716, 77.5946);
        expect(bengaluru.isValid).toBe(true);
        expect(bengaluru.latitude).toBe(12.9716);
        expect(bengaluru.longitude).toBe(77.5946);

        const sydney = validateCoordinatePair(-33.8688, 151.2093);
        expect(sydney.isValid).toBe(true);
      });

      it('normalizes -0 to 0', () => {
        const negZero = validateCoordinatePair(-0, -0);
        expect(negZero.isValid).toBe(true);
        expect(Object.is(negZero.latitude, 0)).toBe(true);
        expect(Object.is(negZero.longitude, 0)).toBe(true);
      });
    });

    describe('B. Invalid Latitude (Out of Bounds)', () => {
      it('rejects latitude < -90', () => {
        expect(validateCoordinatePair(-90.000001, 0).isValid).toBe(false);
        expect(validateCoordinatePair(-91, 0).isValid).toBe(false);
        expect(validateCoordinatePair(-1000, 0).isValid).toBe(false);
      });

      it('rejects latitude > 90', () => {
        expect(validateCoordinatePair(90.000001, 0).isValid).toBe(false);
        expect(validateCoordinatePair(91, 0).isValid).toBe(false);
        expect(validateCoordinatePair(1000, 0).isValid).toBe(false);
      });
    });

    describe('C. Invalid Longitude (Out of Bounds)', () => {
      it('rejects longitude < -180', () => {
        expect(validateCoordinatePair(0, -180.000001).isValid).toBe(false);
        expect(validateCoordinatePair(0, -181).isValid).toBe(false);
        expect(validateCoordinatePair(0, -500).isValid).toBe(false);
      });

      it('rejects longitude > 180', () => {
        expect(validateCoordinatePair(0, 180.000001).isValid).toBe(false);
        expect(validateCoordinatePair(0, 181).isValid).toBe(false);
        expect(validateCoordinatePair(0, 500).isValid).toBe(false);
      });
    });

    describe('D. Non-Finite Numbers', () => {
      it('rejects NaN coordinates', () => {
        expect(validateCoordinatePair(NaN, 0).isValid).toBe(false);
        expect(validateCoordinatePair(0, NaN).isValid).toBe(false);
        expect(validateCoordinatePair(NaN, NaN).isValid).toBe(false);
      });

      it('rejects Infinity and -Infinity coordinates', () => {
        expect(validateCoordinatePair(Infinity, 0).isValid).toBe(false);
        expect(validateCoordinatePair(-Infinity, 0).isValid).toBe(false);
        expect(validateCoordinatePair(0, Infinity).isValid).toBe(false);
        expect(validateCoordinatePair(0, -Infinity).isValid).toBe(false);
      });
    });

    describe('E. Partial Pairs (Mandatory Pair Semantics)', () => {
      it('rejects latitude without longitude', () => {
        const res = validateCoordinatePair(12.5, undefined);
        expect(res.isValid).toBe(false);
        expect(res.error).toContain('Partial coordinate pair rejected');
      });

      it('rejects longitude without latitude', () => {
        const res = validateCoordinatePair(undefined, 77.5);
        expect(res.isValid).toBe(false);
        expect(res.error).toContain('Partial coordinate pair rejected');
      });

      it('rejects latitude with null longitude', () => {
        const res = validateCoordinatePair(12.5, null);
        expect(res.isValid).toBe(false);
      });

      it('rejects null latitude with numeric longitude', () => {
        const res = validateCoordinatePair(null, 77.5);
        expect(res.isValid).toBe(false);
      });
    });

    describe('F. Optional Coordinate Pair Helper', () => {
      it('accepts both omitted / undefined', () => {
        const res = validateOptionalCoordinatePair(undefined, undefined);
        expect(res.isValid).toBe(true);
        expect(res.latitude).toBeUndefined();
        expect(res.longitude).toBeUndefined();
      });

      it('accepts both null', () => {
        const res = validateOptionalCoordinatePair(null, null);
        expect(res.isValid).toBe(true);
      });

      it('rejects partial optional pair (e.g. lat provided, lon omitted)', () => {
        expect(validateOptionalCoordinatePair(12.5, undefined).isValid).toBe(false);
        expect(validateOptionalCoordinatePair(undefined, 77.5).isValid).toBe(false);
      });
    });

    describe('G. Type Safety & Non-Numeric Types', () => {
      it('rejects strings, booleans, objects, and arrays', () => {
        expect(validateCoordinatePair('12.5' as any, 77.5).isValid).toBe(false);
        expect(validateCoordinatePair(12.5, '77.5' as any).isValid).toBe(false);
        expect(validateCoordinatePair(true as any, false as any).isValid).toBe(false);
        expect(validateCoordinatePair({} as any, [] as any).isValid).toBe(false);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Location Utilities Hardening
  // ─────────────────────────────────────────────────────────────────────────────
  describe('2. Location Utilities (convertToGeography, convertToGeoJSON, parseGeography)', () => {
    it('convertToGeography formats valid POINT(lon lat)', () => {
      expect(convertToGeography(77.5946, 12.9716)).toBe('POINT(77.5946 12.9716)');
      expect(convertToGeography(0, 0)).toBe('POINT(0 0)');
      expect(convertToGeography(180, 90)).toBe('POINT(180 90)');
    });

    it('convertToGeography throws Error on invalid coordinates', () => {
      expect(() => convertToGeography(185, 0)).toThrow('Longitude must be between -180 and 180');
      expect(() => convertToGeography(0, 95)).toThrow('Latitude must be between -90 and 90');
      expect(() => convertToGeography(NaN, 0)).toThrow();
    });

    it('convertToGeoJSON formats valid GeoJSON Point [lon, lat]', () => {
      const geojson = convertToGeoJSON(77.5946, 12.9716);
      expect(geojson.type).toBe('Point');
      expect(geojson.coordinates).toEqual([77.5946, 12.9716]);
    });

    it('parseGeography parses POINT(lon lat) into { longitude, latitude }', () => {
      const parsed = parseGeography('POINT(77.5946 12.9716)');
      expect(parsed.longitude).toBe(77.5946);
      expect(parsed.latitude).toBe(12.9716);
    });

    it('parseGeography throws Error on malformed format or out-of-bounds numbers', () => {
      expect(() => parseGeography('INVALID POINT')).toThrow('Invalid geography format');
      expect(() => parseGeography('POINT(190 45)')).toThrow('Invalid geography coordinates');
      expect(() => parseGeography('POINT(77.5 100)')).toThrow('Invalid geography coordinates');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Zod Request Schema Validation
  // ─────────────────────────────────────────────────────────────────────────────
  describe('3. Zod Schema Hardening & Invariant Checks', () => {
    describe('UpdateWorkerLocationReqSchema', () => {
      it('accepts valid coordinates including (0, 0)', () => {
        expect(UpdateWorkerLocationReqSchema.safeParse({ latitude: 0, longitude: 0 }).success).toBe(true);
        expect(UpdateWorkerLocationReqSchema.safeParse({ latitude: 12.97, longitude: 77.59 }).success).toBe(true);
      });

      it('rejects partial pair (latitude only or longitude only)', () => {
        expect(UpdateWorkerLocationReqSchema.safeParse({ latitude: 12.97 }).success).toBe(false);
        expect(UpdateWorkerLocationReqSchema.safeParse({ longitude: 77.59 }).success).toBe(false);
      });

      it('rejects out-of-bounds latitude and longitude', () => {
        expect(UpdateWorkerLocationReqSchema.safeParse({ latitude: 91, longitude: 0 }).success).toBe(false);
        expect(UpdateWorkerLocationReqSchema.safeParse({ latitude: 0, longitude: 181 }).success).toBe(false);
      });

      it('rejects non-finite (NaN, Infinity)', () => {
        expect(UpdateWorkerLocationReqSchema.safeParse({ latitude: NaN, longitude: 0 }).success).toBe(false);
        expect(UpdateWorkerLocationReqSchema.safeParse({ latitude: 0, longitude: Infinity }).success).toBe(false);
      });
    });

    describe('CreateJobReqSchema', () => {
      it('accepts valid paired coordinates', () => {
        const res = CreateJobReqSchema.safeParse({
          latitude: 12.9716,
          longitude: 77.5946,
          location: 'Bengaluru',
        });
        expect(res.success).toBe(true);
      });

      it('accepts omitted coordinates (neither supplied)', () => {
        const res = CreateJobReqSchema.safeParse({
          location: 'Remote job',
        });
        expect(res.success).toBe(true);
      });

      it('rejects partial pair: latitude supplied without longitude', () => {
        const res = CreateJobReqSchema.safeParse({
          latitude: 12.9716,
          location: 'Bengaluru',
        });
        expect(res.success).toBe(false);
      });

      it('rejects partial pair: longitude supplied without latitude', () => {
        const res = CreateJobReqSchema.safeParse({
          longitude: 77.5946,
          location: 'Bengaluru',
        });
        expect(res.success).toBe(false);
      });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. HTTP API Integration Tests
  // ─────────────────────────────────────────────────────────────────────────────
  describe('4. HTTP Location Endpoints Integration', () => {
    describe('POST /api/worker_location/add', () => {
      it('accepts valid coordinates (0, 0)', async () => {
        const res = await request(app)
          .post('/api/worker_location/add')
          .set('Authorization', `Bearer ${workerToken}`)
          .send({ latitude: 0, longitude: 0 });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.data.latitude).toBe(0);
        expect(res.body.data.longitude).toBe(0);
      });

      it('rejects partial coordinate pair with 400 Bad Request', async () => {
        const resLatOnly = await request(app)
          .post('/api/worker_location/add')
          .set('Authorization', `Bearer ${workerToken}`)
          .send({ latitude: 12.97 });

        expect(resLatOnly.status).toBe(400);

        const resLonOnly = await request(app)
          .post('/api/worker_location/add')
          .set('Authorization', `Bearer ${workerToken}`)
          .send({ longitude: 77.59 });

        expect(resLonOnly.status).toBe(400);
      });

      it('rejects out-of-bounds coordinates with 400 Bad Request', async () => {
        const resOutLat = await request(app)
          .post('/api/worker_location/add')
          .set('Authorization', `Bearer ${workerToken}`)
          .send({ latitude: 95, longitude: 77.59 });

        expect(resOutLat.status).toBe(400);

        const resOutLon = await request(app)
          .post('/api/worker_location/add')
          .set('Authorization', `Bearer ${workerToken}`)
          .send({ latitude: 12.97, longitude: 185 });

        expect(resOutLon.status).toBe(400);
      });

      it('rejects non-numeric string coordinates with 400 Bad Request', async () => {
        const resStr = await request(app)
          .post('/api/worker_location/add')
          .set('Authorization', `Bearer ${workerToken}`)
          .send({ latitude: '12.97', longitude: '77.59' });

        expect(resStr.status).toBe(400);
      });
    });

    describe('PATCH /api/workers/me/location', () => {
      it('accepts valid coordinates (-33.86, 151.20)', async () => {
        const res = await request(app)
          .patch('/api/workers/me/location')
          .set('Authorization', `Bearer ${workerToken}`)
          .send({ latitude: -33.86, longitude: 151.2 });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
      });

      it('rejects partial coordinate pair with 400 Bad Request', async () => {
        const res = await request(app)
          .patch('/api/workers/me/location')
          .set('Authorization', `Bearer ${workerToken}`)
          .send({ latitude: -33.86 });

        expect(res.status).toBe(400);
      });
    });

    describe('POST /api/jobs', () => {
      it('accepts valid paired coordinates', async () => {
        const res = await request(app)
          .post('/api/jobs')
          .set('Authorization', `Bearer ${customerToken}`)
          .send({
            latitude: 12.9716,
            longitude: 77.5946,
            location: 'MG Road, Bengaluru',
            requirements: [{ worker_count_needed: 1, skill_type: 'Plumber' }],
          });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
      });

      it('accepts job without coordinates (both omitted)', async () => {
        const res = await request(app)
          .post('/api/jobs')
          .set('Authorization', `Bearer ${customerToken}`)
          .send({
            location: 'Remote Work',
            requirements: [{ worker_count_needed: 1, skill_type: 'Developer' }],
          });

        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
      });

      it('rejects job creation with partial coordinates (latitude only) with 400', async () => {
        const res = await request(app)
          .post('/api/jobs')
          .set('Authorization', `Bearer ${customerToken}`)
          .send({
            latitude: 12.9716,
            location: 'MG Road, Bengaluru',
            requirements: [{ worker_count_needed: 1, skill_type: 'Plumber' }],
          });

        expect(res.status).toBe(400);
      });
    });
  });
});
