import prisma from '../../config/prisma';
import { dispatchQueue, timeoutQueue } from '../../config/bullmq';
import { RequirementStatus } from '../jobs/requirementStateMachine';
import { JobStatus } from '../jobs/jobStateMachine';
import { dispatchWaveConfig } from '../../config/dispatchWaveConfig';
import { planDispatchWave } from './wavePlanner';
import { generateDispatchOperationId } from './dispatchOperation';
import { logger } from '../../utils/logger';

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

  logger.info('[dispatchReconciliation] 🔍 Starting startup dispatch reconciliation scan...');

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
  logger.info(`[dispatchReconciliation] Found ${candidateRequirements.length} dispatchable requirement(s)`, { count: candidateRequirements.length });

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
        const waveExpiresAtMs = notifiedAtMs + dispatchWaveConfig.timeoutMs;

        if (waveExpiresAtMs <= now) {
          // ── Case A: Wave expired while system was down ────────────────────────
          logger.info(
            `[dispatchReconciliation] Requirement ${req.id} wave ${latestWave.wave_number} expired during downtime — resolving wave`,
            { requirementId: req.id, waveNumber: latestWave.wave_number }
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
          const nextPlan = planDispatchWave({
            workerCountNeeded: req.worker_count_needed,
            workersAlreadyAssigned: req.worker_count_filled ?? 0,
            waveNumber: nextWave,
          });
          if (!nextPlan.canDispatch) {
            await prisma.job_requirement.update({
              where: { id: req.id }, data: { status: RequirementStatus.NO_WORKERS_AVAILABLE },
            });
            continue;
          }
          const nextOffset = (latestWave.wave_number) * (latestWave.workers_notified ?? nextPlan.targetCandidateCount);
          const nextOperationId = generateDispatchOperationId({
            requirementId: req.id,
            waveNumber: nextWave,
          });

          await dispatchQueue.add(
            'dispatch-wave',
            {
              operationId: nextOperationId,
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
          const activeOperationId = generateDispatchOperationId({
            requirementId: req.id,
            waveNumber: latestWave.wave_number,
          });
          logger.info(
            `[dispatchReconciliation] Requirement ${req.id} wave ${latestWave.wave_number} is still active — re-queuing timeout in ${remainingDelayMs}ms`,
            { requirementId: req.id, waveNumber: latestWave.wave_number, remainingDelayMs }
          );

          await timeoutQueue.add(
            'wave-timeout',
            {
              operationId: activeOperationId,
              requirementId: req.id,
              jobId: req.job.id,
              waveNumber: latestWave.wave_number,
              totalWorkersFound: latestWave.workers_notified ?? 30,
              offset: (latestWave.wave_number - 1) * (latestWave.workers_notified ?? 0),
              waveSize: latestWave.workers_notified ?? 0,
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
        const wave1OperationId = generateDispatchOperationId({
          requirementId: req.id,
          waveNumber: 1,
        });
        logger.info(
          `[dispatchReconciliation] Requirement ${req.id} has no waves — enqueuing initial wave 1 (operation ${wave1OperationId})`,
          { requirementId: req.id, operationId: wave1OperationId }
        );

        await dispatchQueue.add(
          'dispatch-wave',
          {
            operationId: wave1OperationId,
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
      logger.error(
        `[dispatchReconciliation] Failed to reconcile requirement ${req.id}:`,
        { requirementId: req.id, error: err.message || err }
      );
      report.errors.push({
        requirementId: req.id,
        error: err.message || String(err),
      });
    }
  }

  logger.info(
    `[dispatchReconciliation] ✅ Reconciliation complete. Scanned: ${report.scannedRequirements}, Expired Closed: ${report.expiredWavesClosed}, Timeouts Restored: ${report.activeTimeoutsRestored}, Waves Scheduled: ${report.missingWavesScheduled}`,
    { report }
  );

  return report;
}
