import prisma from '../../config/prisma';
// BullMQ import — commented out for simple dispatch mode:
// import { dispatchQueue } from '../config/bullmq';
import { generateOTP, hashOTP } from '../../utils/authUtils';
import { Prisma } from '@prisma/client';
import { io } from '../../server';
import { customerSummarySelect, bookingSafeSelect, toDispatchDTO, toWorkerPublicDTO, toDispatchWaveDTO } from '../../shared/prismaSelects';
import { PolicyActor, AuthorizationError, UserRole } from '../../policies';

import { jobStateService, JobAction } from '../jobs/jobStateMachine';
import {
  RequirementStatus,
  RequirementAction,
  requirementStateService,
} from '../jobs/requirementStateMachine';

// ── Helper: check if all requirements for a job are filled ──────────────────

async function checkJobComplete(
  jobId: string,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const unfilledCount = await tx.job_requirement.count({
    where: {
      job_id: jobId,
      status: { notIn: [RequirementStatus.FILLED, 'filled', 'FILLED'] },
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
      console.warn(`[dispatchServices] Note: Job transition to BOOKED: ${err.message}`);
    }

    await tx.job.update({
      where: { id: jobId },
      data: { dispatch_status: 'fully_booked' },
    });
    console.log(`[dispatchServices] Job ${jobId} is fully booked.`);
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
  // Problem 1: atomic transaction with row-lock — only one worker wins
  const result = await prisma.$transaction(async (tx) => {
    // Row-lock to prevent race conditions when multiple workers accept simultaneously
    await tx.$queryRaw`
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
        expires_at: {
          gt: now,
        },
      },
      data: {
        status: 'accepted',
        responded_at: now,
      },
    });

    if (updateResult.count === 0) {
      // Investigate why acceptance failed for precise, safe error handling
      const existingDispatch = await tx.job_dispatch.findFirst({
        where: {
          requirement_id: requirementId,
          worker_id: workerId,
        },
        select: {
          status: true,
          expires_at: true,
        },
      });

      if (!existingDispatch) {
        throw new DispatchAcceptanceError(
          'No dispatch record found for this worker and requirement',
          'NO_VALID_DISPATCH',
          404,
        );
      }
      if (existingDispatch.status === 'accepted') {
        throw new DispatchAcceptanceError(
          'Dispatch has already been accepted',
          'DISPATCH_ALREADY_ACCEPTED',
          409,
        );
      }
      if (existingDispatch.expires_at && existingDispatch.expires_at <= now) {
        throw new DispatchAcceptanceError(
          'Dispatch has expired',
          'DISPATCH_EXPIRED',
          410,
        );
      }
      throw new DispatchAcceptanceError(
        `Dispatch is in terminal state '${existingDispatch.status}' and cannot be accepted`,
        'DISPATCH_NOT_ACTIONABLE',
        409,
      );
    }

    if (updateResult.count > 1) {
      throw new DispatchAcceptanceError(
        'Invariant violation: Multiple dispatch records updated',
        'INVARIANT_VIOLATION_MULTIPLE_DISPATCHES',
        500,
      );
    }

    // Generate and hash a fresh OTP for job start verification
    const otp = generateOTP();
    const otp_hash = await hashOTP(otp);

    // Create booking
    let booking;
    try {
      booking = await tx.booking.create({
        data: {
          job_id: req.job_id,
          requirement_id: requirementId,
          worker_id: workerId,
          customer_id: req.job.customer_id,
          status: 'confirmed',
          otp_hash,
        },
        select: bookingSafeSelect,
      });
    } catch (err: any) {
      if (
        (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') ||
        err?.code === 'P2002' ||
        err?.message?.includes('Unique constraint') ||
        err?.message?.includes('uniq_booking_requirement_worker')
      ) {
        throw new DispatchAcceptanceError(
          'Worker already has an active booking for this requirement',
          'BOOKING_ALREADY_EXISTS',
          409,
        );
      }
      throw err;
    }

    // Increment filled count and transition status through requirementStateService
    const newFilled = (req.worker_count_filled ?? 0) + 1;
    const nowFilled = newFilled >= req.worker_count_needed;

    await requirementStateService.transition(tx, {
      requirementId,
      action: RequirementAction.RECORD_ACCEPTANCE,
      actor: { id: workerId, role: UserRole.WORKER },
      newFilledCount: newFilled,
    });

    // Problem 1: when filled, expire ALL remaining pending dispatches atomically
    let expiredWorkerIds: string[] = [];
    let jobFullyBooked = false;
    if (nowFilled) {
      // Collect worker IDs of remaining pending dispatches BEFORE expiring them
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
  });

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
      console.log(
        `[dispatchServices] Notified ${result.expiredWorkerIds.length} workers that requirement ${requirementId} is filled`,
      );
    } catch (err) {
      console.error('[dispatchServices] Failed to emit job:closed:', err);
    }
  }

  // Notify the customer's website in real-time that a worker accepted the
  // job, with enough worker detail to render a card (name/phone/rating).
  // Only whitelisted fields are sent - never the password hash or other
  // sensitive worker data. This also supports the multi-worker case: the
  // frontend should append this worker to its list rather than replace it,
  // since more worker:accepted events may follow for other requirements.
  try {
    const coords = await prisma.$queryRaw<any[]>`
      SELECT
        ST_X(location_geo::geometry) AS longitude,
        ST_Y(location_geo::geometry) AS latitude
      FROM worker
      WHERE id = ${workerId}::uuid;
    `;

    const worker = await prisma.worker.findUnique({
      where: { id: workerId },
      select: { id: true, name: true, phone: true, skill_type: true, worker_score: true },
    });

    const workerWithLoc = worker ? toWorkerPublicDTO({
      id: worker.id,
      name: worker.name,
      phone: worker.phone,
      skill_type: worker.skill_type,
      worker_score: worker.worker_score,
      latitude: coords[0]?.latitude || null,
      longitude: coords[0]?.longitude || null,
    }) : null;

    io.to(`customer:${result.customerId}`).emit('worker:accepted', {
      jobId: result.jobId,
      requirementId,
      bookingId: result.booking.id,
      otp: result.otp,
      worker: workerWithLoc,
      requirement: {
        id: requirementId,
        skill_type: result.skillType,
        worker_count_needed: result.needed,
        worker_count_filled: result.newFilled,
        status: result.nowFilled ? 'filled' : 'dispatching',
      },
    });

    if (result.jobFullyBooked) {
      io.to(`customer:${result.customerId}`).emit('job:fully_booked', {
        jobId: result.jobId,
      });
    }
  } catch (err) {
    console.error('[dispatchServices] Failed to emit worker:accepted:', err);
  }

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
      select: { status: true, job_id: true, worker_count_needed: true },
    });

    if (req && req.status !== 'filled') {
      console.log(
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

      // Re-queue with next offset
      // NOTE: Commented out for simple dispatch mode — single wave only.
      // Uncomment to re-enable BullMQ multi-wave dispatch:
      const nextWaveNumber = currentWave + 1;
      const nextOffset = currentWave * (req.worker_count_needed * 2);

      console.log(
        `[dispatchServices] Would fire wave ${nextWaveNumber} at offset ${nextOffset} — skipped (simple dispatch mode)`,
      );
      // await dispatchQueue.add('dispatch-wave', {
      //   requirementId,
      //   jobId: req.job_id,
      //   waveNumber: nextWaveNumber,
      //   offset: nextOffset,
      // });
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
    getDispatchDetail(requirementId, workerId), // ⬅ NEW
};
