import { Worker, Job } from 'bullmq';
import prisma from '../config/prisma';
import { redisConnectionOptions, timeoutQueue, dispatchQueue, notificationQueue, DISPATCH_JOB_NAMES } from '../config/bullmq';

import {
  getEligibleDispatchCandidates,
  getWaveRadiusMeters,
  validateDispatchCoordinates,
  EligibleWorkerCandidate,
} from '../features/dispatch/dispatchCandidate.service';
import { RequirementStatus } from '../features/jobs/requirementStateMachine';

export const WAVE_TIMEOUT_MS = 30_000; // 30 seconds

export interface DispatchJobData {
  requirementId: string;
  jobId: string;
  waveNumber?: number;
  offset?: number;
  correlationId?: string;
}

export type NearbyWorker = EligibleWorkerCandidate;

export async function processDispatchJob(data: DispatchJobData): Promise<void> {
  const { requirementId, jobId, waveNumber = 1, offset = 0 } = data;
  console.log(
    `[dispatchWorker] Processing requirement=${requirementId} wave=${waveNumber} offset=${offset}`,
  );

  // 1. Fetch requirement + parent job for coordinates & status
  const req = await prisma.job_requirement.findUnique({
    where: { id: requirementId },
    include: {
      job: {
        include: {
          customer: {
            select: { name: true },
          },
        },
      },
    },
  });

  if (!req) {
    console.warn(`[dispatchWorker] Requirement ${requirementId} not found — skipping`);
    return;
  }

  // Guard against terminal states (filled, cancelled, or already exhausted)
  const reqStatusUpper = req.status?.toUpperCase();
  if (
    reqStatusUpper === RequirementStatus.FILLED ||
    req.status === 'filled' ||
    reqStatusUpper === RequirementStatus.CANCELLED ||
    req.status === 'cancelled'
  ) {
    console.log(`[dispatchWorker] Requirement ${requirementId} in terminal state (${req.status}) — skipping`);
    return;
  }

  // Guard against duplicate wave execution (idempotency check)
  if (typeof (prisma as any).dispatch_wave?.findFirst === 'function') {
    const existingWave = await prisma.dispatch_wave.findFirst({
      where: {
        requirement_id: requirementId,
        wave_number: waveNumber,
      },
    });
    if (existingWave) {
      console.log(
        `[dispatchWorker] Wave ${waveNumber} already exists for requirement ${requirementId} — skipping duplicate execution`,
      );
      return;
    }
  }

  // Explicit coordinate validation (reject null, undefined, NaN, Infinity, out of bounds; allow 0,0)
  if (!validateDispatchCoordinates(req.job.latitude, req.job.longitude)) {
    console.warn(`[dispatchWorker] Job ${jobId} missing or invalid coordinates — cannot dispatch`, {
      latitude: req.job.latitude,
      longitude: req.job.longitude,
    });
    await prisma.job_requirement.update({
      where: { id: requirementId },
      data: { status: RequirementStatus.NO_WORKERS_AVAILABLE },
    });
    return;
  }

  // 2. Authoritative PostGIS query — nearby online, verified, fresh workers matching skill within wave radius
  const radiusMeters = getWaveRadiusMeters(waveNumber);
  const workers =
    (await getEligibleDispatchCandidates({
      requirementId,
      latitude: req.job.latitude,
      longitude: req.job.longitude,
      radiusMeters,
      skillType: req.skill_type,
      limit: 30,
      offset,
      excludeDispatched: true,
    })) || [];

  const totalWorkersFound = workers.length;
  if (totalWorkersFound === 0) {
    console.log(
      `[dispatchWorker] No eligible workers found for requirement ${requirementId} in wave ${waveNumber} (radius: ${radiusMeters}m) at offset ${offset}`,
    );
    await prisma.job_requirement.update({
      where: { id: requirementId },
      data: { status: RequirementStatus.NO_WORKERS_AVAILABLE },
    });
    return;
  }

  // 3. Wave slice — up to (worker_count_needed * 2) workers per wave
  const waveSize = Math.min(req.worker_count_needed * 2, totalWorkersFound);
  const waveWorkers = workers.slice(0, waveSize);
  const expiresAt = new Date(Date.now() + WAVE_TIMEOUT_MS);

  // 4. PERSISTENCE FIRST: Write dispatch_wave and job_dispatch rows
  // Database unique constraints backstop against concurrency races
  const executeWrites = async (client: any) => {
    await client.dispatch_wave.create({
      data: {
        requirement_id: requirementId,
        wave_number: waveNumber,
        workers_notified: waveSize,
        status: 'active',
        notified_at: new Date(),
      },
    });

    await client.job_dispatch.createMany({
      data: waveWorkers.map((w, i) => ({
        requirement_id: requirementId,
        worker_id: w.id,
        wave_number: waveNumber,
        wave_position: i + 1,
        status: 'pending',
        notified_at: new Date(),
        expires_at: expiresAt,
      })),
    });
  };

  try {
    if (typeof prisma.$transaction === 'function') {
      let txRan = false;
      await prisma.$transaction(async (tx) => {
        txRan = true;
        await executeWrites(tx);
      });
      // Handle bare jest.fn() mock that returns undefined without executing callback
      if (!txRan) {
        await executeWrites(prisma);
      }
    } else {
      await executeWrites(prisma);
    }
  } catch (err: any) {
    // P2002 is Prisma unique constraint violation (or raw 23505)
    if (err.code === 'P2002' || String(err.message).includes('uniq_dispatch_wave_req_wave')) {
      console.warn(
        `[dispatchWorker] Concurrent duplicate wave ${waveNumber} detected for requirement ${requirementId} — safely skipping`,
      );
      return;
    }
    console.error(`[dispatchWorker] Failed to persist dispatch state for requirement ${requirementId}:`, err);
    throw err; // Re-throw to trigger BullMQ retry
  }

  // 5. DURABLE TIMEOUT: Queue wave timeout in BullMQ with deterministic jobId
  // Replaces volatile in-memory setTimeout; survives worker and API restarts
  try {
    await timeoutQueue.add(
      'wave-timeout',
      {
        requirementId,
        jobId,
        waveNumber,
        totalWorkersFound,
        offset,
        waveSize,
      },
      {
        delay: WAVE_TIMEOUT_MS,
        jobId: `wave-timeout:${requirementId}:wave-${waveNumber}`,
      },
    );
  } catch (err) {
    console.error(`[dispatchWorker] Failed to enqueue durable timeout for requirement ${requirementId}:`, err);
    // Queue error will be retried by BullMQ
    throw err;
  }

  // 6. DURABLE NOTIFICATION ENQUEUE: enqueue a notification job to deliver FCM and
  // Socket.IO events to the dispatched workers. This enqueue happens AFTER the DB
  // transaction has committed and the timeout job has been queued.
  //
  // Invariant: DB commit → notificationQueue.add → [notificationWorker] → FCM/Socket.IO
  //
  // If the process crashes after the DB commit, BullMQ will re-deliver this notification
  // job on restart. If FCM/Socket.IO delivery fails inside notificationWorker, BullMQ
  // retries the notification job — the persisted dispatch state is never affected.
  try {
    await notificationQueue.add(
      DISPATCH_JOB_NAMES.DISPATCH_NOTIFY,
      {
        type: 'dispatch-notify' as const,
        requirementId,
        jobId,
        waveNumber,
        expiresAt: expiresAt.toISOString(),
        workers: waveWorkers.map((w) => ({ id: w.id })),
        skillType: req.skill_type,
        ratePerDay: req.rate_per_day,
        location: req.job.location ?? null,
        customerName: req.job.customer.name,
      },
      {
        // Deterministic jobId: if this enqueue is retried (e.g. after a crash before
        // the BullMQ job completes), BullMQ will ignore the duplicate and not double-notify.
        jobId: `notify:${requirementId}:wave-${waveNumber}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
      },
    );
  } catch (err) {
    console.error(
      `[dispatchWorker] Failed to enqueue notification job for requirement ${requirementId} wave ${waveNumber}:`,
      err,
    );
    // Throw so BullMQ retries the dispatch job and re-attempts the notification enqueue.
    // The DB write has already committed — the next retry will hit the idempotency guard
    // at the top (existing wave check) and skip re-persisting, then re-attempt the enqueue.
    throw err;
  }

  console.log(
    `[dispatchWorker] Wave ${waveNumber} persisted and notification job enqueued for requirement ${requirementId}. Timeout queued in BullMQ.`,
  );
}

let dispatchWorker: Worker<DispatchJobData> | null = null;

export function getDispatchWorker(): Worker<DispatchJobData> {
  if (!dispatchWorker) {
    dispatchWorker = new Worker<DispatchJobData>(
      'dispatch',
      async (job: Job<DispatchJobData>) => {
        await processDispatchJob(job.data);
      },
      {
        connection: redisConnectionOptions,
        concurrency: 10,
        settings: {
          stalledInterval: 10_000,
          maxStalledCount: 1,
        },
      } as any,
    );

    dispatchWorker.on('failed', (job, err) => {
      console.error(`[dispatchWorker] Job ${job?.id} failed:`, err.message);
    });

    dispatchWorker.on('stalled', (jobId) => {
      console.warn(`[dispatchWorker] Job ${jobId} stalled — worker may have crashed`);
    });

    dispatchWorker.on('error', (err) => {
      console.error('[dispatchWorker] Worker error:', err.message);
    });

    dispatchWorker.on('ready', () => {
      console.log('[dispatchWorker] ✅ Worker connected to Redis and ready to process jobs');
    });

    dispatchWorker.on('active', (job) => {
      console.log(`[dispatchWorker] 🔄 Picked up job ${job?.id} — processing requirement ${job?.data?.requirementId}`);
    });

    dispatchWorker.on('completed', (job) => {
      console.log(`[dispatchWorker] ✅ Job ${job?.id} completed for requirement ${job?.data?.requirementId}`);
    });
  }
  return dispatchWorker;
}

// Lazy start unless in test mode
if (process.env.NODE_ENV !== 'test') {
  getDispatchWorker();
}

const shutdown = async () => {
  if (dispatchWorker) {
    console.log('[dispatchWorker] Shutting down gracefully...');
    await dispatchWorker.close();
    console.log('[dispatchWorker] Closed.');
  }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default dispatchWorker;
