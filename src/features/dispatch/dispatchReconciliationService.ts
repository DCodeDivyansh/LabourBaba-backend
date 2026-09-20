import prisma from '../../config/prisma';
import { dispatchQueue, timeoutQueue } from '../../config/bullmq';
import { RequirementStatus } from '../jobs/requirementStateMachine';
import { JobStatus } from '../jobs/jobStateMachine';
import { WAVE_TIMEOUT_MS } from '../../workers/dispatchWorker';

export interface ReconciliationReport {
  scannedRequirements: number;
  expiredWavesClosed: number;
  activeTimeoutsRestored: number;
  missingWavesScheduled: number;
  errors: Array<{ requirementId: string; error: string }>;
}

/**
 * Startup Reconciliation Service for Dispatch
 *
 * Scans PostgreSQL for orphaned dispatch states (e.g. after an API crash, worker kill,
 * deployment reboot, or Redis blip) and reconstructs missing durable BullMQ jobs.
 *
 * Guarantees:
 * 1. Exactly one authoritative dispatch engine: BullMQ.
 * 2. Idempotent: Can be executed multiple times safely; deterministic BullMQ job IDs
 *    prevent duplicate queue entries.
 * 3. PostgreSQL is the source of truth for business state; BullMQ is the source of truth
 *    for scheduling.
 */
export async function reconcileDispatchState(): Promise<ReconciliationReport> {
  const report: ReconciliationReport = {
    scannedRequirements: 0,
    expiredWavesClosed: 0,
    activeTimeoutsRestored: 0,
    missingWavesScheduled: 0,
    errors: [],
  };

  console.log('[dispatchReconciliation] 🔍 Starting startup dispatch reconciliation scan...');

  // 1. Find all active/open requirements for non-terminal jobs
  const candidateRequirements = await prisma.job_requirement.findMany({
    where: {
      status: {
        in: [RequirementStatus.DISPATCHING, RequirementStatus.OPEN, 'dispatching', 'open'],
      },
      job: {
        status: {
          notIn: [
            JobStatus.BOOKED,
            JobStatus.COMPLETED,
            JobStatus.CANCELLED,
            'booked',
            'completed',
            'cancelled',
          ],
        },
      },
    },
    include: {
      job: {
        select: { id: true, status: true, customer_id: true },
      },
      dispatch_wave: {
        orderBy: { wave_number: 'desc' },
      },
      job_dispatch: {
        where: { status: 'pending' },
      },
    },
  });

  report.scannedRequirements = candidateRequirements.length;
  console.log(`[dispatchReconciliation] Found ${candidateRequirements.length} dispatchable requirement(s)`);

  const now = Date.now();

  for (const req of candidateRequirements) {
    try {
      // Check if requirement is already filled
      const isFilled =
        req.status?.toUpperCase() === RequirementStatus.FILLED ||
        (req.worker_count_filled ?? 0) >= req.worker_count_needed;

      if (isFilled) {
        continue;
      }

      const latestWave = req.dispatch_wave[0];

      if (latestWave && latestWave.status === 'active') {
        const notifiedAtMs = latestWave.notified_at ? new Date(latestWave.notified_at).getTime() : 0;
        const waveExpiresAtMs = notifiedAtMs + WAVE_TIMEOUT_MS;

        if (waveExpiresAtMs <= now) {
          // ── Case A: Wave expired while system was down ────────────────────────
          console.log(
            `[dispatchReconciliation] Requirement ${req.id} wave ${latestWave.wave_number} expired during downtime — resolving wave`,
          );

          // Mark pending dispatches as timeout
          await prisma.job_dispatch.updateMany({
            where: {
              requirement_id: req.id,
              wave_number: latestWave.wave_number,
              status: 'pending',
            },
            data: { status: 'timeout', responded_at: new Date() },
          });

          // Mark wave as exhausted
          await prisma.dispatch_wave.update({
            where: { id: latestWave.id },
            data: { status: 'exhausted', resolved_at: new Date() },
          });

          report.expiredWavesClosed++;

          // Schedule next wave
          const nextWave = latestWave.wave_number + 1;
          const nextOffset = (latestWave.wave_number) * (req.worker_count_needed * 2);

          await dispatchQueue.add(
            'dispatch-wave',
            {
              requirementId: req.id,
              jobId: req.job.id,
              waveNumber: nextWave,
              offset: nextOffset,
            },
            {
              jobId: `dispatch:${req.id}:wave-${nextWave}`,
            },
          );

          report.missingWavesScheduled++;
        } else {
          // ── Case B: Wave is still active and in-flight ─────────────────────────
          // Re-queue BullMQ timeout with remaining delay to ensure it doesn't get lost
          const remainingDelayMs = Math.max(500, waveExpiresAtMs - now);
          console.log(
            `[dispatchReconciliation] Requirement ${req.id} wave ${latestWave.wave_number} is still active — re-queuing timeout in ${remainingDelayMs}ms`,
          );

          await timeoutQueue.add(
            'wave-timeout',
            {
              requirementId: req.id,
              jobId: req.job.id,
              waveNumber: latestWave.wave_number,
              totalWorkersFound: latestWave.workers_notified ?? 30,
              offset: (latestWave.wave_number - 1) * (req.worker_count_needed * 2),
              waveSize: latestWave.workers_notified ?? (req.worker_count_needed * 2),
            },
            {
              delay: remainingDelayMs,
              jobId: `wave-timeout:${req.id}:wave-${latestWave.wave_number}`,
            },
          );

          report.activeTimeoutsRestored++;
        }
      } else if (!latestWave) {
        // ── Case C: Requirement has NO waves dispatched yet ────────────────────
        console.log(
          `[dispatchReconciliation] Requirement ${req.id} has no waves — enqueuing initial wave 1`,
        );

        await dispatchQueue.add(
          'dispatch-wave',
          {
            requirementId: req.id,
            jobId: req.job.id,
            waveNumber: 1,
            offset: 0,
          },
          {
            jobId: `dispatch:${req.id}:wave-1`,
          },
        );

        report.missingWavesScheduled++;
      }
    } catch (err: any) {
      console.error(
        `[dispatchReconciliation] Failed to reconcile requirement ${req.id}:`,
        err.message || err,
      );
      report.errors.push({
        requirementId: req.id,
        error: err.message || String(err),
      });
    }
  }

  console.log(
    `[dispatchReconciliation] ✅ Reconciliation complete. Scanned: ${report.scannedRequirements}, Expired Closed: ${report.expiredWavesClosed}, Timeouts Restored: ${report.activeTimeoutsRestored}, Waves Scheduled: ${report.missingWavesScheduled}`,
  );

  return report;
}
