/**
 * @deprecated NON-PRODUCTION TEST FIXTURE ONLY
 *
 * This module is DEPRECATED and ISOLATED strictly for backwards compatibility with legacy unit tests.
 * Under Issue #21, BullMQ is the ONLY authoritative production dispatch engine.
 *
 * Any attempt to invoke this module in production will throw a fatal error.
 */

if (process.env.NODE_ENV === 'production') {
  throw new Error(
    '[FATAL_ARCHITECTURE_VIOLATION] simpleDispatch is forbidden in production. BullMQ is the only production dispatch engine.',
  );
}

import prisma from '../../config/prisma';
import { sendFCMNotification, sendFCMToWorker } from '../../shared/fcm';
import { io } from '../../server';
import {
  getEligibleDispatchCandidates,
  validateDispatchCoordinates,
} from './dispatchCandidate.service';
import { dispatchWaveConfig } from '../../config/dispatchWaveConfig';
import { planDispatchWave } from './wavePlanner';

// ── Configuration ────────────────────────────────────────────────────────────

interface DispatchWaveConfig {
  radius: number; // meters
}

interface DispatchConfig {
  timeoutMs: number;
  fastPollMs: number; // poll interval during the "acceptance is likely soon" window
  fastPollWindowMs: number; // how long to use fastPollMs before backing off
  slowPollMs: number; // poll interval for the remainder of the wave
  workersPerWave: number;
  writeRetryDelayMs: number;
  waves: DispatchWaveConfig[];
}

const DISPATCH_CONFIG: DispatchConfig = {
  timeoutMs: dispatchWaveConfig.timeoutMs,
  fastPollMs: 1_000,
  fastPollWindowMs: 10_000,
  slowPollMs: 5_000,
  workersPerWave: dispatchWaveConfig.workerMultiplier,
  writeRetryDelayMs: 500,
  waves: dispatchWaveConfig.radiusMetersByWave.map((radius) => ({ radius })),
};

interface NearbyWorker {
  id: string;
  dist_m: number;
}

// Job shape we receive from the caller (avoids extra DB query)
export interface JobForDispatch {
  id: string;
  customer_id: string;
  latitude: number | null;
  longitude: number | null;
}

export interface RequirementForDispatch {
  id: string;
  skill_id?: string | null;
  skill_type?: string | null;
  rate_per_day?: number | null;
  worker_count_needed?: number | null;
  /** @deprecated Authoritative field is worker_count_needed */
  workers_needed?: number | null;
}

import { logger } from '../../utils/logger';

// ── Structured logging ───────────────────────────────────────────────────────

function log(event: string, fields: Record<string, unknown>): void {
  logger.info(`[simpleDispatch] ${event}`, { event, ...fields });
}

function logError(event: string, fields: Record<string, unknown>, err: unknown): void {
  logger.error(`[simpleDispatch] ${event}`, {
    event,
    ...fields,
    error: err instanceof Error ? err.message : String(err),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Public entry point ───────────────────────────────────────────────────────

import { jobStateService, JobAction } from '../jobs/jobStateMachine';

/**
 * Dispatch all requirements for a job in parallel.
 * Call this fire-and-forget after job creation — it runs in the background
 * and does not slow down the API response.
 */
export async function dispatchJobSimple(
  job: JobForDispatch,
  requirements: RequirementForDispatch[],
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await jobStateService.transition(tx, {
        jobId: job.id,
        action: JobAction.START_DISPATCH,
        actor: { role: "DISPATCH_WORKER" },
        reason: "Dispatch wave initiated",
      });
    });
  } catch (err: any) {
    // If job was already in DISPATCHING or BOOKED (e.g. on recovery or mock), safely ignore
  }
  await Promise.all(requirements.map((req) => dispatchRequirementSimple(job, req)));
}

// ── Startup recovery ─────────────────────────────────────────────────────────

/**
 * Resumes dispatch for any requirement that was mid-flight when the process
 * last exited (crash, deploy, `EADDRINUSE` kill, etc). Because this system
 * uses `setTimeout` rather than a persistent queue, an in-memory wave timer
 * is lost on restart — this function finds requirements left holding an
 * expired-but-still-"pending" dispatch row and re-enters the dispatch loop
 * for them via `dispatchRequirementSimple`, which will pick up exactly where
 * things left off (see `getResumeState` below).
 *
 * Call this once, after Prisma connects, during server bootstrap:
 *   await recoverStaleDispatchesOnStartup();
 *
 * This intentionally is NOT a cron job or background poller — it only runs
 * once at boot, so it doesn't introduce new always-on infrastructure.
 */
export async function recoverStaleDispatchesOnStartup(): Promise<void> {
  const staleRequirements = await prisma.job_requirement.findMany({
    where: {
      status: { notIn: ['filled', 'no_workers_available'] },
      job_dispatch: {
        some: { status: 'pending', expires_at: { lt: new Date() } },
      },
    },
    include: { job: true },
  });

  log('dispatch.startup_recovery_scan', { staleRequirementCount: staleRequirements.length });

  for (const req of staleRequirements) {
    const job = (req as unknown as { job: JobForDispatch | null }).job;
    if (!job) {
      logError('dispatch.startup_recovery_missing_job', { requirementId: req.id }, 'no related job');
      continue;
    }

    dispatchRequirementSimple(job, {
      id: req.id,
      skill_id: (req as any).skill_id || null,
      skill_type: req.skill_type,
      rate_per_day: req.rate_per_day,
      worker_count_needed: req.worker_count_needed,
    }).catch((err) => logError('dispatch.startup_recovery_failed', { requirementId: req.id }, err));
  }
}

// ── Resume-state resolution (idempotency + restart recovery in one) ─────────

interface ResumeState {
  alreadyResolved: boolean; // filled or no_workers_available — nothing to do
  inFlight: boolean; // a wave is actively pending and not yet expired — skip, another call owns it
  nextWaveIndex: number; // 0-based index into DISPATCH_CONFIG.waves to start/resume at
}

/**
 * Looks at what's already in job_dispatch for this requirement (if anything)
 * to decide whether to start fresh, resume from a later wave, or skip
 * entirely. This replaces a hard "any existing row means skip" guard, which
 * would have permanently stuck a requirement if the process restarted
 * mid-wave.
 */
async function getResumeState(requirementId: string): Promise<ResumeState> {
  const requirement = await prisma.job_requirement.findUnique({
    where: { id: requirementId },
    select: { status: true },
  });

  if (requirement?.status === 'filled' || requirement?.status === 'no_workers_available') {
    return { alreadyResolved: true, inFlight: false, nextWaveIndex: 0 };
  }

  const dispatches = await prisma.job_dispatch.findMany({
    where: { requirement_id: requirementId },
    select: { wave_number: true, status: true, expires_at: true },
    orderBy: { wave_number: 'desc' },
  });

  if (dispatches.length === 0) {
    return { alreadyResolved: false, inFlight: false, nextWaveIndex: 0 };
  }

  // wave_number is nullable in the schema; treat a null as "wave 0" (i.e.
  // before the first configured wave) so the arithmetic below stays a plain
  // number rather than number | null.
  const maxWave = dispatches[0].wave_number ?? 0;
  const latestWaveRows = dispatches.filter((d) => (d.wave_number ?? 0) === maxWave);
  const stillActive = latestWaveRows.some(
    (d) => d.status === 'pending' && d.expires_at !== null && d.expires_at > new Date(),
  );

  if (stillActive) {
    // Another call (or the original timer, if the process never actually
    // restarted) is still legitimately waiting on this wave.
    return { alreadyResolved: false, inFlight: true, nextWaveIndex: Math.max(maxWave - 1, 0) };
  }

  // The latest wave is done (resolved normally, or its timer died with the
  // process). If any rows in that wave are still sitting as "pending" with
  // an expiry in the past, their in-memory setTimeout died with the old
  // process before it could flip them to "timeout" — clean those up now so
  // dispatch history/analytics doesn't show stale pending rows forever.
  const stalePendingCount = latestWaveRows.filter(
    (d) => d.status === 'pending' && d.expires_at !== null && d.expires_at <= new Date(),
  ).length;

  if (stalePendingCount > 0) {
    await prisma.job_dispatch.updateMany({
      where: {
        requirement_id: requirementId,
        wave_number: maxWave,
        status: 'pending',
        expires_at: { lte: new Date() },
      },
      data: { status: 'timeout', responded_at: new Date() },
    });

    log('dispatch.stale_pending_cleaned', {
      requirementId,
      waveNumber: maxWave,
      staleCount: stalePendingCount,
    });
  }

  // Resume at the next radius up.
  return { alreadyResolved: false, inFlight: false, nextWaveIndex: maxWave };
}

// ── Core per-requirement dispatch (sequential wave loop) ─────────────────────

async function dispatchRequirementSimple(
  job: JobForDispatch,
  req: RequirementForDispatch,
): Promise<void> {
  if (!validateDispatchCoordinates(job.latitude, job.longitude)) {
    log('dispatch.no_coordinates', { jobId: job.id, requirementId: req.id });
    await prisma.job_requirement.update({
      where: { id: req.id },
      data: { status: 'no_workers_available' },
    });
    return;
  }

  const resumeState = await getResumeState(req.id);

  if (resumeState.alreadyResolved) {
    log('dispatch.skipped_already_resolved', { jobId: job.id, requirementId: req.id });
    return;
  }
  if (resumeState.inFlight) {
    log('dispatch.skipped_in_flight', { jobId: job.id, requirementId: req.id });
    return;
  }
  if (resumeState.nextWaveIndex > 0) {
    log('dispatch.resuming', {
      jobId: job.id,
      requirementId: req.id,
      resumingAtWaveNumber: resumeState.nextWaveIndex + 1,
    });
  }

  for (
    let waveIndex = resumeState.nextWaveIndex;
    waveIndex < DISPATCH_CONFIG.waves.length;
    waveIndex++
  ) {
    const waveNumber = waveIndex + 1;
    const plan = planDispatchWave({
      workerCountNeeded: req.worker_count_needed ?? req.workers_needed ?? 0,
      workersAlreadyAssigned: 0,
      waveNumber,
    });
    const radius = plan.radiusMeters;
    const waveStart = Date.now();

    const workers = await findAvailableWorkers(job, req, radius);

    log('dispatch.wave_search', {
      jobId: job.id,
      requirementId: req.id,
      waveNumber,
      radiusMeters: radius,
      workersFound: workers.length,
    });

    if (workers.length === 0) {
      // Nobody found at this radius — try the next one without waiting.
      continue;
    }

    const expiresAt = new Date(Date.now() + plan.timeoutMs);
    const writeOk = await writeDispatchRecords(req, workers, waveNumber, expiresAt);

    if (!writeOk) {
      // Transaction failed even after a retry — do NOT notify anyone for
      // this wave. Move to the next radius rather than leaving the
      // requirement stuck forever.
      log('dispatch.wave_write_failed', { jobId: job.id, requirementId: req.id, waveNumber });
      continue;
    }

    await notifyWorkers(job, req, workers, expiresAt);

    log('dispatch.wave_notified', {
      jobId: job.id,
      requirementId: req.id,
      waveNumber,
      radiusMeters: radius,
      workersNotified: workers.length,
      dispatchDurationMs: Date.now() - waveStart,
    });

    const accepted = await waitForAcceptanceOrTimeout(req.id, waveNumber);

    if (accepted) {
      log('dispatch.wave_accepted', { jobId: job.id, requirementId: req.id, waveNumber });
      return; // stop dispatching entirely — a worker took the job
    }

    const { count } = await prisma.job_dispatch.updateMany({
      where: { requirement_id: req.id, wave_number: waveNumber, status: 'pending' },
      data: { status: 'timeout', responded_at: new Date() },
    });

    log('dispatch.wave_timeout', {
      jobId: job.id,
      requirementId: req.id,
      waveNumber,
      timedOutCount: count,
    });
    // loop continues to the next (larger) radius
  }

  // All configured waves are exhausted with no acceptance.
  log('dispatch.exhausted', { jobId: job.id, requirementId: req.id });

  await prisma.job_requirement.update({
    where: { id: req.id },
    data: { status: 'no_workers_available' },
  });

  io.to(`customer:${job.customer_id}`).emit('job:no_workers', {
    jobId: job.id,
    requirementId: req.id,
  });
}

// ── Find available workers via PostGIS ───────────────────────────────────────

export async function findAvailableWorkers(
  job: JobForDispatch,
  req: RequirementForDispatch,
  radiusMeters: number,
): Promise<NearbyWorker[]> {
  // Validate coordinates and radius before executing spatial query
  if (
    !validateDispatchCoordinates(job.latitude, job.longitude) ||
    !Number.isFinite(radiusMeters) ||
    radiusMeters <= 0
  ) {
    return [];
  }

  const needed = req.worker_count_needed ?? req.workers_needed;
  const poolLimit = planDispatchWave({
    workerCountNeeded: needed ?? 0,
    workersAlreadyAssigned: 0,
    waveNumber: 1,
  }).targetCandidateCount || DISPATCH_CONFIG.workersPerWave;

  const workers = await getEligibleDispatchCandidates({
    requirementId: req.id,
    latitude: job.latitude,
    longitude: job.longitude,
    radiusMeters,
    skillId: req.skill_id,
    skillType: req.skill_type,
    limit: poolLimit,
    offset: 0,
    excludeDispatched: true,
  });

  log('dispatch.pool_limit_used', { requirementId: req.id, workerCountNeeded: needed, poolLimit });
  return workers;
}

// ── Transactional write of dispatch rows ─────────────────────────────────────

async function writeDispatchRecords(
  req: RequirementForDispatch,
  workers: NearbyWorker[],
  waveNumber: number,
  expiresAt: Date,
  attempt = 1,
): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.job_dispatch.createMany({
        data: workers.map((w, i) => ({
          requirement_id: req.id,
          worker_id: w.id,
          wave_number: waveNumber,
          wave_position: i + 1,
          status: 'pending',
          notified_at: new Date(),
          expires_at: expiresAt,
        })),
      });
    });
    return true;
  } catch (err) {
    logError('dispatch.transaction_error', { requirementId: req.id, waveNumber, attempt }, err);

    if (attempt < 2) {
      await sleep(DISPATCH_CONFIG.writeRetryDelayMs);
      return writeDispatchRecords(req, workers, waveNumber, expiresAt, attempt + 1);
    }

    return false;
  }
}

// ── Notifications (FCM + Socket.IO, independently fault-tolerant) ───────────

async function notifyWorkers(
  job: JobForDispatch,
  req: RequirementForDispatch,
  workers: NearbyWorker[],
  expiresAt: Date,
): Promise<void> {
  const fcmResults = await Promise.allSettled(
    workers.map((w) =>
      sendFCMToWorker(w.id, {
        title: '',
        body: '',
        data: {
          type: 'incoming_job',
          jobId: String(job.id ?? ''),
          requirementId: String(req.id),
          title: 'New Job',
          body: `${req.skill_type ?? 'A job'} needed`,
          ratePerDay: String(req.rate_per_day ?? ''),
          customerName: '',
          location: '',
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : '',
        },
      }),
    ),
  );

  fcmResults.forEach((result, i) => {
    if (result.status === 'rejected') {
      logError(
        'dispatch.fcm_failed',
        { requirementId: req.id, workerId: workers[i].id },
        result.reason,
      );
    }
  });

  const socketResults = await Promise.allSettled(
    workers.map((w) =>
      Promise.resolve().then(() =>
        io.to(`worker:${w.id}`).emit('job:incoming', {
          requirementId: req.id,
          jobId: job.id,
          skillType: req.skill_type,
          ratePerDay: req.rate_per_day,
          expiresAt: expiresAt.toISOString(),
        }),
      ),
    ),
  );

  socketResults.forEach((result, i) => {
    if (result.status === 'rejected') {
      logError(
        'dispatch.socket_failed',
        { requirementId: req.id, workerId: workers[i].id },
        result.reason,
      );
    }
  });
}

// ── Wait for acceptance or timeout ───────────────────────────────────────────

async function waitForAcceptanceOrTimeout(
  requirementId: string,
  waveNumber: number,
): Promise<boolean> {
  const deadline = Date.now() + DISPATCH_CONFIG.timeoutMs;
  const fastWindowEnd = Date.now() + DISPATCH_CONFIG.fastPollWindowMs;

  while (Date.now() < deadline) {
    const interval = Date.now() < fastWindowEnd
      ? DISPATCH_CONFIG.fastPollMs
      : DISPATCH_CONFIG.slowPollMs;

    await sleep(Math.min(interval, deadline - Date.now()));

    const result = await prisma.$queryRaw<{ accepted: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM job_requirement WHERE id = ${requirementId} AND status = 'filled'
        UNION
        SELECT 1 FROM job_dispatch
        WHERE requirement_id = ${requirementId}
          AND wave_number = ${waveNumber}
          AND status = 'accepted'
      ) AS accepted
    `;

    if (result[0]?.accepted) {
      return true;
    }
  }

  return false;
}
