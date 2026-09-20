import prisma from '../src/config/prisma';
import { dispatchQueue, timeoutQueue } from '../src/config/bullmq';
import { processDispatchJob } from '../src/workers/dispatchWorker';
import { processTimeoutJob } from '../src/workers/timeoutWorker';
import { reconcileDispatchState } from '../src/features/dispatch/dispatchReconciliationService';
import { sendFCMToWorker } from '../src/shared/fcm';
import { io } from '../src/server';
import { RequirementStatus } from '../src/features/jobs/requirementStateMachine';
import { JobStatus } from '../src/features/jobs/jobStateMachine';
import { getEligibleDispatchCandidates } from '../src/features/dispatch/dispatchCandidate.service';

// Mock dependencies
jest.mock('../src/config/prisma', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    job: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    job_requirement: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    dispatch_wave: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    job_dispatch: {
      findMany: jest.fn(),
      createMany: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

jest.mock('../src/config/bullmq', () => ({
  redisConnectionOptions: {},
  dispatchQueue: {
    add: jest.fn().mockResolvedValue({ id: 'mock-dispatch-job' }),
  },
  timeoutQueue: {
    add: jest.fn().mockResolvedValue({ id: 'mock-timeout-job' }),
  },
}));

jest.mock('../src/shared/fcm', () => ({
  sendFCMNotification: jest.fn().mockResolvedValue({}),
  sendFCMToWorker: jest.fn().mockResolvedValue([{ success: true }]),
}));

jest.mock('../src/server', () => ({
  io: {
    to: jest.fn().mockReturnValue({
      emit: jest.fn(),
    }),
  },
}));

jest.mock('../src/features/dispatch/dispatchCandidate.service', () => {
  const actual = jest.requireActual('../src/features/dispatch/dispatchCandidate.service');
  return {
    ...actual,
    getEligibleDispatchCandidates: jest.fn().mockImplementation(async () => [
      {
        id: 'worker-1',
        name: 'Worker One',
        device_token: 'token-1',
        worker_score: 5.0,
        is_online: true,
        deleted_at: null,
        verification_status: 'verified',
        skill_type: 'Plumber',
        lat: 28.5,
        lon: 77.2,
        dist_m: 1500,
      },
    ]),
  };
});

describe('Issue #21: BullMQ Dispatch Lifecycle & Startup Reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) => {
      return callback(prisma);
    });
    (getEligibleDispatchCandidates as jest.Mock).mockResolvedValue([
      {
        id: 'worker-1',
        name: 'Worker One',
        device_token: 'token-1',
        worker_score: 5.0,
        is_online: true,
        deleted_at: null,
        verification_status: 'verified',
        skill_type: 'Plumber',
        lat: 28.5,
        lon: 77.2,
        dist_m: 1500,
      },
    ]);
    (dispatchQueue.add as jest.Mock).mockResolvedValue({ id: 'mock-dispatch-job' });
    (timeoutQueue.add as jest.Mock).mockResolvedValue({ id: 'mock-timeout-job' });
    (sendFCMToWorker as jest.Mock).mockResolvedValue([{ success: true }]);
    (io.to as jest.Mock).mockReturnValue({ emit: jest.fn() });
  });

  describe('1. Persistence-Before-Notification Invariant', () => {
    it('MUST persist dispatch_wave and job_dispatch BEFORE sending FCM notifications', async () => {
      const requirementId = 'req-persist-first';
      const jobId = 'job-persist-first';

      (prisma.job_requirement.findUnique as jest.Mock).mockResolvedValue({
        id: requirementId,
        job_id: jobId,
        skill_type: 'Plumber',
        worker_count_needed: 1,
        worker_count_filled: 0,
        status: 'DISPATCHING',
        job: {
          id: jobId,
          latitude: 28.5,
          longitude: 77.2,
          location: 'Delhi',
          customer: { name: 'Test Customer' },
        },
      });

      (prisma.dispatch_wave.findFirst as jest.Mock).mockResolvedValue(null);

      const callOrder: string[] = [];

      (prisma.dispatch_wave.create as jest.Mock).mockImplementation(async () => {
        callOrder.push('dispatch_wave.create');
        return { id: 'wave-1' };
      });

      (prisma.job_dispatch.createMany as jest.Mock).mockImplementation(async () => {
        callOrder.push('job_dispatch.createMany');
        return { count: 1 };
      });

      (timeoutQueue.add as jest.Mock).mockImplementation(async () => {
        callOrder.push('timeoutQueue.add');
        return { id: 'mock-timeout' };
      });

      (sendFCMToWorker as jest.Mock).mockImplementation(async () => {
        callOrder.push('sendFCMToWorker');
        return [{ success: true }];
      });

      await processDispatchJob({
        requirementId,
        jobId,
        waveNumber: 1,
        offset: 0,
      });

      // Assert strict ordering: Persistence -> Queue timeout -> Notifications
      expect(callOrder).toEqual([
        'dispatch_wave.create',
        'job_dispatch.createMany',
        'timeoutQueue.add',
        'sendFCMToWorker',
      ]);

      // Assert timeoutQueue was queued with deterministic jobId and 30s delay
      expect(timeoutQueue.add).toHaveBeenCalledWith(
        'wave-timeout',
        expect.objectContaining({
          requirementId,
          jobId,
          waveNumber: 1,
        }),
        expect.objectContaining({
          delay: 30_000,
          jobId: `wave-timeout:${requirementId}:wave-1`,
        }),
      );
    });

    it('MUST idempotently skip execution if wave already exists in database', async () => {
      const requirementId = 'req-dup-wave';
      const jobId = 'job-dup-wave';

      (prisma.job_requirement.findUnique as jest.Mock).mockResolvedValue({
        id: requirementId,
        job_id: jobId,
        skill_type: 'Plumber',
        worker_count_needed: 1,
        status: 'DISPATCHING',
        job: {
          id: jobId,
          latitude: 28.5,
          longitude: 77.2,
          customer: { name: 'Customer' },
        },
      });

      // Existing wave found
      (prisma.dispatch_wave.findFirst as jest.Mock).mockResolvedValue({
        id: 'existing-wave-id',
        wave_number: 1,
      });

      await processDispatchJob({
        requirementId,
        jobId,
        waveNumber: 1,
        offset: 0,
      });

      expect(prisma.dispatch_wave.create).not.toHaveBeenCalled();
      expect(prisma.job_dispatch.createMany).not.toHaveBeenCalled();
      expect(timeoutQueue.add).not.toHaveBeenCalled();
      expect(sendFCMToWorker).not.toHaveBeenCalled();
    });

    it('MUST safely no-op if requirement is already FILLED', async () => {
      const requirementId = 'req-already-filled';

      (prisma.job_requirement.findUnique as jest.Mock).mockResolvedValue({
        id: requirementId,
        status: 'FILLED',
        job: { latitude: 28.5, longitude: 77.2, customer: {} },
      });

      await processDispatchJob({
        requirementId,
        jobId: 'job-filled',
        waveNumber: 1,
        offset: 0,
      });

      expect(prisma.dispatch_wave.create).not.toHaveBeenCalled();
      expect(sendFCMToWorker).not.toHaveBeenCalled();
    });
  });

  describe('2. Timeout Worker & Progressive Wave Enqueuing', () => {
    it('MUST close wave, mark pending dispatches timeout, and enqueue next wave in BullMQ', async () => {
      const requirementId = 'req-timeout-1';
      const jobId = 'job-timeout-1';

      (prisma.job_requirement.findUnique as jest.Mock).mockResolvedValue({
        id: requirementId,
        status: 'DISPATCHING',
        job: { id: jobId, customer_id: 'cust-1' },
      });

      (prisma.job_dispatch.updateMany as jest.Mock).mockResolvedValue({ count: 2 });
      (prisma.dispatch_wave.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await processTimeoutJob({
        requirementId,
        jobId,
        waveNumber: 1,
        totalWorkersFound: 10,
        offset: 0,
        waveSize: 2,
      });

      // 1. Pending dispatches marked timeout
      expect(prisma.job_dispatch.updateMany).toHaveBeenCalledWith({
        where: {
          requirement_id: requirementId,
          wave_number: 1,
          status: 'pending',
        },
        data: expect.objectContaining({ status: 'timeout' }),
      });

      // 2. Current wave closed
      expect(prisma.dispatch_wave.updateMany).toHaveBeenCalledWith({
        where: { requirement_id: requirementId, wave_number: 1 },
        data: expect.objectContaining({ status: 'exhausted' }),
      });

      // 3. Wave 2 enqueued via BullMQ with deterministic jobId
      expect(dispatchQueue.add).toHaveBeenCalledWith(
        'dispatch-wave',
        expect.objectContaining({
          requirementId,
          jobId,
          waveNumber: 2,
          offset: 2,
        }),
        expect.objectContaining({
          jobId: `dispatch:${requirementId}:wave-2`,
        }),
      );
    });

    it('MUST mark requirement NO_WORKERS_AVAILABLE when candidates are exhausted', async () => {
      const requirementId = 'req-exhausted';
      const jobId = 'job-exhausted';

      (prisma.job_requirement.findUnique as jest.Mock).mockResolvedValue({
        id: requirementId,
        status: 'DISPATCHING',
        job: { id: jobId, customer_id: 'cust-1' },
      });

      await processTimeoutJob({
        requirementId,
        jobId,
        waveNumber: 2,
        totalWorkersFound: 2,
        offset: 0,
        waveSize: 2, // nextOffset 2 >= totalWorkersFound 2 -> exhausted
      });

      expect(prisma.job_requirement.update).toHaveBeenCalledWith({
        where: { id: requirementId },
        data: { status: RequirementStatus.NO_WORKERS_AVAILABLE },
      });

      expect(dispatchQueue.add).not.toHaveBeenCalled();
    });

    it('MUST safely no-op in timeout worker if requirement was filled prior to timeout', async () => {
      (prisma.job_requirement.findUnique as jest.Mock).mockResolvedValue({
        id: 'req-filled-prior',
        status: 'FILLED',
        job: { customer_id: 'cust-1' },
      });

      await processTimeoutJob({
        requirementId: 'req-filled-prior',
        jobId: 'job-1',
        waveNumber: 1,
        totalWorkersFound: 5,
        offset: 0,
        waveSize: 2,
      });

      expect(prisma.job_dispatch.updateMany).not.toHaveBeenCalled();
      expect(dispatchQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('3. Startup Reconciliation Service', () => {
    it('MUST reconcile expired in-flight wave by closing it and enqueuing the next wave', async () => {
      const pastNotifiedAt = new Date(Date.now() - 40_000); // 40 seconds ago (> 30s timeout)

      (prisma.job_requirement.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'req-reconcile-expired',
          status: 'DISPATCHING',
          worker_count_needed: 1,
          worker_count_filled: 0,
          job: { id: 'job-reconcile', status: JobStatus.OPEN, customer_id: 'cust-1' },
          dispatch_wave: [
            {
              id: 'wave-1',
              wave_number: 1,
              status: 'active',
              notified_at: pastNotifiedAt,
              workers_notified: 2,
            },
          ],
          job_dispatch: [{ id: 'disp-1', status: 'pending' }],
        },
      ]);

      const report = await reconcileDispatchState();

      expect(report.scannedRequirements).toBe(1);
      expect(report.expiredWavesClosed).toBe(1);
      expect(report.missingWavesScheduled).toBe(1);

      // Pending dispatch marked timeout
      expect(prisma.job_dispatch.updateMany).toHaveBeenCalledWith({
        where: {
          requirement_id: 'req-reconcile-expired',
          wave_number: 1,
          status: 'pending',
        },
        data: expect.objectContaining({ status: 'timeout' }),
      });

      // Wave closed as exhausted
      expect(prisma.dispatch_wave.update).toHaveBeenCalledWith({
        where: { id: 'wave-1' },
        data: expect.objectContaining({ status: 'exhausted' }),
      });

      // Next wave enqueued with deterministic jobId
      expect(dispatchQueue.add).toHaveBeenCalledWith(
        'dispatch-wave',
        expect.objectContaining({
          requirementId: 'req-reconcile-expired',
          waveNumber: 2,
        }),
        expect.objectContaining({
          jobId: 'dispatch:req-reconcile-expired:wave-2',
        }),
      );
    });

    it('MUST restore timeout job for an unexpired active wave', async () => {
      const recentNotifiedAt = new Date(Date.now() - 10_000); // 10s ago (< 30s timeout, ~20s left)

      (prisma.job_requirement.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'req-unexpired',
          status: 'DISPATCHING',
          worker_count_needed: 1,
          worker_count_filled: 0,
          job: { id: 'job-unexpired', status: JobStatus.OPEN, customer_id: 'cust-1' },
          dispatch_wave: [
            {
              id: 'wave-unexpired',
              wave_number: 1,
              status: 'active',
              notified_at: recentNotifiedAt,
              workers_notified: 2,
            },
          ],
          job_dispatch: [{ id: 'disp-unexpired', status: 'pending' }],
        },
      ]);

      const report = await reconcileDispatchState();

      expect(report.activeTimeoutsRestored).toBe(1);
      expect(report.expiredWavesClosed).toBe(0);

      // Restored timeout job in timeoutQueue with remaining delay
      expect(timeoutQueue.add).toHaveBeenCalledWith(
        'wave-timeout',
        expect.objectContaining({
          requirementId: 'req-unexpired',
          waveNumber: 1,
        }),
        expect.objectContaining({
          jobId: 'wave-timeout:req-unexpired:wave-1',
          delay: expect.any(Number),
        }),
      );
    });

    it('MUST enqueue wave 1 for an orphaned requirement with zero waves', async () => {
      (prisma.job_requirement.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'req-no-waves',
          status: 'DISPATCHING',
          worker_count_needed: 2,
          worker_count_filled: 0,
          job: { id: 'job-no-waves', status: JobStatus.OPEN, customer_id: 'cust-1' },
          dispatch_wave: [],
          job_dispatch: [],
        },
      ]);

      const report = await reconcileDispatchState();

      expect(report.missingWavesScheduled).toBe(1);
      expect(dispatchQueue.add).toHaveBeenCalledWith(
        'dispatch-wave',
        expect.objectContaining({
          requirementId: 'req-no-waves',
          waveNumber: 1,
          offset: 0,
        }),
        expect.objectContaining({
          jobId: 'dispatch:req-no-waves:wave-1',
        }),
      );
    });

    it('MUST be idempotent when run consecutively', async () => {
      (prisma.job_requirement.findMany as jest.Mock).mockResolvedValue([]);

      const report1 = await reconcileDispatchState();
      const report2 = await reconcileDispatchState();

      expect(report1.scannedRequirements).toBe(0);
      expect(report2.scannedRequirements).toBe(0);
      expect(report1.errors).toEqual([]);
      expect(report2.errors).toEqual([]);
    });
  });
});
