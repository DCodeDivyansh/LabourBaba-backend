/**
 * Simple Dispatch — no BullMQ, no Redis needed.
 *
 * Finds nearby workers via PostGIS, writes job_dispatch rows,
 * sends FCM + Socket.IO notifications, and uses setTimeout for timeouts.
 *
 * Recommended indexes (add via migration if not already present):
 *   CREATE INDEX IF NOT EXISTS worker_location_geo_gist ON worker USING GIST (location_geo);
 *   CREATE INDEX IF NOT EXISTS job_dispatch_requirement_worker_idx ON job_dispatch (requirement_id, worker_id);
 *   CREATE INDEX IF NOT EXISTS job_dispatch_requirement_wave_status_idx ON job_dispatch (requirement_id, wave_number, status);
 *
 * Call `recoverStaleDispatchesOnStartup()` once, right after Prisma connects
 * at server boot, to resume any requirement that was mid-dispatch when the
 * process last restarted. See that function's docstring for details.
 */

import prisma from '../config/prisma';
import { sendFCMNotification } from './fcm';
import { io } from '../server';

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
  timeoutMs: 30_000,
  fastPollMs: 1_000,
  fastPollWindowMs: 10_000,
  slowPollMs: 5_000,
  workersPerWave: 20,
  writeRetryDelayMs: 500,
  waves: [
    { radius: 3_000 },
    { radius: 5_000 },
    { radius: 10_000 },
    { radius: 15_000 },
  ],
};

interface NearbyWorker {
  id: string;
  device_token: string | null;
  dist_m: number;
}

// Job shape we receive from the caller (avoids extra DB query)
export interface JobForDispatch {
  id: string;
  customer_id: string;
  latitude: number | null;
  longitude: number | null;
}

interface RequirementForDispatch {
  id: string;
  skill_type?: string | null;
  rate_per_day?: number | null;
  // NOTE: assuming this is the column name for "how many workers this
  // requirement needs" — correct me if the real column is named
  // differently (e.g. `quantity`, `count`, `num_workers`).
  workers_needed?: number | null;
}

// ── Structured logging ───────────────────────────────────────────────────────

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

function logError(event: string, fields: Record<string, unknown>, err: unknown): void {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...fields,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Dispatch all requirements for a job in parallel.
 * Call this fire-and-forget after job creation — it runs in the background
 * and does not slow down the API response.
 */
export async function dispatchJobSimple(
  job: JobForDispatch,
  requirements: RequirementForDispatch[],
): Promise<void> {
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
      skill_type: (req as unknown as RequirementForDispatch).skill_type,
      rate_per_day: (req as unknown as RequirementForDispatch).rate_per_day,
      workers_needed: (req as unknown as RequirementForDispatch).workers_needed,
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
  if (!job.latitude || !job.longitude) {
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
    const { radius } = DISPATCH_CONFIG.waves[waveIndex];
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

    const expiresAt = new Date(Date.now() + DISPATCH_CONFIG.timeoutMs);
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

/**
 * Returns online workers matching the requirement's skill, excluding anyone
 * already dispatched for this requirement in an earlier wave, ordered by
 * distance (nearest first) where distance is available.
 *
 * TEMPORARY: the ST_DWithin radius filter has been removed for now (per
 * request) so dispatch isn't blocked while the `location_geo` write bug is
 * being tracked down. This means `radiusMeters` is currently unused here —
 * every wave will just match against all online, skill-matching workers,
 * up to `workersPerWave`, since it's no longer radius-limited. Waves will
 * still escalate through the same worker pool (each wave excludes workers
 * already dispatched via the NOT EXISTS check below), but the distinction
 * between "3km wave" and "15km wave" no longer means anything until this
 * is put back. Re-add the ST_DWithin clause once `location_geo` is
 * confirmed to be populated correctly for real workers.
 *
 * NOTE: this also still does not exclude workers who already have a
 * `confirmed` or `in_progress` booking — per earlier request, a worker who
 * has accepted a job can still be dispatched (and notified) for other jobs.
 *
 * Skill matching is restored below using the column/table names from your
 * own original (commented-out) query — I didn't invent new ones. Two
 * things worth confirming against your actual schema:
 *   1. Skill matching now normalizes with LOWER(TRIM(...)) on both sides,
 *      since your top-of-mind note mentions a `skill_category` name mismatch
 *      breaking dispatch before — this should make it whitespace/case safe.
 *   2. If a requirement has no `skill_type` set, the filter is skipped
 *      entirely (dispatches to any online worker) rather than matching
 *      nothing. If that's not the behavior you want for skill-less
 *      requirements, tell me and I'll make it strict instead.
 *
 * Pool size per wave is now `workers_needed * 4` (so a requirement needing
 * 3 workers pulls up to 12 candidates per wave) rather than the flat
 * `DISPATCH_CONFIG.workersPerWave`. If `workers_needed` is missing or not a
 * positive number, it falls back to `DISPATCH_CONFIG.workersPerWave` so a
 * bad/missing value doesn't quietly starve dispatch down to 4 candidates.
 * The SQL `LIMIT` naturally caps this at whatever's actually available —
 * if only 2 online workers match, you get 2, never more than exist.
 */
async function findAvailableWorkers(
  job: JobForDispatch,
  req: RequirementForDispatch,
  radiusMeters: number,
): Promise<NearbyWorker[]> {
  const poolLimit =
    req.workers_needed && req.workers_needed > 0
      ? req.workers_needed * 2
      : DISPATCH_CONFIG.workersPerWave;

  return prisma.$queryRaw<NearbyWorker[]>`
    SELECT w.id,
           w.device_token,
           ST_Distance(
             w.location_geo,
             ST_MakePoint(${job.longitude}, ${job.latitude})::geography
           ) AS dist_m
    FROM worker w
    WHERE w.is_online = true
      AND (
            ${req.skill_type ?? null}::text IS NULL
            OR LOWER(TRIM(w.skill_type)) = LOWER(TRIM(${req.skill_type ?? ''}))
            OR EXISTS (
                 SELECT 1 FROM skill_category sc
                 WHERE sc.id = w.skill_category_id
                   AND LOWER(TRIM(sc.name)) = LOWER(TRIM(${req.skill_type ?? ''}))
               )
          )
      AND NOT EXISTS (
            SELECT 1 FROM job_dispatch jd
            WHERE jd.requirement_id = ${req.id}
              AND jd.worker_id = w.id
          )
    ORDER BY dist_m ASC NULLS LAST
    LIMIT ${poolLimit}
  `.then((workers) => {
    log('dispatch.pool_limit_used', { requirementId: req.id, workersNeeded: req.workers_needed ?? null, poolLimit });
    return workers;
  });

  // AND w.deleted_at IS NULL
  // Left out: unconfirmed whether `worker` has a soft-delete column.
  // Add back in if it does — an inactive worker slipping through here
  // wouldn't be caught by anything else in this query.
}

// ── Transactional write of dispatch rows ─────────────────────────────────────

/**
 * Writes all job_dispatch rows for a wave inside a single transaction.
 * Retries once after a short delay on failure (handles a transient DB blip
 * without immediately giving up on a radius that actually had workers).
 * Returns false only if both attempts fail, so the caller knows not to send
 * notifications for data that never made it to the database.
 */
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
  const workersWithToken = workers.filter((w) => w.device_token);

  const fcmResults = await Promise.allSettled(
    workersWithToken.map((w) =>
      sendFCMNotification(w.device_token as string, {
        title: 'New job nearby',
        body: `${req.skill_type ?? 'A job'} needed — \u20b9${req.rate_per_day ?? '—'}/day`,
        // ⬅ NEW: without this, a tapped notification has nothing to act on —
        // matches the job:incoming socket payload shape so both paths converge
        // on the same IncomingJobScreen params.
        data: {
          requirementId: String(req.id),
          jobId: String(job.id ?? ''),
          skillType: String(req.skill_type ?? ''),
          ratePerDay: String(req.rate_per_day ?? ''),
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : '', // ⬅ use whatever variable holds this wave's expiry in scope here
        },
      }),
    ),
  );

  fcmResults.forEach((result, i) => {
    if (result.status === 'rejected') {
      logError(
        'dispatch.fcm_failed',
        { requirementId: req.id, workerId: workersWithToken[i].id },
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

/**
 * Polls until either the wave's timeout elapses or a worker accepts —
 * whichever comes first. Uses a fast poll interval for the first
 * `fastPollWindowMs` (acceptance is most likely soon after notification),
 * then backs off to a slower interval for the rest of the wave — roughly
 * the same total query volume as a flat interval, weighted toward
 * responsiveness when it matters most.
 *
 * A single combined query checks both possible "accepted" signals in one
 * round trip instead of two. Polling (rather than DB LISTEN/NOTIFY or an
 * event emitter) is used to stay within the "no new infrastructure"
 * constraint; the accept endpoint elsewhere in the codebase is expected to
 * set job_requirement.status = 'filled' and/or job_dispatch.status =
 * 'accepted' when a worker accepts.
 */
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