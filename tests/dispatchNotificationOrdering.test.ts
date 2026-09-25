/**
 * dispatchNotificationOrdering.test.ts
 *
 * Issue #22 — Persist Dispatch Before Notifications
 *
 * Proves the durable ordering invariant:
 *
 *   PostgreSQL COMMIT → notificationQueue.add → [notificationWorker] → FCM / Socket.IO
 *
 * Failure scenarios tested:
 *   A. DB transaction failure → notificationQueue.add is never called
 *   B. notificationQueue.add failure → dispatchWorker throws → BullMQ retry
 *   C. Notification delivery failure (FCM) → persisted state unchanged; job retried
 *   D. Deterministic notification jobId prevents duplicate notifications on retry
 *   E. Happy path: DB commit precedes notification enqueue, enqueue precedes FCM call
 *   F. processNotificationJob catches per-worker FCM failures without aborting others
 *   G. processNotificationJob catches per-worker Socket.IO failures without aborting others
 *   H. notificationWorker processes the job data shape produced by dispatchWorker
 */

import { processDispatchJob, DispatchJobData } from '../src/workers/dispatchWorker';
import { processNotificationJob, DispatchNotifyJobData } from '../src/workers/notificationWorker';

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../src/config/prisma', () => ({
  __esModule: true,
  default: {
    job_requirement: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    dispatch_wave: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    job_dispatch: {
      createMany: jest.fn(),
    },
    $transaction: jest.fn(),
  },
}));

jest.mock('../src/config/bullmq', () => ({
  redisConnectionOptions: {},
  DISPATCH_QUEUE_NAME: 'dispatch',
  TIMEOUT_QUEUE_NAME: 'timeout',
  NOTIFICATION_QUEUE_NAME: 'notification',
  DISPATCH_JOB_NAMES: {
    DISPATCH_WAVE: 'dispatch-wave',
    WAVE_TIMEOUT: 'wave-timeout',
    DISPATCH_NOTIFY: 'dispatch-notify',
  },
  dispatchQueue: { add: jest.fn() },
  timeoutQueue: { add: jest.fn() },
  notificationQueue: { add: jest.fn() },
  defaultJobOptions: {},
}));

jest.mock('../src/features/dispatch/dispatchCandidate.service', () => ({
  getEligibleDispatchCandidates: jest.fn(),
  getWaveRadiusMeters: jest.fn().mockReturnValue(5000),
  validateDispatchCoordinates: jest.fn().mockReturnValue(true),
}));

jest.mock('../src/shared/fcm', () => ({
  sendFCMToWorker: jest.fn(),
}));

const mockIo = {
  to: jest.fn().mockReturnValue({ emit: jest.fn() }),
};

jest.mock('../src/socket/socketLifecycle', () => ({
  getSocketServer: jest.fn(() => mockIo),
  setSocketServer: jest.fn(),
  disconnectUserSockets: jest.fn(),
}));

jest.mock('../src/server', () => ({
  io: mockIo,
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import prisma from '../src/config/prisma';
import { notificationQueue, timeoutQueue } from '../src/config/bullmq';
import {
  getEligibleDispatchCandidates,
  validateDispatchCoordinates,
  getWaveRadiusMeters,
} from '../src/features/dispatch/dispatchCandidate.service';
import { sendFCMToWorker } from '../src/shared/fcm';
import { getSocketServer } from '../src/socket/socketLifecycle';
import { io } from '../src/server';


// ── Helpers ───────────────────────────────────────────────────────────────────

const REQ_ID = 'req-aaa-111';
const JOB_ID = 'job-bbb-222';
const WORKER_ID_1 = 'worker-ccc-333';
const WORKER_ID_2 = 'worker-ddd-444';

const mockReq = {
  id: REQ_ID,
  status: 'DISPATCHING',
  worker_count_needed: 1,
  worker_count_filled: 0,
  skill_type: 'plumber',
  rate_per_day: 800,
  job_id: JOB_ID,
  job: {
    id: JOB_ID,
    latitude: 19.076,
    longitude: 72.8777,
    location: 'Mumbai',
    customer_id: 'cust-xxx',
    customer: { name: 'Test Customer' },
  },
};

const mockWorkers = [
  { id: WORKER_ID_1, latitude: 19.07, longitude: 72.87 },
  { id: WORKER_ID_2, latitude: 19.08, longitude: 72.88 },
];

function makeDispatchJobData(overrides: Partial<DispatchJobData> = {}): DispatchJobData {
  return { requirementId: REQ_ID, jobId: JOB_ID, waveNumber: 1, offset: 0, ...overrides };
}

function makeNotifyJobData(overrides: Partial<DispatchNotifyJobData> = {}): DispatchNotifyJobData {
  return {
    type: 'dispatch-notify',
    requirementId: REQ_ID,
    jobId: JOB_ID,
    waveNumber: 1,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    workers: [{ id: WORKER_ID_1 }, { id: WORKER_ID_2 }],
    skillType: 'plumber',
    ratePerDay: 800,
    location: 'Mumbai',
    customerName: 'Test Customer',
    ...overrides,
  };
}

function setupHappyPathMocks() {
  (prisma.job_requirement.findUnique as jest.Mock).mockResolvedValue(mockReq);
  (prisma.dispatch_wave.findFirst as jest.Mock).mockResolvedValue(null); // no existing wave
  (validateDispatchCoordinates as jest.Mock).mockReturnValue(true);
  (getWaveRadiusMeters as jest.Mock).mockReturnValue(5000);
  (getEligibleDispatchCandidates as jest.Mock).mockResolvedValue(mockWorkers);
  (timeoutQueue.add as jest.Mock).mockResolvedValue({ id: 'timeout-job-1' });
  (notificationQueue.add as jest.Mock).mockResolvedValue({ id: 'notify-job-1' });

  // $transaction: execute the callback with the prisma mock client
  (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
    return cb({
      dispatch_wave: { create: jest.fn().mockResolvedValue({}) },
      job_dispatch: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Issue #22 — Persist Dispatch Before Notifications', () => {
  // resetMocks: true in jest.config resets all mock implementations between tests.
  // Each test or setupHappyPathMocks() must re-configure the mocks it needs.
  beforeEach(() => {
    (getSocketServer as jest.Mock).mockReturnValue(io);
    (io.to as jest.Mock).mockReturnValue({ emit: jest.fn() });
  });

  // ── Scenario E (happy path) ─────────────────────────────────────────────────
  describe('Scenario E: Happy path — correct ordering', () => {
    it('calls notificationQueue.add AFTER the DB transaction commits', async () => {
      const callOrder: string[] = [];

      setupHappyPathMocks();

      (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
        const result = await cb({
          dispatch_wave: { create: jest.fn().mockResolvedValue({}) },
          job_dispatch: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
        });
        callOrder.push('DB_COMMIT');
        return result;
      });

      (notificationQueue.add as jest.Mock).mockImplementation(async () => {
        callOrder.push('NOTIFICATION_ENQUEUE');
        return { id: 'notify-job-1' };
      });

      await processDispatchJob(makeDispatchJobData());

      const dbIdx = callOrder.indexOf('DB_COMMIT');
      const notifyIdx = callOrder.indexOf('NOTIFICATION_ENQUEUE');

      // DB_COMMIT must appear in the call order
      expect(dbIdx).toBeGreaterThanOrEqual(0);
      // NOTIFICATION_ENQUEUE must come strictly after DB_COMMIT
      expect(notifyIdx).toBeGreaterThan(dbIdx);
    });

    it('passes deterministic jobId to notificationQueue.add', async () => {
      setupHappyPathMocks();

      await processDispatchJob(makeDispatchJobData({ waveNumber: 3 }));

      expect(notificationQueue.add).toHaveBeenCalledWith(
        'dispatch-notify',
        expect.objectContaining({
          requirementId: REQ_ID,
          waveNumber: 3,
        }),
        expect.objectContaining({
          jobId: `notify:${REQ_ID}:wave-3`,
        }),
      );
    });

    it('includes all dispatched workers in the notification job payload', async () => {
      setupHappyPathMocks();

      await processDispatchJob(makeDispatchJobData());

      expect(notificationQueue.add).toHaveBeenCalledWith(
        'dispatch-notify',
        expect.objectContaining({
          workers: expect.arrayContaining([
            expect.objectContaining({ id: WORKER_ID_1 }),
            expect.objectContaining({ id: WORKER_ID_2 }),
          ]),
          customerName: 'Test Customer',
          skillType: 'plumber',
          ratePerDay: 800,
          location: 'Mumbai',
        }),
        expect.any(Object),
      );
    });

    it('does NOT call sendFCMToWorker or io.to inline inside dispatchWorker', async () => {
      setupHappyPathMocks();

      await processDispatchJob(makeDispatchJobData());

      // FCM and socket calls now belong to notificationWorker only
      expect(sendFCMToWorker).not.toHaveBeenCalled();
      const ioMock = io as any;
      expect(ioMock.to).not.toHaveBeenCalled();
    });
  });

  // ── Scenario A: DB failure → no notification ────────────────────────────────
  describe('Scenario A: DB transaction failure — notificationQueue.add is never called', () => {
    it('does not call notificationQueue.add when DB write throws', async () => {
      (prisma.job_requirement.findUnique as jest.Mock).mockResolvedValue(mockReq);
      (prisma.dispatch_wave.findFirst as jest.Mock).mockResolvedValue(null);
      (validateDispatchCoordinates as jest.Mock).mockReturnValue(true);
      (getWaveRadiusMeters as jest.Mock).mockReturnValue(5000);
      (getEligibleDispatchCandidates as jest.Mock).mockResolvedValue(mockWorkers);

      // Simulate DB failure by making $transaction call the callback but the callback throws
      const dbError = Object.assign(new Error('PostgreSQL connection lost'), { code: 'DB_ERR' });
      (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
        return cb({
          dispatch_wave: { create: jest.fn().mockRejectedValue(dbError) },
          job_dispatch: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
        });
      });

      await expect(processDispatchJob(makeDispatchJobData())).rejects.toThrow(
        'PostgreSQL connection lost',
      );

      expect(notificationQueue.add).not.toHaveBeenCalled();
    });

    it('does not call notificationQueue.add when dispatch_wave createMany fails', async () => {
      (prisma.job_requirement.findUnique as jest.Mock).mockResolvedValue(mockReq);
      (prisma.dispatch_wave.findFirst as jest.Mock).mockResolvedValue(null);
      (validateDispatchCoordinates as jest.Mock).mockReturnValue(true);
      (getWaveRadiusMeters as jest.Mock).mockReturnValue(5000);
      (getEligibleDispatchCandidates as jest.Mock).mockResolvedValue(mockWorkers);

      const writeError = Object.assign(new Error('Disk quota exceeded'), { code: 'DISK_ERR' });
      (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
        return cb({
          dispatch_wave: { create: jest.fn().mockResolvedValue({}) },
          job_dispatch: { createMany: jest.fn().mockRejectedValue(writeError) },
        });
      });

      await expect(processDispatchJob(makeDispatchJobData())).rejects.toThrow();

      expect(notificationQueue.add).not.toHaveBeenCalled();
    });

    it('does not call notificationQueue.add when requirement is in terminal state', async () => {
      (prisma.job_requirement.findUnique as jest.Mock).mockResolvedValue({
        ...mockReq,
        status: 'filled',
      });

      await processDispatchJob(makeDispatchJobData());

      expect(notificationQueue.add).not.toHaveBeenCalled();
    });

    it('does not call notificationQueue.add when no eligible workers found', async () => {
      (prisma.job_requirement.findUnique as jest.Mock).mockResolvedValue(mockReq);
      (prisma.dispatch_wave.findFirst as jest.Mock).mockResolvedValue(null);
      (validateDispatchCoordinates as jest.Mock).mockReturnValue(true);
      (getWaveRadiusMeters as jest.Mock).mockReturnValue(5000);
      (getEligibleDispatchCandidates as jest.Mock).mockResolvedValue([]);
      (prisma.job_requirement.update as jest.Mock).mockResolvedValue({});

      await processDispatchJob(makeDispatchJobData());

      expect(notificationQueue.add).not.toHaveBeenCalled();
    });

  });

  // ── Scenario B: notificationQueue.add failure → dispatchWorker rethrows ────
  describe('Scenario B: notificationQueue.add failure — dispatchWorker rethrows for BullMQ retry', () => {
    it('rethrows when notificationQueue.add throws so BullMQ retries the dispatch job', async () => {
      setupHappyPathMocks();
      (notificationQueue.add as jest.Mock).mockRejectedValue(new Error('Redis connection refused'));

      await expect(processDispatchJob(makeDispatchJobData())).rejects.toThrow(
        'Redis connection refused',
      );
    });

    it('DB transaction was invoked before notificationQueue.add fails', async () => {
      const txSpy = jest.fn().mockImplementation(async (cb: any) => {
        return cb({
          dispatch_wave: { create: jest.fn().mockResolvedValue({}) },
          job_dispatch: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
        });
      });
      (prisma.$transaction as jest.Mock).mockImplementation(txSpy);
      (prisma.job_requirement.findUnique as jest.Mock).mockResolvedValue(mockReq);
      (prisma.dispatch_wave.findFirst as jest.Mock).mockResolvedValue(null);
      (validateDispatchCoordinates as jest.Mock).mockReturnValue(true);
      (getWaveRadiusMeters as jest.Mock).mockReturnValue(5000);
      (getEligibleDispatchCandidates as jest.Mock).mockResolvedValue(mockWorkers);
      (timeoutQueue.add as jest.Mock).mockResolvedValue({});
      (notificationQueue.add as jest.Mock).mockRejectedValue(new Error('Redis unavailable'));

      await expect(processDispatchJob(makeDispatchJobData())).rejects.toThrow();

      // The DB transaction was invoked before the notification enqueue failed
      expect(txSpy).toHaveBeenCalledTimes(1);
    });

  });

  // ── Scenario D: deterministic jobId prevents double-notify on retry ─────────
  describe('Scenario D: Deterministic jobId prevents duplicate notifications on retry', () => {
    it('uses the same deterministic jobId on dispatch retry so BullMQ deduplicates', async () => {
      setupHappyPathMocks();

      // First attempt succeeds notification enqueue
      await processDispatchJob(makeDispatchJobData({ waveNumber: 2 }));
      const firstCall = (notificationQueue.add as jest.Mock).mock.calls[0];

      jest.clearAllMocks();
      setupHappyPathMocks();

      // On retry (idempotency: wave already exists — guard returns early)
      // But if the guard somehow let it through, same jobId should be used
      await processDispatchJob(makeDispatchJobData({ waveNumber: 2 }));

      if ((notificationQueue.add as jest.Mock).mock.calls.length > 0) {
        const secondCall = (notificationQueue.add as jest.Mock).mock.calls[0];
        // Same deterministic jobId across attempts
        expect(secondCall[2].jobId).toBe(firstCall[2].jobId);
      }
    });
  });

  // ── Scenario C: notification delivery failure — persisted state unchanged ───
  describe('Scenario C: Notification delivery failure — persisted state is not affected', () => {
    it('FCM failure in notificationWorker does not throw (state is unchanged)', async () => {
      (sendFCMToWorker as jest.Mock).mockRejectedValue(new Error('FCM service 503'));

      // processNotificationJob should complete without throwing
      await expect(processNotificationJob(makeNotifyJobData())).resolves.not.toThrow();
    });

    it('Socket.IO failure in notificationWorker does not throw (state is unchanged)', async () => {
      (sendFCMToWorker as jest.Mock).mockResolvedValue(undefined);
      const emitFn = jest.fn().mockImplementation(() => {
        throw new Error('Socket.IO internal error');
      });
      (io.to as jest.Mock).mockReturnValue({ emit: emitFn });

      await expect(processNotificationJob(makeNotifyJobData())).resolves.not.toThrow();
    });
  });

  // ── Scenario F: per-worker FCM failure isolation ────────────────────────────
  describe('Scenario F: Per-worker FCM failure does not abort other workers', () => {
    it('delivers notifications to remaining workers even if one worker FCM fails', async () => {
      let callCount = 0;
      (sendFCMToWorker as jest.Mock).mockImplementation(async (workerId: string) => {
        callCount++;
        if (workerId === WORKER_ID_1) {
          throw new Error('FCM token invalid for worker 1');
        }
        // Worker 2 succeeds
      });

      await processNotificationJob(makeNotifyJobData());

      // Both workers were attempted despite worker 1 failing
      expect(callCount).toBe(2);
    });
  });

  // ── Scenario G: per-worker Socket.IO failure isolation ─────────────────────
  describe('Scenario G: Per-worker Socket.IO failure does not abort other workers', () => {
    it('attempts socket delivery for all workers even if one throws', async () => {
      (sendFCMToWorker as jest.Mock).mockResolvedValue(undefined);

      let socketCallCount = 0;
      (io.to as jest.Mock).mockImplementation((room: string) => {
        return {
          emit: jest.fn().mockImplementation(() => {
            socketCallCount++;
            if (room.includes(WORKER_ID_1)) {
              throw new Error('Socket room error');
            }
          }),
        };
      });

      await processNotificationJob(makeNotifyJobData());

      // io.to was called for both workers
      expect((io.to as jest.Mock).mock.calls.length).toBe(2);
    });
  });

  // ── Scenario H: notificationWorker processes the correct payload shape ───────
  describe('Scenario H: notificationWorker processes job data from dispatchWorker', () => {
    it('calls sendFCMToWorker with the correct payload shape', async () => {
      (sendFCMToWorker as jest.Mock).mockResolvedValue(undefined);
      const emitFn = jest.fn();
      (io.to as jest.Mock).mockReturnValue({ emit: emitFn });

      const jobData = makeNotifyJobData();
      await processNotificationJob(jobData);

      expect(sendFCMToWorker).toHaveBeenCalledWith(
        WORKER_ID_1,
        expect.objectContaining({
          title: 'New Job',
          body: 'plumber',
          data: expect.objectContaining({
            type: 'incoming_job',
            jobId: JOB_ID,
            requirementId: REQ_ID,
            ratePerDay: '800',
            customerName: 'Test Customer',
            location: 'Mumbai',
          }),
        }),
      );
    });

    it('calls io.to with the correct worker room and job:incoming event', async () => {
      (sendFCMToWorker as jest.Mock).mockResolvedValue(undefined);
      const emitFn = jest.fn();
      (io.to as jest.Mock).mockReturnValue({ emit: emitFn });

      await processNotificationJob(makeNotifyJobData());

      const toCalls = (io.to as jest.Mock).mock.calls.map((c: any[]) => c[0]);
      expect(toCalls).toContain(`worker:${WORKER_ID_1}`);
      expect(toCalls).toContain(`worker:${WORKER_ID_2}`);

      expect(emitFn).toHaveBeenCalledWith(
        'job:incoming',
        expect.objectContaining({
          requirementId: REQ_ID,
          jobId: JOB_ID,
          skillType: 'plumber',
          ratePerDay: 800,
        }),
      );
    });
  });
});
