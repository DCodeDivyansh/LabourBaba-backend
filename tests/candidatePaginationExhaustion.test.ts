import prisma from '../src/config/prisma';
import {
  getEligibleCandidatePage,
  getEligibleDispatchCandidates,
  encodeCandidateCursor,
  decodeCandidateCursor,
  EligibleWorkerCandidate,
} from '../src/features/dispatch/dispatchCandidate.service';
import { processDispatchJob } from '../src/workers/dispatchWorker';
import { processTimeoutJob } from '../src/workers/timeoutWorker';
import { dispatchQueue, timeoutQueue, notificationQueue } from '../src/config/bullmq';
import { RequirementStatus } from '../src/features/jobs/requirementStateMachine';

jest.mock('../src/config/bullmq', () => ({
  redisConnectionOptions: {},
  dispatchQueue: {
    add: jest.fn().mockResolvedValue({ id: 'mock-dispatch-job' }),
  },
  timeoutQueue: {
    add: jest.fn().mockResolvedValue({ id: 'mock-timeout-job' }),
  },
  notificationQueue: {
    add: jest.fn().mockResolvedValue({ id: 'mock-notify-job' }),
  },
  DISPATCH_JOB_NAMES: {
    DISPATCH_NOTIFY: 'dispatch-notify',
  },
}));

describe('Issue #26: Candidate Pagination and Exhaustion Model', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // TEST 1 — EMPTY CANDIDATE SET
  // --------------------------------------------------------------------------
  describe('Test 1: Empty Candidate Set', () => {
    it('MUST return empty candidates with explicit hasMore=false and nextCursor=null when 0 workers match', async () => {
      const origQueryRaw = prisma.$queryRaw;
      (prisma as any).$queryRaw = jest.fn().mockResolvedValue([]);

      const page = await getEligibleCandidatePage({
        requirementId: 'req-empty-test',
        latitude: 28.5,
        longitude: 77.2,
        radiusMeters: 3000,
        limit: 10,
        offset: 0,
      });

      expect(page.candidates).toEqual([]);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
      expect(page.pageSize).toBe(10);

      (prisma as any).$queryRaw = origQueryRaw;
    });

    it('MUST fail closed and return empty page on invalid coordinates or negative radius', async () => {
      const invalidLatPage = await getEligibleCandidatePage({
        requirementId: 'req-inv-test',
        latitude: 100, // Invalid lat > 90
        longitude: 77.2,
        radiusMeters: 3000,
        limit: 10,
      });
      expect(invalidLatPage.candidates).toEqual([]);
      expect(invalidLatPage.hasMore).toBe(false);

      const invalidRadiusPage = await getEligibleCandidatePage({
        requirementId: 'req-inv-test',
        latitude: 28.5,
        longitude: 77.2,
        radiusMeters: -500,
        limit: 10,
      });
      expect(invalidRadiusPage.candidates).toEqual([]);
      expect(invalidRadiusPage.hasMore).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // TEST 2 — EXACTLY PAGE SIZE
  // --------------------------------------------------------------------------
  describe('Test 2: Exactly Page Size', () => {
    it('MUST return all 10 candidates and accurately report hasMore=false when DB has exactly 10 rows', async () => {
      const mockWorkers: EligibleWorkerCandidate[] = Array.from({ length: 10 }, (_, i) => ({
        id: `worker-${i + 1}`,
        name: `Worker ${i + 1}`,
        device_token: `token-${i + 1}`,
        worker_score: 4.5,
        dist_m: 500 + i * 50,
      }));

      // Lookahead query with limit 10 queries fetchLimit=11. DB returns exactly 10.
      const origQueryRaw = prisma.$queryRaw;
      (prisma as any).$queryRaw = jest.fn().mockResolvedValue(mockWorkers);

      const page = await getEligibleCandidatePage({
        requirementId: 'req-exact-page-size',
        latitude: 28.5,
        longitude: 77.2,
        radiusMeters: 3000,
        limit: 10,
      });

      expect(page.candidates).toHaveLength(10);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();
      expect(page.candidates.map((c) => c.id)).toEqual(mockWorkers.map((w) => w.id));

      (prisma as any).$queryRaw = origQueryRaw;
    });
  });

  // --------------------------------------------------------------------------
  // TEST 3 — PAGE SIZE + 1
  // --------------------------------------------------------------------------
  describe('Test 3: Page Size + 1', () => {
    it('MUST return first 10 with hasMore=true and nextCursor on page 1, and 11th candidate on page 2', async () => {
      const all11Workers: EligibleWorkerCandidate[] = Array.from({ length: 11 }, (_, i) => ({
        id: `worker-uuid-${i + 1}`,
        name: `Worker ${i + 1}`,
        device_token: `token-${i + 1}`,
        worker_score: 4.8 - i * 0.1,
        dist_m: 300 + i * 100,
      }));

      const origQueryRaw = prisma.$queryRaw;

      // Page 1 query: returns all 11 rows (lookahead limit 11)
      (prisma as any).$queryRaw = jest.fn().mockResolvedValueOnce(all11Workers);

      const page1 = await getEligibleCandidatePage({
        requirementId: 'req-page-plus-one',
        latitude: 28.5,
        longitude: 77.2,
        radiusMeters: 3000,
        limit: 10,
      });

      expect(page1.candidates).toHaveLength(10);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).not.toBeNull();
      expect(page1.candidates[0].id).toBe('worker-uuid-1');
      expect(page1.candidates[9].id).toBe('worker-uuid-10');

      // Candidate 11 was lookahead-checked and not returned on page 1
      expect(page1.candidates.some((c) => c.id === 'worker-uuid-11')).toBe(false);

      // Page 2 query: simulate continuation with cursor
      (prisma as any).$queryRaw = jest.fn().mockResolvedValueOnce([all11Workers[10]]);

      const page2 = await getEligibleCandidatePage({
        requirementId: 'req-page-plus-one',
        latitude: 28.5,
        longitude: 77.2,
        radiusMeters: 3000,
        limit: 10,
        cursor: page1.nextCursor,
      });

      expect(page2.candidates).toHaveLength(1);
      expect(page2.candidates[0].id).toBe('worker-uuid-11');
      expect(page2.hasMore).toBe(false);
      expect(page2.nextCursor).toBeNull();

      // Combined across pages: all 11 candidates returned, 0 duplicates
      const allDispatchedIds = [...page1.candidates, ...page2.candidates].map((c) => c.id);
      expect(new Set(allDispatchedIds).size).toBe(11);
      expect(allDispatchedIds).toEqual(all11Workers.map((w) => w.id));

      (prisma as any).$queryRaw = origQueryRaw;
    });
  });

  // --------------------------------------------------------------------------
  // TEST 4 — SHORT PAGE WITH MORE ELIGIBLE CANDIDATES
  // --------------------------------------------------------------------------
  describe('Test 4: Short Page Does Not Prematurely Exhaust Search', () => {
    it('MUST NOT mark requirement NO_WORKERS_AVAILABLE on short page in wave 1 when next wave is possible', async () => {
      // In wave 1, only 2 candidates were found (short page for targetCandidateCount=10)
      const mockReq = {
        id: 'req-short-page-adv',
        job_id: 'job-1',
        worker_count_needed: 5,
        worker_count_filled: 0,
        status: 'DISPATCHING',
        job: { customer_id: 'cust-1' },
      };

      const origFindUnique = prisma.job_requirement.findUnique;
      const origUpdate = prisma.job_requirement.update;
      const origJobDispatchUpdateMany = prisma.job_dispatch.updateMany;
      const origWaveUpdateMany = prisma.dispatch_wave.updateMany;

      (prisma.job_requirement.findUnique as jest.Mock) = jest.fn().mockResolvedValue(mockReq);
      (prisma.job_requirement.update as jest.Mock) = jest.fn().mockResolvedValue({});
      (prisma.job_dispatch.updateMany as jest.Mock) = jest.fn().mockResolvedValue({ count: 2 });
      (prisma.dispatch_wave.updateMany as jest.Mock) = jest.fn().mockResolvedValue({ count: 1 });

      await processTimeoutJob({
        requirementId: mockReq.id,
        jobId: 'job-1',
        waveNumber: 1,
        totalWorkersFound: 2, // short page returned in wave 1
        offset: 0,
        waveSize: 2,
        hasMoreCandidates: false, // wave 1 radius 3km has no more, but wave 2 radius 5km exists!
      });

      // Assert requirement was NOT marked NO_WORKERS_AVAILABLE
      expect(prisma.job_requirement.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: RequirementStatus.NO_WORKERS_AVAILABLE },
        }),
      );

      expect(dispatchQueue.add).toHaveBeenCalledWith(
        'dispatch-wave',
        expect.objectContaining({
          requirementId: mockReq.id,
          waveNumber: 2,
        }),
        expect.objectContaining({
          jobId: `dispatch:${mockReq.id}:wave-2`,
        }),
      );

      (prisma.job_requirement.findUnique as any) = origFindUnique;
      (prisma.job_requirement.update as any) = origUpdate;
      (prisma.job_dispatch.updateMany as any) = origJobDispatchUpdateMany;
      (prisma.dispatch_wave.updateMany as any) = origWaveUpdateMany;
    });
  });

  // --------------------------------------------------------------------------
  // TEST 5 & 6 — ALREADY-DISPATCHED WORKERS EXCLUSION
  // --------------------------------------------------------------------------
  describe('Test 5 & 6: Already-Dispatched Exclusion & Total Exhaustion', () => {
    it('MUST exclude already-dispatched workers in SQL and return remaining eligible workers', async () => {
      const origQueryRaw = prisma.$queryRaw;

      // 5 workers total: 2 already in job_dispatch, 3 remaining
      const remaining3Workers: EligibleWorkerCandidate[] = [
        { id: 'w-3', name: 'W3', device_token: 't3', worker_score: 4.9, dist_m: 800 },
        { id: 'w-4', name: 'W4', device_token: 't4', worker_score: 4.8, dist_m: 900 },
        { id: 'w-5', name: 'W5', device_token: 't5', worker_score: 4.7, dist_m: 1000 },
      ];

      (prisma as any).$queryRaw = jest.fn().mockResolvedValue(remaining3Workers);

      const page = await getEligibleCandidatePage({
        requirementId: 'req-excluded-test',
        latitude: 28.5,
        longitude: 77.2,
        radiusMeters: 5000,
        limit: 10,
        excludeDispatched: true,
      });

      expect(page.candidates).toHaveLength(3);
      expect(page.candidates.map((c) => c.id)).toEqual(['w-3', 'w-4', 'w-5']);
      expect(page.hasMore).toBe(false);

      (prisma as any).$queryRaw = origQueryRaw;
    });

    it('MUST explicitly report exhaustion when all workers have been dispatched', async () => {
      const origQueryRaw = prisma.$queryRaw;
      (prisma as any).$queryRaw = jest.fn().mockResolvedValue([]);

      const page = await getEligibleCandidatePage({
        requirementId: 'req-all-dispatched',
        latitude: 28.5,
        longitude: 77.2,
        radiusMeters: 15000,
        limit: 10,
        excludeDispatched: true,
      });

      expect(page.candidates).toEqual([]);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();

      (prisma as any).$queryRaw = origQueryRaw;
    });
  });

  // --------------------------------------------------------------------------
  // TEST 7 & 8 — DETERMINISTIC ORDERING WITH UNIQUE TIE-BREAKER
  // --------------------------------------------------------------------------
  describe('Test 7 & 8: Deterministic Ordering with Tie-Breaker & Keyset Cursor', () => {
    it('MUST encode and decode candidate cursor payloads safely', () => {
      const candidate: EligibleWorkerCandidate = {
        id: '99999999-9999-4999-8999-999999999999',
        name: 'Deterministic Worker',
        device_token: 'tok-1',
        worker_score: 4.75,
        dist_m: 1250.5,
      };

      const cursor = encodeCandidateCursor(candidate);
      expect(typeof cursor).toBe('string');
      expect(cursor.length).toBeGreaterThan(0);

      const decoded = decodeCandidateCursor(cursor);
      expect(decoded).not.toBeNull();
      expect(decoded?.id).toBe(candidate.id);
      expect(decoded?.dist_m).toBe(1250.5);
      expect(decoded?.worker_score).toBe(4.75);
    });

    it('MUST safely return null on invalid, tampered, or empty cursor strings', () => {
      expect(decodeCandidateCursor('')).toBeNull();
      expect(decodeCandidateCursor('not-valid-base64-json!')).toBeNull();
      expect(decodeCandidateCursor(Buffer.from('{}').toString('base64url'))).toBeNull();
      expect(decodeCandidateCursor(Buffer.from(JSON.stringify({ dist_m: 'invalid' })).toString('base64url'))).toBeNull();
    });

    it('MUST preserve deterministic sort order across candidates with identical distance and score using worker id tie-breaker', async () => {
      // 3 workers with identical distance (500m) and identical score (5.0)
      const equalCandidates: EligibleWorkerCandidate[] = [
        { id: '11111111-0000-0000-0000-000000000001', name: 'A', device_token: null, worker_score: 5.0, dist_m: 500 },
        { id: '11111111-0000-0000-0000-000000000002', name: 'B', device_token: null, worker_score: 5.0, dist_m: 500 },
        { id: '11111111-0000-0000-0000-000000000003', name: 'C', device_token: null, worker_score: 5.0, dist_m: 500 },
      ];

      const origQueryRaw = prisma.$queryRaw;
      (prisma as any).$queryRaw = jest.fn().mockResolvedValue(equalCandidates);

      const candidates = await getEligibleDispatchCandidates({
        requirementId: 'req-tie-breaker-test',
        latitude: 28.5,
        longitude: 77.2,
        radiusMeters: 3000,
      });

      expect(candidates).toHaveLength(3);
      expect(candidates[0].id).toBe('11111111-0000-0000-0000-000000000001');
      expect(candidates[1].id).toBe('11111111-0000-0000-0000-000000000002');
      expect(candidates[2].id).toBe('11111111-0000-0000-0000-000000000003');

      (prisma as any).$queryRaw = origQueryRaw;
    });
  });

  // --------------------------------------------------------------------------
  // TEST 9 & 10 — RETRY & IDEMPOTENCY SAFETY
  // --------------------------------------------------------------------------
  describe('Test 9 & 10: Retry and Idempotency Safety', () => {
    it('MUST idempotently return existing wave without duplicating dispatches on retry', async () => {
      const requirementId = 'req-retry-idempotent';
      const jobId = 'job-retry-1';

      const origFindUnique = prisma.job_requirement.findUnique;
      const origWaveFindFirst = (prisma as any).dispatch_wave?.findFirst;
      const origJobDispatchFindMany = (prisma as any).job_dispatch?.findMany;

      (prisma.job_requirement.findUnique as jest.Mock) = jest.fn().mockResolvedValue({
        id: requirementId,
        job_id: jobId,
        worker_count_needed: 2,
        worker_count_filled: 0,
        status: 'DISPATCHING',
        job: { latitude: 28.5, longitude: 77.2, customer: { name: 'Customer' } },
      });

      // Existing wave found
      (prisma.dispatch_wave.findFirst as jest.Mock) = jest.fn().mockResolvedValue({
        id: 'wave-uuid-existing',
        operation_id: 'disp_op_mock',
        wave_number: 1,
        workers_notified: 2,
      });

      (prisma.job_dispatch.findMany as jest.Mock) = jest.fn().mockResolvedValue([
        { worker_id: 'worker-1' },
        { worker_id: 'worker-2' },
      ]);

      const result1 = await processDispatchJob({
        requirementId,
        jobId,
        waveNumber: 1,
      });

      const result2 = await processDispatchJob({
        requirementId,
        jobId,
        waveNumber: 1,
      });

      expect(result1.status).toBe('already_processed');
      expect(result2.status).toBe('already_processed');
      expect(result1.workerIds).toEqual(['worker-1', 'worker-2']);
      expect(result2.workerIds).toEqual(['worker-1', 'worker-2']);
      expect(timeoutQueue.add).not.toHaveBeenCalled();
      expect(notificationQueue.add).not.toHaveBeenCalled();

      (prisma.job_requirement.findUnique as any) = origFindUnique;
      (prisma.dispatch_wave.findFirst as any) = origWaveFindFirst;
      (prisma.job_dispatch.findMany as any) = origJobDispatchFindMany;
    });
  });
});
