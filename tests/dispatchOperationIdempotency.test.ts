import prisma from '../src/config/prisma';
import {
  generateDispatchOperationId,
  validateDispatchOperationId,
  DispatchOperationResult,
} from '../src/features/dispatch/dispatchOperation';
import { processDispatchJob, DispatchJobData } from '../src/workers/dispatchWorker';
import { dispatchQueue, timeoutQueue, notificationQueue } from '../src/config/bullmq';
import { getEligibleDispatchCandidates } from '../src/features/dispatch/dispatchCandidate.service';

// Mock BullMQ queues to prevent external Redis connection timeouts during tests
jest.mock('../src/config/bullmq', () => ({
  redisConnectionOptions: {},
  dispatchQueue: {
    add: jest.fn().mockResolvedValue({ id: 'mock-dispatch-job' }),
  },
  timeoutQueue: {
    add: jest.fn().mockResolvedValue({ id: 'mock-timeout-job' }),
  },
  notificationQueue: {
    add: jest.fn().mockResolvedValue({ id: 'mock-notification-job' }),
  },
  DISPATCH_JOB_NAMES: {
    DISPATCH_WAVE: 'dispatch-wave',
    WAVE_TIMEOUT: 'wave-timeout',
    DISPATCH_NOTIFY: 'dispatch-notify',
  },
}));

jest.mock('../src/features/dispatch/dispatchCandidate.service', () => {
  const actual = jest.requireActual('../src/features/dispatch/dispatchCandidate.service');
  return {
    ...actual,
    getEligibleDispatchCandidates: jest.fn(),
  };
});

describe('Issue #23 — Dispatch Operation Idempotency Suite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (timeoutQueue.add as jest.Mock).mockResolvedValue({ id: 'mock-timeout-job' });
    (notificationQueue.add as jest.Mock).mockResolvedValue({ id: 'mock-notify-job' });
    (dispatchQueue.add as jest.Mock).mockResolvedValue({ id: 'mock-dispatch-job' });
  });

  // ── 1. Deterministic Operation ID Tests ─────────────────────────────────────
  describe('1. Deterministic Operation ID Generation & Validation', () => {
    const requirementId = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';

    it('MUST produce identical operation IDs for identical business inputs', () => {
      const id1 = generateDispatchOperationId({ requirementId, waveNumber: 1 });
      const id2 = generateDispatchOperationId({ requirementId, waveNumber: 1 });
      const id3 = generateDispatchOperationId({ requirementId, waveNumber: 1, operationType: 'WAVE_DISPATCH' });

      expect(id1).toBe(id2);
      expect(id1).toBe(id3);
      expect(id1.startsWith('disp_op_')).toBe(true);
      expect(id1.length).toBe(40); // 'disp_op_' (8 chars) + 32 hex chars = 40 chars
    });

    it('MUST produce different operation IDs for different wave numbers', () => {
      const wave1 = generateDispatchOperationId({ requirementId, waveNumber: 1 });
      const wave2 = generateDispatchOperationId({ requirementId, waveNumber: 2 });
      const wave3 = generateDispatchOperationId({ requirementId, waveNumber: 3 });

      expect(wave1).not.toBe(wave2);
      expect(wave2).not.toBe(wave3);
      expect(wave1).not.toBe(wave3);
    });

    it('MUST produce different operation IDs for different requirements', () => {
      const reqA = '11111111-1111-4111-8111-111111111111';
      const reqB = '22222222-2222-4222-8222-222222222222';

      const idA = generateDispatchOperationId({ requirementId: reqA, waveNumber: 1 });
      const idB = generateDispatchOperationId({ requirementId: reqB, waveNumber: 1 });

      expect(idA).not.toBe(idB);
    });

    it('MUST normalize casing and surrounding whitespace in requirement IDs', () => {
      const idLower = generateDispatchOperationId({ requirementId: '  a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d  ', waveNumber: 1 });
      const idUpper = generateDispatchOperationId({ requirementId: 'A1B2C3D4-E5F6-4A1B-8C2D-3E4F5A6B7C8D', waveNumber: 1 });

      expect(idLower).toBe(idUpper);
    });

    it('MUST normalize default waveNumber to 1 when missing, null, or zero', () => {
      const idDefault = generateDispatchOperationId({ requirementId, waveNumber: 1 });
      const idNull = generateDispatchOperationId({ requirementId, waveNumber: null });
      const idZero = generateDispatchOperationId({ requirementId, waveNumber: 0 });
      const idUndefined = generateDispatchOperationId({ requirementId });

      expect(idNull).toBe(idDefault);
      expect(idZero).toBe(idDefault);
      expect(idUndefined).toBe(idDefault);
    });

    it('MUST validate matching operation IDs and reject invalid ones', () => {
      const validId = generateDispatchOperationId({ requirementId, waveNumber: 2 });

      expect(validateDispatchOperationId(validId, { requirementId, waveNumber: 2 })).toBe(true);
      expect(validateDispatchOperationId(validId, { requirementId, waveNumber: 1 })).toBe(false);
      expect(validateDispatchOperationId('disp_op_fakeinvalidhash1234567890', { requirementId, waveNumber: 2 })).toBe(false);
      expect(validateDispatchOperationId('', { requirementId, waveNumber: 2 })).toBe(false);
    });

    it('MUST remain deterministic regardless of execution timestamp or delay', async () => {
      const id1 = generateDispatchOperationId({ requirementId, waveNumber: 1 });
      await new Promise((r) => setTimeout(r, 50));
      const id2 = generateDispatchOperationId({ requirementId, waveNumber: 1 });

      expect(id1).toBe(id2);
    });
  });

  // ── 2. Real PostgreSQL Concurrency & Database Uniqueness ─────────────────────
  describe('2. Real PostgreSQL Concurrency & Unique Constraints', () => {
    let testCustomerId: string;
    let testJobId: string;
    let testRequirementId: string;
    let testSkillCategoryId: string;
    let testWorkerIds: string[] = [];

    beforeAll(async () => {
      // 1. Create test customer in live PostgreSQL
      const customer = await prisma.customer.create({
        data: {
          phone: '+919999900023',
          name: 'Idempotency Test Customer',
          password: 'hashedpassword',
        },
      });
      testCustomerId = customer.id;

      // 2. Create job with valid coordinates
      const job = await prisma.job.create({
        data: {
          customer_id: testCustomerId,
          status: 'OPEN',
          location: 'Delhi NCR',
          latitude: 28.6139,
          longitude: 77.209,
        },
      });
      testJobId = job.id;

      // 3. Create job requirement
      const req = await prisma.job_requirement.create({
        data: {
          job_id: testJobId,
          skill_type: 'IdempotencyPlumber',
          worker_count_needed: 2,
          rate_per_day: 900,
          status: 'DISPATCHING',
        },
      });
      testRequirementId = req.id;

      // 4. Skill category
      let category = await prisma.skill_category.findFirst({
        where: { name: 'Idempotency Category' },
      });
      if (!category) {
        category = await prisma.skill_category.create({
          data: { name: 'Idempotency Category' },
        });
      }
      testSkillCategoryId = category.id;

      // 5. Create 3 test workers
      for (let i = 1; i <= 3; i++) {
        const worker = await prisma.worker.create({
          data: {
            phone: `+91888880002${i}`,
            name: `Idempotency Worker ${i}`,
            password: 'hashedpassword',
            skill_type: 'IdempotencyPlumber',
            skill_category_id: testSkillCategoryId,
            verification_status: 'verified',
            is_online: true,
          },
        });
        testWorkerIds.push(worker.id);
      }
    });

    afterAll(async () => {
      try {
        if (testRequirementId) {
          await prisma.job_dispatch.deleteMany({ where: { requirement_id: testRequirementId } });
          await prisma.dispatch_wave.deleteMany({ where: { requirement_id: testRequirementId } });
          await prisma.job_requirement.deleteMany({ where: { id: testRequirementId } });
        }
        if (testJobId) {
          await prisma.job.deleteMany({ where: { id: testJobId } });
        }
        if (testCustomerId) {
          await prisma.customer.deleteMany({ where: { id: testCustomerId } });
        }
        for (const wid of testWorkerIds) {
          await prisma.worker_location.deleteMany({ where: { worker_id: wid } });
          await prisma.worker.deleteMany({ where: { id: wid } });
        }
        if (testSkillCategoryId) {
          await prisma.skill_category.deleteMany({ where: { id: testSkillCategoryId } });
        }
      } catch (cleanupErr) {
        console.warn('Cleanup error in dispatchOperationIdempotency.test.ts:', cleanupErr);
      } finally {
        await prisma.$disconnect();
      }
    });

    it('MUST enforce UNIQUE(operation_id) on dispatch_wave under 10 concurrent direct inserts', async () => {
      const waveNumber = 1;
      const operationId = generateDispatchOperationId({
        requirementId: testRequirementId,
        waveNumber,
      });

      // Attempt 10 simultaneous database insertions with the exact same deterministic operationId
      const attempts = Array.from({ length: 10 }, (_, i) =>
        prisma.dispatch_wave
          .create({
            data: {
              operation_id: operationId,
              requirement_id: testRequirementId,
              wave_number: waveNumber,
              workers_notified: 2,
              status: 'active',
            },
          })
          .then(() => ({ success: true, index: i }))
          .catch((err) => ({
            success: false,
            index: i,
            code: err.code,
            isConstraintViolation:
              err.code === 'P2002' ||
              String(err.message).includes('uniq_dispatch_wave_operation_id') ||
              String(err.message).includes('uniq_dispatch_wave_req_wave') ||
              String(err.message).includes('23505'),
          })),
      );

      const results = await Promise.all(attempts);

      const successes = results.filter((r) => r.success);
      const failures = results.filter((r) => !r.success);

      expect(successes.length).toBe(1);
      expect(failures.length).toBe(9);
      failures.forEach((f: any) => {
        expect(f.isConstraintViolation).toBe(true);
      });

      // Assert PostgreSQL contains exactly ONE record
      const dbCount = await prisma.dispatch_wave.count({
        where: { operation_id: operationId },
      });
      expect(dbCount).toBe(1);
    });

    it('MUST return the same logical result on sequential retry without duplicate database writes', async () => {
      const waveNumber = 2;
      const jobData: DispatchJobData = {
        requirementId: testRequirementId,
        jobId: testJobId,
        waveNumber,
        offset: 0,
      };

      (getEligibleDispatchCandidates as jest.Mock).mockResolvedValue([
        { id: testWorkerIds[0], name: 'Worker 1', worker_score: 5.0, dist_m: 1000 },
        { id: testWorkerIds[1], name: 'Worker 2', worker_score: 4.8, dist_m: 1200 },
      ]);

      // First run: executes writes
      const firstResult: DispatchOperationResult = await processDispatchJob(jobData);
      expect(firstResult.operationId).toBe(generateDispatchOperationId({ requirementId: testRequirementId, waveNumber }));
      expect(firstResult.status).toBe('created');
      expect(firstResult.waveId).toBeTruthy();

      // Second run (retry): discovers existing operation
      const secondResult: DispatchOperationResult = await processDispatchJob(jobData);
      expect(secondResult.operationId).toBe(firstResult.operationId);
      expect(secondResult.status).toBe('already_processed');
      expect(secondResult.waveId).toBe(firstResult.waveId);
      expect(secondResult.workersDispatchedCount).toBe(firstResult.workersDispatchedCount);
      expect(secondResult.workerIds).toEqual(firstResult.workerIds);

      // Verify DB wave count remains exactly 1 for wave 2
      const waveCount = await prisma.dispatch_wave.count({
        where: { requirement_id: testRequirementId, wave_number: waveNumber },
      });
      expect(waveCount).toBe(1);
    });

    it('MUST handle concurrent processDispatchJob calls and converge to the same logical result', async () => {
      const waveNumber = 3;
      const jobData: DispatchJobData = {
        requirementId: testRequirementId,
        jobId: testJobId,
        waveNumber,
        offset: 0,
      };

      (getEligibleDispatchCandidates as jest.Mock).mockResolvedValue([
        { id: testWorkerIds[0], name: 'Worker 1', worker_score: 5.0, dist_m: 1000 },
        { id: testWorkerIds[1], name: 'Worker 2', worker_score: 4.8, dist_m: 1200 },
      ]);

      // Launch 5 concurrent calls to processDispatchJob for wave 3
      const concurrentRuns = await Promise.all(
        Array.from({ length: 5 }, () => processDispatchJob(jobData)),
      );

      // Exactly 1 should be 'created', others should be 'already_processed'
      const createdRuns = concurrentRuns.filter((r) => r.status === 'created');
      const alreadyProcessedRuns = concurrentRuns.filter((r) => r.status === 'already_processed');

      expect(createdRuns.length).toBe(1);
      expect(alreadyProcessedRuns.length).toBe(4);

      const winningWaveId = createdRuns[0].waveId;
      expect(winningWaveId).toBeTruthy();

      // All 5 runs must share the exact same operationId and waveId
      concurrentRuns.forEach((run) => {
        expect(run.operationId).toBe(generateDispatchOperationId({ requirementId: testRequirementId, waveNumber }));
        expect(run.waveId).toBe(winningWaveId);
        expect(run.waveNumber).toBe(waveNumber);
      });

      // Verify exactly 1 dispatch_wave row exists in PostgreSQL
      const waveCount = await prisma.dispatch_wave.count({
        where: { requirement_id: testRequirementId, wave_number: waveNumber },
      });
      expect(waveCount).toBe(1);
    });

    it('MUST resolve duplicate BullMQ jobs with different BullMQ job IDs to the same logical result', async () => {
      const waveNumber = 4;
      const jobDataA: DispatchJobData = {
        requirementId: testRequirementId,
        jobId: testJobId,
        waveNumber,
        offset: 0,
        correlationId: 'bullmq-job-A',
      };
      const jobDataB: DispatchJobData = {
        requirementId: testRequirementId,
        jobId: testJobId,
        waveNumber,
        offset: 0,
        correlationId: 'bullmq-job-B',
      };

      (getEligibleDispatchCandidates as jest.Mock).mockResolvedValue([
        { id: testWorkerIds[0], name: 'Worker 1', worker_score: 5.0, dist_m: 1000 },
        { id: testWorkerIds[1], name: 'Worker 2', worker_score: 4.8, dist_m: 1200 },
      ]);

      const resA = await processDispatchJob(jobDataA);
      const resB = await processDispatchJob(jobDataB);

      expect(resA.status).toBe('created');
      expect(resB.status).toBe('already_processed');
      expect(resA.operationId).toBe(resB.operationId);
      expect(resA.waveId).toBe(resB.waveId);

      const dbWaves = await prisma.dispatch_wave.findMany({
        where: { requirement_id: testRequirementId, wave_number: waveNumber },
      });
      expect(dbWaves.length).toBe(1);
    });
  });

  // ── 3. Processor Edge Cases & Failure Scenarios ─────────────────────────
  describe('3. Processor Edge Cases & Failure Scenarios', () => {
    it('MUST return skipped_not_found if requirement does not exist', async () => {
      const fakeReqId = '99999999-9999-4999-8999-999999999999';
      const result = await processDispatchJob({
        requirementId: fakeReqId,
        jobId: 'fake-job-id',
        waveNumber: 1,
      });

      expect(result.status).toBe('skipped_not_found');
      expect(result.waveId).toBeNull();
      expect(result.workersDispatchedCount).toBe(0);
    });

    it('MUST return skipped_terminal if requirement is already in FILLED state', async () => {
      // Create filled requirement fixture
      const customer = await prisma.customer.create({
        data: {
          phone: '+919999900099',
          name: 'Terminal Test Customer',
          password: 'hashedpassword',
        },
      });

      const job = await prisma.job.create({
        data: {
          customer_id: customer.id,
          status: 'BOOKED',
          location: 'Delhi',
          latitude: 28.6139,
          longitude: 77.209,
        },
      });

      const req = await prisma.job_requirement.create({
        data: {
          job_id: job.id,
          skill_type: 'Painter',
          worker_count_needed: 1,
          worker_count_filled: 1,
          status: 'FILLED',
        },
      });

      const result = await processDispatchJob({
        requirementId: req.id,
        jobId: job.id,
        waveNumber: 1,
      });

      expect(result.status).toBe('skipped_terminal');
      expect(result.waveId).toBeNull();

      // Clean up
      await prisma.job_requirement.delete({ where: { id: req.id } });
      await prisma.job.delete({ where: { id: job.id } });
      await prisma.customer.delete({ where: { id: customer.id } });
    });
  });
});
