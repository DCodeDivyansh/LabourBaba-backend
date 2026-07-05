/**
 * Simple Dispatch — no BullMQ, no Redis needed.
 *
 * Finds nearby workers via PostGIS, writes job_dispatch rows,
 * sends FCM + Socket.IO notifications, and uses setTimeout for timeouts.
 *
 * The existing BullMQ dispatch (workers/dispatchWorker.ts) is preserved
 * and can be swapped back in at any time.
 */

import prisma from '../config/prisma';
import { sendFCMNotification } from './fcm';
import { io } from '../server';

const WAVE_TIMEOUT_MS = 30_000; // 30 seconds
const INITIAL_RADIUS_M = 10_000; // 10 km
const EXPANDED_RADIUS_M = 20_000; // 20 km
const WORKERS_PER_WAVE = 20;

interface NearbyWorker {
  id: string;
  name: string | null;
  device_token: string | null;
  worker_score: number;
  dist_m: number;
}

// Job shape we receive from the caller (avoids extra DB query — Problem 4)
export interface JobForDispatch {
  id: string;
  customer_id: string;
  latitude: number | null;
  longitude: number | null;
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Dispatch all requirements for a job in parallel.
 * Call this fire-and-forget after job creation — it runs in the background
 * and does not slow down the API response.
 *
 * @param job  — the job record returned from the create transaction (no extra query)
 */
export async function dispatchJobSimple(
  job: JobForDispatch,
  requirements: { id: string; skill_type?: string | null; rate_per_day?: number | null }[],
): Promise<void> {
  await Promise.all(
    requirements.map((req) => dispatchRequirementSimple(job, req)),
  );
}

// ── Core per-requirement dispatch ───────────────────────────────────────────

async function dispatchRequirementSimple(
  job: JobForDispatch,
  req: { id: string; skill_type?: string | null; rate_per_day?: number | null },
): Promise<void> {
  if (!job.latitude || !job.longitude) {
    console.warn(`[simpleDispatch] Job ${job.id} missing coordinates — cannot dispatch`);
    await prisma.job_requirement.update({
      where: { id: req.id },
      data: { status: 'no_workers_available' },
    });
    return;
  }

  // Wave 1: search within INITIAL_RADIUS_M (10 km)
  let workers = await findAvailableWorkers(job, req, INITIAL_RADIUS_M);

  if (workers.length > 0) {
    await dispatchWave(job, req, workers, 1);
    // Schedule timeout — if no one accepts, try expanded radius
    scheduleTimeout(job, req, 1);
    return;
  }

  // No workers in 10 km — immediately try expanded radius (20 km)
  console.log(
    `[simpleDispatch] No workers within ${INITIAL_RADIUS_M / 1000}km for requirement ${req.id} — expanding to ${EXPANDED_RADIUS_M / 1000}km`,
  );

  workers = await findAvailableWorkers(job, req, EXPANDED_RADIUS_M);
  console.log(workers);
  if (workers.length > 0) {
    await dispatchWave(job, req, workers, 1);
    // Schedule timeout — this is the last attempt
    scheduleTimeout(job, req, 1);
    return;
  }

  // No workers even at expanded radius
  console.log(`[simpleDispatch] No workers found at all for requirement ${req.id}`);
  await prisma.job_requirement.update({
    where: { id: req.id },
    data: { status: 'no_workers_available' },
  });

  io.to(`customer:${job.customer_id}`)
    .emit('job:no_workers', { jobId: job.id, requirementId: req.id });
}

// ── Find available workers via PostGIS ──────────────────────────────────────

/**
 * Queries nearby online workers who are NOT already working on an active
 * booking (Problem 6: worker availability).
 */
async function findAvailableWorkers(
  job: JobForDispatch,
  req: { id: string; skill_type?: string | null },
  radiusMeters: number,
): Promise<NearbyWorker[]> {
  return prisma.$queryRaw<NearbyWorker[]>`
    SELECT w.id, w.name, w.device_token, w.worker_score::float,
           ST_Distance(
             w.location_geo,
             ST_MakePoint(${job.longitude}, ${job.latitude})::geography
           ) AS dist_m
    FROM worker w
    WHERE w.is_online   = true
    ORDER BY w.worker_score DESC
    LIMIT ${WORKERS_PER_WAVE}
  `;
}

// AND w.deleted_at  IS NULL
// AND (
//   w.skill_type ILIKE ${req.skill_type ?? ''}
//   OR w.skill_category_id IN (
//     SELECT id FROM skill_category WHERE name ILIKE ${req.skill_type ?? ''}
//   )
// )
// AND ST_DWithin(
//       w.location_geo,
//       ST_MakePoint(${job.longitude}, ${job.latitude})::geography,
//       ${radiusMeters}
//     )
// -- Problem 6: exclude workers who already have an active booking
// AND NOT EXISTS (
//       SELECT 1 FROM booking b
//       WHERE b.worker_id = w.id
//         AND b.status IN ('confirmed', 'in_progress')
//     )

// ── Dispatch a single wave ──────────────────────────────────────────────────

async function dispatchWave(
  job: JobForDispatch,
  req: { id: string; skill_type?: string | null; rate_per_day?: number | null },
  workers: NearbyWorker[],
  waveNumber: number,
): Promise<void> {
  // Problem 5: calculate expiresAt once and reuse everywhere
  const expiresAt = new Date(Date.now() + WAVE_TIMEOUT_MS);

  // Write dispatch rows
  await prisma.job_dispatch.createMany({
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

  // Notify all workers via Socket.IO + FCM simultaneously
  await Promise.all(
    workers.map(async (w) => {
      // FCM push
      if (w.device_token) {
        await sendFCMNotification(w.device_token, {
          title: 'New job nearby',
          body: `${req.skill_type} needed — ₹${req.rate_per_day}/day`,
        });
      }
      // Socket.IO
      io.to(`worker:${w.id}`).emit('job:incoming', {
        requirementId: req.id,
        jobId: job.id,
        skillType: req.skill_type,
        ratePerDay: req.rate_per_day,
        expiresAt: expiresAt.toISOString(),
      });
    }),
  );

  console.log(
    `[simpleDispatch] Wave ${waveNumber}: dispatched ${workers.length} workers for requirement ${req.id}. Timeout in ${WAVE_TIMEOUT_MS / 1000}s.`,
  );
}

// ── Timeout handler ─────────────────────────────────────────────────────────

/**
 * Problem 3 note: setTimeout is acceptable for MVP but will not survive
 * a server restart. For production, use BullMQ delayed jobs or a persistent
 * scheduler (cron / pg_cron / etc).
 *
 * Problem 7: after wave 1 timeout at 10km, we retry with expanded 20km radius
 * before notifying the customer.
 */
function scheduleTimeout(
  job: JobForDispatch,
  req: { id: string; skill_type?: string | null; rate_per_day?: number | null },
  waveNumber: number,
): void {
  setTimeout(async () => {
    try {
      const updatedReq = await prisma.job_requirement.findUnique({
        where: { id: req.id },
      });
      if (!updatedReq || updatedReq.status === 'filled') return; // already done

      // Mark pending dispatches as timeout
      const { count } = await prisma.job_dispatch.updateMany({
        where: { requirement_id: req.id, wave_number: waveNumber, status: 'pending' },
        data: { status: 'timeout', responded_at: new Date() },
      });

      console.log(
        `[simpleDispatch] Timeout wave ${waveNumber} for requirement ${req.id} — ${count} pending dispatch(es) timed out`,
      );

      // Problem 7: if this was wave 1 at 10km, try expanded radius (20km)
      if (waveNumber === 1) {
        console.log(
          `[simpleDispatch] Retrying requirement ${req.id} with expanded ${EXPANDED_RADIUS_M / 1000}km radius`,
        );

        const moreWorkers = await findAvailableWorkers(job, req, EXPANDED_RADIUS_M);

        if (moreWorkers.length > 0) {
          await dispatchWave(job, req, moreWorkers, 2);
          scheduleTimeout(job, req, 2);
          return; // give wave 2 a chance
        }
      }

      // No more retries — notify customer
      console.log(`[simpleDispatch] All waves exhausted for requirement ${req.id}`);
      await prisma.job_requirement.update({
        where: { id: req.id },
        data: { status: 'no_workers_available' },
      });

      io.to(`customer:${job.customer_id}`)
        .emit('job:no_workers', { jobId: job.id, requirementId: req.id });
    } catch (err) {
      console.error(`[simpleDispatch] Timeout handler error for requirement ${req.id}:`, err);
    }
  }, WAVE_TIMEOUT_MS);
}
