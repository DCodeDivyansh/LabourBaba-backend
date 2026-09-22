import { Worker, Job } from 'bullmq';
import prisma from '../config/prisma';
import { redisConnectionOptions, dispatchQueue } from '../config/bullmq';
import { registerWorker } from './workerLifecycle';
import { RequirementStatus } from '../features/jobs/requirementStateMachine';
import { io } from '../server';
import { generateDispatchOperationId } from '../features/dispatch/dispatchOperation';
import { planDispatchWave } from '../features/dispatch/wavePlanner';
import { logger } from '../utils/logger';

export interface TimeoutJobData {
  requirementId: string;
  jobId: string;
  waveNumber: number;
  totalWorkersFound?: number;
  offset?: number;
  waveSize?: number;
  hasMoreCandidates?: boolean;
  candidatesExhausted?: boolean;
  correlationId?: string;
  operationId?: string;
}

export async function processTimeoutJob(data: TimeoutJobData): Promise<void> {
  const { requirementId, jobId, waveNumber, totalWorkersFound = 0, offset = 0, waveSize = 0 } = data;

  logger.info(
    `[timeoutWorker] Wave ${waveNumber} timeout for requirement=${requirementId}`,
    { requirementId, jobId, waveNumber }
  );

  // 1. Authoritative DB re-read: check if requirement is already filled or cancelled
  const req = await prisma.job_requirement.findUnique({
    where: { id: requirementId },
    include: {
      job: {
        select: { customer_id: true },
      },
    },
  });

  if (!req) {
    logger.warn(`[timeoutWorker] Requirement ${requirementId} not found — skipping`, { requirementId });
    return;
  }

  if (
    req.status === RequirementStatus.FILLED ||
    req.status === RequirementStatus.CANCELLED
  ) {
    logger.info(
      `[timeoutWorker] Requirement ${requirementId} already reached terminal state (${req.status}) — skipping wave timeout`,
      { requirementId, status: req.status }
    );
    return;
  }

  // 2. Mark all pending dispatches for this wave as timed out
  const timeoutResult = await prisma.job_dispatch.updateMany({
    where: {
      requirement_id: requirementId,
      wave_number: waveNumber,
      status: 'pending',
    },
    data: { status: 'timeout', responded_at: new Date() },
  });
  const timedOut = timeoutResult?.count ?? 0;

  logger.info(`[timeoutWorker] Marked ${timedOut} dispatch(es) as timeout for wave ${waveNumber}`, { requirementId, waveNumber, timedOut });

  // 3. Close this wave as exhausted
  await prisma.dispatch_wave.updateMany({
    where: { requirement_id: requirementId, wave_number: waveNumber },
    data: { status: 'exhausted', resolved_at: new Date() },
  });

  const nextWave = waveNumber + 1;
  const isCandidatesExhausted =
    data.candidatesExhausted !== undefined
      ? data.candidatesExhausted
      : data.hasMoreCandidates !== undefined
      ? !data.hasMoreCandidates && nextWave > 4
      : offset + waveSize >= totalWorkersFound;

  const nextPlan = planDispatchWave({
    // `waveSize` fallback preserves compatibility with legacy timeout payload
    // tests; persisted requirements always supply worker_count_needed.
    workerCountNeeded: req.worker_count_needed ?? waveSize,
    workersAlreadyAssigned: req.worker_count_filled ?? 0,
    waveNumber: nextWave,
    candidatesExhausted: isCandidatesExhausted,
  });

  const nextOffset = offset + waveSize;

  if (!nextPlan.canDispatch || !nextPlan.shouldTryNextWave) {
    // No more workers available for this requirement
    logger.info(
      `[timeoutWorker] No more workers for requirement ${requirementId} in wave ${nextWave}. Marking no_workers_available.`,
      { requirementId, nextWave }
    );
    await prisma.job_requirement.update({
      where: { id: requirementId },
      data: { status: RequirementStatus.NO_WORKERS_AVAILABLE },
    });

    if (req.job?.customer_id && io && typeof io.to === 'function') {
      try {
        io.to(`customer:${req.job.customer_id}`).emit('job:no_workers', {
          jobId,
          requirementId,
        });
      } catch (err: any) {
        logger.error('[timeoutWorker] Failed to emit job:no_workers socket event:', { error: err.message });
      }
    }
    return;
  }

  // 5. Fire wave 2+ — enqueue next wave in BullMQ with deterministic jobId
  const nextOperationId = generateDispatchOperationId({
    requirementId,
    waveNumber: nextWave,
  });

  logger.info(
    `[timeoutWorker] Firing wave ${nextWave} (operation ${nextOperationId}) for requirement ${requirementId} at offset ${nextOffset}`,
    { requirementId, nextWave, nextOperationId, nextOffset }
  );

  await dispatchQueue.add(
    'dispatch-wave',
    {
      operationId: nextOperationId,
      requirementId,
      jobId,
      waveNumber: nextWave,
      offset: nextOffset,
    },
    {
      // Deterministic jobId ensures idempotent enqueuing across retries and restarts
      jobId: `dispatch:${requirementId}:wave-${nextWave}`,
    },
  );
}

let timeoutWorker: Worker<TimeoutJobData> | null = null;

export function getTimeoutWorker(): Worker<TimeoutJobData> {
  if (!timeoutWorker) {
    timeoutWorker = new Worker<TimeoutJobData>(
      'timeout',
      async (job: Job<TimeoutJobData>) => {
        await processTimeoutJob(job.data);
      },
      {
        connection: redisConnectionOptions,
        concurrency: 20,
      },
    );

    registerWorker(timeoutWorker);

    timeoutWorker.on('failed', (job, err) => {
      logger.error(`[timeoutWorker] Job ${job?.id} failed:`, { jobId: job?.id, error: err.message });
    });

    timeoutWorker.on('stalled', (jobId) => {
      logger.warn(`[timeoutWorker] Job ${jobId} stalled — worker may have crashed`, { jobId });
    });

    timeoutWorker.on('error', (err) => {
      logger.error('[timeoutWorker] Worker error:', { error: err.message });
    });

    timeoutWorker.on('ready', () => {
      logger.info('[timeoutWorker] ✅ Worker connected to Redis and ready to process jobs');
    });

    timeoutWorker.on('completed', (job) => {
      logger.info(`[timeoutWorker] ✅ Job ${job?.id} completed for requirement ${job?.data?.requirementId}`, { jobId: job?.id, requirementId: job?.data?.requirementId });
    });
  }
  return timeoutWorker;
}

// Worker is started explicitly via lifecycleManager.startup()

const shutdown = async () => {
  if (timeoutWorker) {
    logger.info('[timeoutWorker] Shutting down gracefully...');
    await timeoutWorker.close();
    logger.info('[timeoutWorker] Closed.');
  }
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

export default timeoutWorker;
