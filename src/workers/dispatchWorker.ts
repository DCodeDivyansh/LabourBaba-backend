import { Worker, Job } from 'bullmq';
import prisma from '../config/prisma';
import { redisConnectionOptions, timeoutQueue, dispatchQueue } from '../config/bullmq';
import { sendFCMNotification, sendFCMToWorker } from '../shared/fcm';
import { io } from '../server';
import {
  getEligibleDispatchCandidates,
  getWaveRadiusMeters,
  validateDispatchCoordinates,
  EligibleWorkerCandidate,
} from '../features/dispatch/dispatchCandidate.service';

const WAVE_TIMEOUT_MS = 30_000; // 30 seconds

export interface DispatchJobData {
  requirementId: string;
  jobId: string;
  waveNumber?: number;
  offset?: number;
}

export type NearbyWorker = EligibleWorkerCandidate;

export async function processDispatchJob(data: DispatchJobData): Promise<void> {
  const { requirementId, jobId, waveNumber = 1, offset = 0 } = data;
  console.log(
    `[dispatchWorker] Processing requirement=${requirementId} wave=${waveNumber} offset=${offset}`,
  );

  // 1. Fetch requirement + parent job for coordinates
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
  const tag = `[dispatch][${req.skill_type}][wave${waveNumber}]`;
  console.log(`${tag} START — requirementId: ${requirementId}`);

  // Already filled — nothing to do
  if (req.status === 'filled') {
    console.log(`[dispatchWorker] Requirement ${requirementId} already filled — skipping`);
    return;
  }

  // Explicit coordinate validation (reject null, undefined, NaN, Infinity, out of bounds; allow 0,0)
  if (!validateDispatchCoordinates(req.job.latitude, req.job.longitude)) {
    console.warn(`[dispatchWorker] Job ${jobId} missing or invalid coordinates — cannot dispatch`, {
      latitude: req.job.latitude,
      longitude: req.job.longitude,
    });
    await prisma.job_requirement.update({
      where: { id: requirementId },
      data: { status: 'no_workers_available' },
    });
    return;
  }

  // 2. Authoritative PostGIS query — nearby online, verified, fresh workers matching skill within wave radius
  const radiusMeters = getWaveRadiusMeters(waveNumber);
  const workers = await getEligibleDispatchCandidates({
    requirementId,
    latitude: req.job.latitude,
    longitude: req.job.longitude,
    radiusMeters,
    skillType: req.skill_type,
    limit: 30,
    offset,
    excludeDispatched: true,
  });

  const totalWorkersFound = workers.length;
  if (totalWorkersFound === 0) {
    console.log(
      `[dispatchWorker] No eligible workers found for requirement ${requirementId} in wave ${waveNumber} (radius: ${radiusMeters}m) at offset ${offset}`,
    );
    await prisma.job_requirement.update({
      where: { id: requirementId },
      data: { status: 'no_workers_available' },
    });
    return;
  }

    // 3. Wave slice — up to (worker_count_needed * 2) workers per wave
    const waveSize = Math.min(req.worker_count_needed * 2, totalWorkersFound);
    const waveWorkers = workers.slice(0, waveSize);
    const expiresAt = new Date(Date.now() + WAVE_TIMEOUT_MS);

    console.log(
      `[dispatchWorker] Wave ${waveNumber}: notifying ${waveSize} workers for requirement ${requirementId}`,
    );

    await Promise.all(
      waveWorkers.map(async (w) => {
        try {
          await sendFCMToWorker(w.id, {
            title: "New Job",
            body: req.skill_type ?? "New Job",
            data: {
              type: "incoming_job",
              jobId: req.job.id,
              requirementId: req.id,
              title: "New Job",
              body: req.skill_type ?? "",
              ratePerDay: String(req.rate_per_day ?? 0),
              customerName: req.job.customer.name,
              location: req.job.location ?? "",
              expiresAt: expiresAt.toISOString(),
            },
          });
        } catch (err) {
          console.error(`Failed to send FCM to worker ${w.id}:`, err);
        }
        try {
          if (io && typeof io.to === 'function') {
            const socketRoom = io.to(`worker:${w.id}`);
            if (socketRoom && typeof socketRoom.emit === 'function') {
              socketRoom.emit('job:incoming', {
                requirementId,
                jobId,
                skillType: req.skill_type,
                ratePerDay: req.rate_per_day,
                expiresAt,
              });
            }
          }
        } catch (err) {
          console.error(`Failed to send socket event to worker ${w.id}:`, err);
        }
      }),
    );


    // 4. Write dispatch_wave row
    await prisma.dispatch_wave.create({
      data: {
        requirement_id: requirementId,
        wave_number: waveNumber,
        workers_notified: waveSize,
        status: 'active',
        notified_at: new Date(),
      },
    });

    // // 5. Write all job_dispatch rows for this wave
    await prisma.job_dispatch.createMany({
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

    // // 6. Notify all wave workers concurrently (FCM + Socket.IO)


    // // 7. Queue wave timeout — fires in 30s
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
      { delay: WAVE_TIMEOUT_MS },
    );

    console.log(
      `[dispatchWorker] Wave ${waveNumber} dispatched for requirement ${requirementId}. Timeout queued.`,
    );
}

const dispatchWorker = new Worker<DispatchJobData>(
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

// ── Event Handlers ──────────────────────────────────────────────────────────

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

// ── Graceful Shutdown ────────────────────────────────────────────────────────

const shutdown = async () => {
  console.log('[dispatchWorker] Shutting down gracefully...');
  await dispatchWorker.close();
  console.log('[dispatchWorker] Closed.');
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default dispatchWorker;


// job.services.ts
//   dispatchQueue.add({ requirementId, jobId, waveNumber:1, offset:0 })
//         ↓
// dispatchWorker (this file)
//   1. fetch requirement + job coords
//   2. PostGIS → ranked workers nearby
//   3. write dispatch_wave row
//   4. write job_dispatch rows (all pending)
//   5. FCM + Socket.IO → all wave workers
//   6. timeoutQueue.add({ delay: 30s })
//         ↓
// Two things happen next (race):
//   A. Worker accepts → dispatchServices.acceptDispatch()
//      → booking created, slots filled, others cancelled
//   B. 30s passes → timeoutWorker fires
//      → marks pending as timeout
//      → re-queues dispatchQueue with offset+waveSize
