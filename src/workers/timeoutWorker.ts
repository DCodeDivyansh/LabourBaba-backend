import { Worker, Job } from 'bullmq';
import prisma from '../config/prisma';
import { redisConnectionOptions, dispatchQueue } from '../config/bullmq';

interface TimeoutJobData {
  requirementId: string;
  jobId: string;
  waveNumber: number;
  totalWorkersFound: number;
  offset: number;
  waveSize: number;
}

const timeoutWorker = new Worker<TimeoutJobData>(
  'timeout',
  async (job: Job<TimeoutJobData>) => {
    const { requirementId, jobId, waveNumber, totalWorkersFound, offset, waveSize } = job.data;

    console.log(
      `[timeoutWorker] Wave ${waveNumber} timeout for requirement=${requirementId}`,
    );

    // 1. Check if requirement is already filled — nothing to do
    const req = await prisma.job_requirement.findUnique({
      where: { id: requirementId },
    });

    if (!req) {
      console.warn(`[timeoutWorker] Requirement ${requirementId} not found — skipping`);
      return;
    }

    if (req.status === 'filled') {
      console.log(`[timeoutWorker] Requirement ${requirementId} already filled — skipping`);
      return;
    }

    // 2. Mark all pending dispatches for this wave as timed out
    const { count: timedOut } = await prisma.job_dispatch.updateMany({
      where: {
        requirement_id: requirementId,
        wave_number: waveNumber,
        status: 'pending',
      },
      data: { status: 'timeout', responded_at: new Date() },
    });

    console.log(`[timeoutWorker] Marked ${timedOut} dispatch(es) as timeout for wave ${waveNumber}`);

    // 3. Close this wave
    await prisma.dispatch_wave.updateMany({
      where: { requirement_id: requirementId, wave_number: waveNumber },
      data: { status: 'exhausted', resolved_at: new Date() },
    });

    // 4. Calculate next wave offset
    //    offset was the start of the current wave's slice in the full result set
    const nextOffset = offset + waveSize;

    if (nextOffset >= totalWorkersFound) {
      // No more workers available for this requirement
      console.log(
        `[timeoutWorker] No more workers for requirement ${requirementId} (offset ${nextOffset} >= total ${totalWorkersFound}). Marking no_workers_available.`,
      );
      await prisma.job_requirement.update({
        where: { id: requirementId },
        data: { status: 'no_workers_available' },
      });
      return;
    }

    // 5. Fire wave 2+ — fresh PostGIS query with next offset
    const nextWave = waveNumber + 1;
    console.log(
      `[timeoutWorker] Firing wave ${nextWave} for requirement ${requirementId} at offset ${nextOffset}`,
    );

    await dispatchQueue.add(
      'dispatch-wave',
      {
        requirementId,
        jobId,
        waveNumber: nextWave,
        offset: nextOffset,
      },
      {
        // Unique jobId so waves are never deduplicated across retries
        jobId: `dispatch-${requirementId}-wave-${nextWave}`,
      },
    );
  },
  {
    connection: redisConnectionOptions,
    concurrency: 20,
  },
);

// ── Event Handlers ──────────────────────────────────────────────────────────

timeoutWorker.on('failed', (job, err) => {
  console.error(`[timeoutWorker] Job ${job?.id} failed:`, err.message);
});

timeoutWorker.on('stalled', (jobId) => {
  console.warn(`[timeoutWorker] Job ${jobId} stalled — worker may have crashed`);
});

timeoutWorker.on('error', (err) => {
  console.error('[timeoutWorker] Worker error:', err.message);
});

timeoutWorker.on('ready', () => {
  console.log('[timeoutWorker] ✅ Worker connected to Redis and ready to process jobs');
});

timeoutWorker.on('completed', (job) => {
  console.log(`[timeoutWorker] ✅ Job ${job?.id} completed for requirement ${job?.data?.requirementId}`);
});

// ── Graceful Shutdown ────────────────────────────────────────────────────────

const shutdown = async () => {
  console.log('[timeoutWorker] Shutting down gracefully...');
  await timeoutWorker.close();
  console.log('[timeoutWorker] Closed.');
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default timeoutWorker;
