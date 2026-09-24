import prisma from '../../config/prisma';
import { dispatchQueue } from '../../config/bullmq';
import { generateOTP, hashOTP } from '../../utils/authUtils';
import { Prisma } from '@prisma/client';
import { io } from '../../server';
import { customerSummarySelect, bookingSafeSelect, toDispatchDTO, toWorkerPublicDTO, toDispatchWaveDTO } from '../../shared/prismaSelects';
import { PolicyActor, AuthorizationError, UserRole } from '../../policies';

import { jobStateService, JobAction, JobInvalidTransitionError, JobStatus } from '../jobs/jobStateMachine';
import {
  RequirementStatus,
  RequirementAction,
  requirementStateService,
} from '../jobs/requirementStateMachine';
import { BookingStatus } from '../booking/bookingStateMachine';
import { bookingConfig } from '../../config/bookingConfig';
import { generateDispatchOperationId } from './dispatchOperation';
import { planDispatchWave } from './wavePlanner';
import { metricsService } from '../../metrics/metrics.service';

import { logger } from '../../utils/logger';

// ── Helper: check if all requirements for a job are filled ──────────────────

async function checkJobComplete(
  jobId: string,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const unfilledCount = await tx.job_requirement.count({
    where: {
      job_id: jobId,
      status: { notIn: [RequirementStatus.FILLED] },
    },
  });

  if (unfilledCount === 0) {
    try {
      await jobStateService.transition(tx, {
        jobId,
        action: JobAction.MARK_BOOKED,
        actor: { role: "SYSTEM" },
        reason: "All job requirements filled",
      });
    } catch (err: any) {
      // P5 Issue 14: Only suppress explicitly proven idempotent conditions.
      if (
        err instanceof JobInvalidTransitionError &&
        (err.fromStatus === JobStatus.BOOKED ||
          err.fromStatus === JobStatus.IN_PROGRESS ||
          err.fromStatus === JobStatus.COMPLETED)
      ) {
        // Safe idempotent ignore: job was already transitioned
      } else {
        // Any unexpected database/Prisma/domain error MUST propagate to abort the transaction!
        throw err;
      }
    }

    await tx.job.update({
      where: { id: jobId },
      data: { dispatch_status: 'FILLED' },
    });
    logger.info(`[dispatchServices] Job ${jobId} is fully booked.`);
    return true;
  }
  return false;
}

export class DispatchAcceptanceError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, code: string, statusCode: number = 400) {
    super(message);
    this.name = 'DispatchAcceptanceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ── Accept ───────────────────────────────────────────────────────────────────

export const acceptDispatch = async (requirementId: string, workerId: string) => {
  // 1. Fast-path non-locking pre-flight checks in parallel outside transaction to immediately reject
  // obviously ineligible/filled requests without consuming connection pool capacity or waiting on locks.
  const [preReq, preDispatch] = await Promise.all([
    prisma.job_requirement.findUnique({
      where: { id: requirementId },
      select: {
        id: true,
        job_id: true,
        status: true,
        worker_count_filled: true,
        worker_count_needed: true,
        skill_type: true,
        job: {
          select: {
            id: true,
            status: true,
            customer_id: true,
          },
        },
      },
    }),
    prisma.job_dispatch.findFirst({
      where: { requirement_id: requirementId, worker_id: workerId },
      select: { id: true, status: true, expires_at: true },
    }),
  ]);

  // Fast pre-flight rejections (only if records were fetched; otherwise let transaction authoritatively evaluate)
  if (preReq) {
    if (
      preReq.status?.toUpperCase() === RequirementStatus.CANCELLED ||
      preReq.job?.status?.toUpperCase() === 'CANCELLED' ||
      preReq.job?.status?.toUpperCase() === 'COMPLETED'
    ) {
      throw new DispatchAcceptanceError(
        'Requirement or job is no longer active',
        'REQUIREMENT_CANCELLED',
        409,
      );
    }

    if (
      preReq.status?.toUpperCase() === RequirementStatus.FILLED ||
      (preReq.worker_count_filled ?? 0) >= preReq.worker_count_needed
    ) {
      throw new DispatchAcceptanceError('Requirement slots are already full', 'SLOTS_FULL', 409);
    }
  }

  if (preDispatch) {
    if (preDispatch.status === 'accepted') {
      throw new DispatchAcceptanceError(
        'This dispatch has already been accepted',
        'DISPATCH_ALREADY_ACCEPTED',
        409,
      );
    }

    if (
      preDispatch.status === 'declined' ||
      preDispatch.status === 'timeout' ||
      preDispatch.status === 'expired'
    ) {
      if (
        preDispatch.status === 'expired' &&
        preReq &&
        ((preReq.worker_count_filled ?? 0) >= preReq.worker_count_needed ||
          preReq.status?.toUpperCase() === RequirementStatus.FILLED)
      ) {
        throw new DispatchAcceptanceError('Requirement slots are already full', 'SLOTS_FULL', 409);
      }
      throw new DispatchAcceptanceError(
        `Dispatch is in terminal state: ${preDispatch.status}`,
        'DISPATCH_NOT_ACTIONABLE',
        409,
      );
    }

    const nowPre = new Date();
    if (preDispatch.expires_at && preDispatch.expires_at <= nowPre) {
      throw new DispatchAcceptanceError('Dispatch has expired', 'DISPATCH_EXPIRED', 410);
    }
  }

  let result: any;
  try {
    result = await prisma.$transaction(
      async (tx) => {
        // PostgreSQL FOR UPDATE serializes capacity reservations on the requirement row
        await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM job_requirement
          WHERE id = ${requirementId}::uuid FOR UPDATE
        `;

        const req = await tx.job_requirement.findUnique({
          where: { id: requirementId },
          include: { job: true },
        });

        if (!req) {
          throw new DispatchAcceptanceError('Requirement not found', 'REQUIREMENT_NOT_FOUND', 404);
        }
        if (
          req.status?.toUpperCase() === RequirementStatus.CANCELLED ||
          req.job?.status?.toUpperCase() === 'CANCELLED' ||
          req.job?.status?.toUpperCase() === 'COMPLETED'
        ) {
          throw new DispatchAcceptanceError(
            'Requirement or job is no longer active',
            'REQUIREMENT_CANCELLED',
            409,
          );
        }
        const isAlreadyFull =
          req.status?.toUpperCase() === RequirementStatus.FILLED ||
          (req.worker_count_filled ?? 0) >= req.worker_count_needed;
        if (isAlreadyFull) {
          throw new DispatchAcceptanceError('Requirement slots are already full', 'SLOTS_FULL', 409);
        }

        // Guard: ensure worker does not already have a confirmed booking for this requirement
        const existingBooking = await tx.booking.findFirst({
          where: {
            requirement_id: requirementId,
            worker_id: workerId,
          },
        });
        if (existingBooking) {
          throw new DispatchAcceptanceError(
            'Worker already has an active booking for this requirement',
            'BOOKING_ALREADY_EXISTS',
            409,
          );
        }

        // Atomic conditional transition: must be pending, non-expired, matching exact requirement and worker
        const now = new Date();
        const updateResult = await tx.job_dispatch.updateMany({
          where: {
            requirement_id: requirementId,
            worker_id: workerId,
            status: 'pending',
            expires_at: { gt: now },
          },
          data: {
            status: 'accepted',
            responded_at: now,
          },
        });

        if (updateResult.count === 0) {
          const dispatchRow = await tx.job_dispatch.findFirst({
            where: { requirement_id: requirementId, worker_id: workerId },
          });

          if (!dispatchRow) {
            throw new DispatchAcceptanceError(
              'No valid dispatch found for this worker on this requirement',
              'NO_VALID_DISPATCH',
              404,
            );
          }

          if (dispatchRow.status === 'accepted') {
            throw new DispatchAcceptanceError(
              'This dispatch has already been accepted',
              'DISPATCH_ALREADY_ACCEPTED',
              409,
            );
          }

          if (
            dispatchRow.status === 'declined' ||
            dispatchRow.status === 'timeout' ||
            dispatchRow.status === 'expired'
          ) {
            if (
              dispatchRow.status === 'expired' &&
              ((req.worker_count_filled ?? 0) >= req.worker_count_needed ||
                req.status?.toUpperCase() === RequirementStatus.FILLED)
            ) {
              throw new DispatchAcceptanceError('Requirement slots are already full', 'SLOTS_FULL', 409);
            }
            throw new DispatchAcceptanceError(
              `Dispatch is in terminal state: ${dispatchRow.status}`,
              'DISPATCH_NOT_ACTIONABLE',
              409,
            );
          }

          if (dispatchRow.expires_at && dispatchRow.expires_at <= now) {
            throw new DispatchAcceptanceError(
              'Dispatch has expired',
              'DISPATCH_EXPIRED',
              410,
            );
          }

          throw new DispatchAcceptanceError(
            'Dispatch cannot be accepted in its current state',
            'DISPATCH_NOT_ACCEPTABLE',
            409,
          );
        }

        // Capacity invariant: worker_count_filled strictly increments
        const newFilled = (req.worker_count_filled ?? 0) + 1;
        const nowFilled = newFilled >= req.worker_count_needed;

        await tx.job_requirement.update({
          where: { id: requirementId },
          data: {
            worker_count_filled: newFilled,
            status: nowFilled ? 'FILLED' : 'PARTIALLY_FILLED',
          },
        });

        // Compute OTP and bcrypt hash ONLY for the winning transaction that reserved the slot
        const otp = generateOTP();
        const otp_hash = await hashOTP(otp);
        const otp_expires_at = new Date(Date.now() + bookingConfig.bookingOtpTtlSeconds * 1000);

        // Create the booking record with hashed OTP and set job state
        const booking = await tx.booking.create({
          data: {
            job_id: req.job_id,
            requirement_id: requirementId,
            worker_id: workerId,
            customer_id: req.job.customer_id,
            status: 'CONFIRMED',
            otp_hash,
            otp_expires_at,
            otp_attempts: 0,
          },
        });

        // Mandatory Transactional Outbox (Issue 12 / P7 Issue 09): Record booking_confirmed event atomically
        if (typeof (tx as any).notification_outbox?.create === 'function') {
          await (tx as any).notification_outbox.create({
            data: {
              event_type: 'booking_confirmed',
              aggregate_type: 'booking',
              aggregate_id: booking.id,
              aggregate_version: 1,
              recipient_type: 'customer',
              recipient_id: req.job.customer_id,
              payload: {
                bookingId: booking.id,
                jobId: req.job_id,
                requirementId,
                workerId,
                skillType: req.skill_type,
                otp,
                title: 'Worker Confirmed',
                body: 'A worker has accepted and confirmed your booking.',
              },
              idempotency_key: `booking_confirmed:${booking.id}:customer:${req.job.customer_id}`,
              status: 'PENDING',
              socket_status: 'PENDING',
              fcm_status: 'PENDING',
            },
          });
        }

        let expiredWorkerIds: string[] = [];
        let jobFullyBooked = false;

        // 5. If this requirement is now full:
        if (nowFilled) {
          const pendingDispatches = await tx.job_dispatch.findMany({
            where: {
              requirement_id: requirementId,
              status: 'pending',
            },
            select: { worker_id: true },
          });
          expiredWorkerIds = pendingDispatches.map((d) => d.worker_id);

          // Expire all remaining pending dispatches
          await tx.job_dispatch.updateMany({
            where: {
              requirement_id: requirementId,
              status: 'pending',
            },
            data: { status: 'expired', responded_at: new Date() },
          });

          // Check if ALL requirements for this job are now filled → mark job fully_booked
          jobFullyBooked = await checkJobComplete(req.job_id, tx);
        }

        return {
          booking,
          otp,
          nowFilled,
          newFilled,
          needed: req.worker_count_needed,
          jobId: req.job_id,
          customerId: req.job.customer_id,
          skillType: req.skill_type,
          expiredWorkerIds,
          jobFullyBooked,
        };
      },
      {
        maxWait: 15_000,
        timeout: 30_000,
      }
    );
  } catch (err: any) {
    if (err instanceof DispatchAcceptanceError) {
      throw err;
    }
    // Handle Prisma unique constraint violations (P2002)
    if (err.code === 'P2002' || err.message?.includes('23505')) {
      const target = err.meta?.target || [];
      if (
        (Array.isArray(target) && target.includes('worker_id')) ||
        err.message?.includes('uniq_booking_requirement_worker') ||
        err.message?.includes('uniq_job_dispatch_req_worker')
      ) {
        throw new DispatchAcceptanceError(
          'Worker already has an active booking for this requirement',
          'BOOKING_ALREADY_EXISTS',
          409,
        );
      }
    }
    // Handle PostgreSQL capacity check constraint violation (chk_job_requirement_worker_count_capacity)
    if (
      err.code === '23514' ||
      err.message?.includes('chk_job_requirement_worker_count_capacity') ||
      err.message?.includes('23514')
    ) {
      throw new DispatchAcceptanceError('Requirement slots are already full', 'SLOTS_FULL', 409);
    }
    // If transaction failed due to conflict/lock timeout (P2034, P2028, DriverAdapterError, deadlock, lock timeout), check if requirement was filled by the winner
    if (
      err.code === 'P2034' ||
      err.code === 'P2028' ||
      err.name === 'DriverAdapterError' ||
      err.constructor?.name === 'DriverAdapterError' ||
      err.message?.includes('deadlock') ||
      err.message?.includes('timeout') ||
      err.message?.includes('Transaction') ||
      err.message?.includes('lock') ||
      err.message?.includes('could not obtain lock') ||
      err.message?.includes('canceling statement')
    ) {
      const [latestReq, existingBooking] = await Promise.all([
        prisma.job_requirement.findUnique({
          where: { id: requirementId },
        }),
        prisma.booking.findFirst({
          where: { requirement_id: requirementId, worker_id: workerId },
        }),
      ]);
      if (existingBooking) {
        throw new DispatchAcceptanceError(
          'Worker already has an active booking for this requirement',
          'BOOKING_ALREADY_EXISTS',
          409,
        );
      }
      if (
        latestReq &&
        (latestReq.status?.toUpperCase() === RequirementStatus.FILLED ||
          (latestReq.worker_count_filled ?? 0) >= latestReq.worker_count_needed)
      ) {
        throw new DispatchAcceptanceError('Requirement slots are already full', 'SLOTS_FULL', 409);
      }
    }
    throw err;
  }

  // Problem 2: AFTER transaction commits, notify remaining workers via Socket.IO
  // This runs outside the transaction so it doesn't block or rollback on socket errors
  if (result.nowFilled && result.expiredWorkerIds.length > 0) {
    try {
      for (const losingWorkerId of result.expiredWorkerIds) {
        io?.to(`worker:${losingWorkerId}`)?.emit('job:closed', {
          requirementId,
          jobId: result.jobId,
          reason: 'filled',
        });
      }
      logger.info(
        `[dispatchServices] Notified ${result.expiredWorkerIds.length} workers that requirement ${requirementId} is filled`,
      );
    } catch (err: any) {
      logger.error('[dispatchServices] Failed to emit job:closed:', { error: err.message });
    }
  }

  // SINGLE CANONICAL NOTIFICATION PIPELINE (P7 Issue 09 / Issue 12 / Issue 22):
  // Direct Socket.IO emission from the API path is removed to prevent duplicate-emission
  // and race conditions with the authoritative transactional outbox worker.
  // The business transaction committed the durable outbox event 'booking_confirmed',
  // which outboxWorker delivers with deterministic idempotency to both Socket.IO and FCM.

  try {
    metricsService.recordDispatchAccept(1000);
    metricsService.recordBookingCreated();
  } catch {}

  return result;
};

// ── Decline ──────────────────────────────────────────────────────────────────

export const declineDispatch = async (requirementId: string, workerId: string) => {
  // 1. Mark dispatch as declined and increment worker's decline_count
  await prisma.$transaction(async (tx) => {
    await tx.job_dispatch.updateMany({
      where: {
        requirement_id: requirementId,
        worker_id: workerId,
        status: 'pending',
      },
      data: { status: 'declined', responded_at: new Date() },
    });

    await tx.worker.update({
      where: { id: workerId },
      data: { decline_count: { increment: 1 } },
    });
  });

  // 2. Check if any pending dispatches remain in the current wave
  const currentWaveDispatch = await prisma.job_dispatch.findFirst({
    where: { requirement_id: requirementId, worker_id: workerId },
    select: { wave_number: true },
    orderBy: { notified_at: 'desc' },
  });

  if (!currentWaveDispatch) {
    return { success: true, message: 'Job declined' };
  }

  // wave_number is nullable in schema — guard before using
  const currentWave = currentWaveDispatch.wave_number ?? 1;

  const pendingCount = await prisma.job_dispatch.count({
    where: {
      requirement_id: requirementId,
      wave_number: currentWave,
      status: 'pending',
    },
  });

  // 3. If no pending left and requirement not yet filled → fire next wave immediately
  if (pendingCount === 0) {
    const req = await prisma.job_requirement.findUnique({
      where: { id: requirementId },
      select: { status: true, job_id: true, worker_count_needed: true, worker_count_filled: true },
    });

    if (req && req.status !== 'filled') {
      logger.info(
        `[dispatchServices] All wave ${currentWave} workers responded for requirement ${requirementId}. Firing next wave immediately.`,
      );

      // Close current wave
      await prisma.dispatch_wave.updateMany({
        where: {
          requirement_id: requirementId,
          wave_number: currentWave,
        },
        data: { status: 'exhausted', resolved_at: new Date() },
      });

      // Re-queue with next offset via BullMQ
      const nextWaveNumber = currentWave + 1;
      const nextPlan = planDispatchWave({
        workerCountNeeded: req.worker_count_needed,
        workersAlreadyAssigned: req.worker_count_filled ?? 0,
        waveNumber: nextWaveNumber,
      });
      if (!nextPlan.canDispatch) {
        await prisma.job_requirement.update({
          where: { id: requirementId }, data: { status: RequirementStatus.NO_WORKERS_AVAILABLE },
        });
        return { success: true, message: 'Job declined' };
      }

      // Note: Because excludeDispatched=true is enforced in SQL, already-dispatched
      // workers are removed from the query candidate set. Offset is 0 for the un-dispatched pool.
      const nextOffset = 0;

      const operationId = generateDispatchOperationId({
        requirementId,
        waveNumber: nextWaveNumber,
      });

      logger.info(
        `[dispatchServices] Firing wave ${nextWaveNumber} (operation ${operationId}) at offset ${nextOffset} via BullMQ`,
      );
      try {
        await dispatchQueue.add(
          'dispatch-wave',
          {
            operationId,
            requirementId,
            jobId: req.job_id,
            waveNumber: nextWaveNumber,
            offset: nextOffset,
          },
          {
            jobId: `dispatch:${requirementId}:wave-${nextWaveNumber}`,
          },
        );
      } catch (err: any) {
        logger.error(`[dispatchServices] Failed to enqueue wave ${nextWaveNumber} for requirement ${requirementId}:`, { error: err?.message });
      }
    }
  }

  return { success: true, message: 'Job declined' };
};

// ── Get Incoming (worker polling) ────────────────────────────────────────────

export const getIncomingDispatches = async (workerId: string) => {
  const dispatches = await prisma.job_dispatch.findMany({
    where: { worker_id: workerId, status: 'pending' },
    include: {
      job_requirement: {
        include: { job: { include: { customer: { select: customerSummarySelect } } } },
      },
    },
    orderBy: { notified_at: 'desc' },
  });
  return dispatches.map(toDispatchDTO);
};

// ── Get Single Dispatch Detail (for expired/tapped-notification checks) ─────
export const getDispatchDetail = async (requirementId: string, workerId: string) => {
  const dispatch = await prisma.job_dispatch.findFirst({
    where: { requirement_id: requirementId, worker_id: workerId },
    include: {
      job_requirement: {
        include: { job: { include: { customer: { select: customerSummarySelect } } } },
      },
    },
  });
  if (!dispatch) throw new Error("Dispatch not found");
  return toDispatchDTO(dispatch);
};

// ── Get Waves (for a requirement) ────────────────────────────────────────────
export const getWaves = async (requirementId: string, actor?: PolicyActor) => {
  if (actor) {
    const req = await prisma.job_requirement.findUnique({
      where: { id: requirementId },
      include: {
        job: { select: { customer_id: true } },
      },
    });
    if (!req) throw new Error("Requirement not found");
    if (actor.role === UserRole.CUSTOMER) {
      if (req.job?.customer_id !== actor.id) {
        throw new AuthorizationError("Requirement not found", 404, "RESOURCE_NOT_FOUND");
      }
    } else if (actor.role !== UserRole.ADMIN) {
      throw new AuthorizationError("Requirement not found", 404, "RESOURCE_NOT_FOUND");
    }
  }

  const waves = await prisma.dispatch_wave.findMany({
    where: { requirement_id: requirementId },
    orderBy: { wave_number: 'asc' },
  });
  const dispatches = await prisma.job_dispatch.findMany({
    where: { requirement_id: requirementId },
    orderBy: { wave_position: 'asc' },
  });
  return {
    waves: waves.map(toDispatchWaveDTO).filter(Boolean),
    dispatches: dispatches.map(toDispatchDTO).filter(Boolean),
  };
};

// ── Legacy export shape (keeps controller imports working) ───────────────────

export const dispatchService = {
  getIncomingJob: (workerId: string) => getIncomingDispatches(workerId),
  acceptJob: (requirementId: string, workerId: string) =>
    acceptDispatch(requirementId, workerId),
  declineJob: (requirementId: string, workerId: string) =>
    declineDispatch(requirementId, workerId),
  getWaves: (requirementId: string, actor?: PolicyActor) => getWaves(requirementId, actor),
  getDispatchDetail: (requirementId: string, workerId: string) =>
    getDispatchDetail(requirementId, workerId),
};
