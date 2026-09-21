import prisma from '../../config/prisma';
import { CreateJobReq } from '../../type/api_req.type';
import { dispatchQueue } from '../../config/bullmq';
import { bookingSafeSelect } from '../../shared/prismaSelects';
import { jobPolicy, assertPolicy, AuthenticatedUser, PolicyActor, AuthorizationError, UserRole } from '../../policies';
import { jobStateService, JobAction, JobStatus, JobTransitionActor } from './jobStateMachine';
import { RequirementStatus } from './requirementStateMachine';
import { generateDispatchOperationId } from '../dispatch/dispatchOperation';

export const jobService = {
  async createJob(customerId: string, payload: CreateJobReq) {
    const job = await prisma.$transaction(async (tx) => {
      const job = await tx.job.create({
        data: {
          customer_id: customerId,
          latitude: payload.latitude,
          longitude: payload.longitude,
          location: payload.location,
          status: JobStatus.OPEN,
          dispatch_status: 'PENDING',
        },
      });
      try {
        await tx.$executeRaw`
          UPDATE job
          SET location_geo = ST_SetSRID(
            ST_MakePoint(${payload.longitude}, ${payload.latitude}),
            4326
          )::geography
          WHERE id = ${job.id}::uuid;
        `;
      } catch (err) {
        console.error("UPDATE failed:", err);
      }

      // Record initial creation in transition history
      try {
        if ((tx as any).job_transition?.create) {
          await (tx as any).job_transition.create({
            data: {
              job_id: job.id,
              from_status: "INITIAL",
              to_status: JobStatus.OPEN,
              action: JobAction.CREATE,
              actor_type: UserRole.CUSTOMER,
              actor_id: customerId,
              reason: "Job created by customer",
            },
          });
        }
      } catch (histErr: any) {
        console.warn(`[jobService] Could not write initial transition: ${histErr?.message}`);
      }

      if (payload.requirements && payload.requirements.length > 0) {
        for (const req of payload.requirements) {
          await tx.job_requirement.create({
            data: {
              job_id: job.id,
              skill_type: req.skill_type,
              worker_count_needed: req.worker_count_needed,
              rate_per_day: req.rate_per_day,
              status: RequirementStatus.OPEN,
              worker_count_filled: 0,
            },
          });
        }
      }
      return job;
    });

    // Fetch created requirements with fields needed for dispatch
    const createdRequirements = await prisma.job_requirement.findMany({
      where: { job_id: job.id },
      select: { id: true, skill_type: true, rate_per_day: true, worker_count_needed: true },
    });
    console.log("[jobService] requirements", createdRequirements);

    // Transition job to SEARCHING and requirements to DISPATCHING
    try {
      await prisma.$transaction(async (tx) => {
        await jobStateService.transition(tx, {
          jobId: job.id,
          action: JobAction.START_DISPATCH,
          actor: { role: "SYSTEM" },
          reason: "BullMQ dispatch wave initiated",
        });
        await tx.job_requirement.updateMany({
          where: { job_id: job.id, status: RequirementStatus.OPEN },
          data: { status: RequirementStatus.DISPATCHING },
        });
      });
    } catch (err: any) {
      console.warn(`[jobService] Transition to SEARCHING note: ${err?.message}`);
    }

    // Fire BullMQ dispatch for all requirements with deterministic job IDs
    // Durable, crash-resilient dispatch scheduling backed by Redis
    await Promise.all(
      createdRequirements.map(async (req) => {
        try {
          const operationId = generateDispatchOperationId({ requirementId: req.id, waveNumber: 1 });
          await dispatchQueue.add(
            'dispatch-wave',
            {
              operationId,
              requirementId: req.id,
              jobId: job.id,
              waveNumber: 1,
              offset: 0,
            },
            {
              jobId: `dispatch:${req.id}:wave-1`,
            },
          );
        } catch (err) {
          console.error(`[jobService] Failed to enqueue BullMQ dispatch job for requirement ${req.id}:`, err);
        }
      }),
    );

    return job;
  },

  async getJobsByCustomer(customerId: string) {
    return await prisma.job.findMany({
      where: { customer_id: customerId },
      include: { job_requirement: true }
    });
  },

  async getJobDetail(jobId: string, actor?: AuthenticatedUser) {
    if (!actor) {
      throw new AuthorizationError("Authentication required", 401, "UNAUTHORIZED");
    }
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: {
        booking: { select: { worker_id: true } },
        job_requirement: { include: { job_dispatch: true } },
      },
    });
    if (!job) throw new Error("Job not found");
    assertPolicy(jobPolicy.canRead(actor, job));
    return job;
  },

  async cancelJob(jobId: string, customerId: string, actor?: PolicyActor, reason?: string) {
    const effectiveActor: JobTransitionActor = actor || (customerId ? {
      id: customerId,
      role: UserRole.CUSTOMER,
      phone: "",
    } : undefined as any);

    if (!effectiveActor) {
      throw new AuthorizationError("Authentication required", 401, "UNAUTHORIZED");
    }

    return await prisma.$transaction(async (tx) => {
      // Execute cancellation strictly through the centralized state machine
      const transitionResult = await jobStateService.transition(tx, {
        jobId,
        action: JobAction.CANCEL,
        actor: effectiveActor,
        reason: reason || "Job cancelled by customer/admin",
      });

      // Synchronously cascade cancellation to open requirements and pending dispatches
      await tx.job_requirement.updateMany({
        where: { job_id: jobId, status: { notIn: ["filled", "FILLED", RequirementStatus.CANCELLED] } },
        data: { status: RequirementStatus.CANCELLED },
      });

      const reqs = await tx.job_requirement.findMany({ where: { job_id: jobId } });
      for (const r of reqs) {
        await tx.job_dispatch.updateMany({
          where: { requirement_id: r.id, status: "pending" },
          data: { status: "CANCELLED", responded_at: new Date() },
        });
      }

      return {
        success: true,
        message: "Job cancelled",
        data: transitionResult,
      };
    });
  },

  async completeJob(jobId: string, actor: JobTransitionActor, reason?: string) {
    return await prisma.$transaction(async (tx) => {
      return await jobStateService.transition(tx, {
        jobId,
        action: JobAction.COMPLETE,
        actor,
        reason: reason || "All requirements completed",
      });
    });
  },


  async getJobRequirements(jobId: string, actor?: PolicyActor) {
    if (!actor) {
      throw new AuthorizationError("Authentication required", 401, "UNAUTHORIZED");
    }
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: {
        booking: { select: { worker_id: true } },
        job_requirement: { include: { job_dispatch: true } },
      },
    });
    if (!job) throw new Error("Job not found");
    assertPolicy(jobPolicy.canRead(actor, job));

    return await prisma.job_requirement.findMany({
      where: { job_id: jobId },
    });
  },

  async getJobBookings(jobId: string, actor?: PolicyActor) {
    if (!actor) {
      throw new AuthorizationError("Authentication required", 401, "UNAUTHORIZED");
    }
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: {
        booking: { select: { worker_id: true } },
        job_requirement: { include: { job_dispatch: true } },
      },
    });
    if (!job) throw new Error("Job not found");
    assertPolicy(jobPolicy.canReadBookings(actor, job));

    // Only select safe, displayable worker fields — never the password
    // hash or other sensitive data — since this is what the customer's
    // website renders directly as "worker details" once a booking exists.
    // If called by a worker, scope strictly to their own booking.
    const whereClause: any = { job_id: jobId };
    if (actor.role === UserRole.WORKER) {
      whereClause.worker_id = actor.id;
    }

    const bookings = await prisma.booking.findMany({
      where: whereClause,
      select: {
        ...bookingSafeSelect,
        worker: {
          select: {
            id: true,
            name: true,
            phone: true,
            skill_type: true,
            worker_score: true,
          },
        },
      },
    });

    const populated = await Promise.all(
      bookings.map(async (b) => {
        if (!b.worker) return b;
        try {
          const coords = await prisma.$queryRaw<any[]>`
            SELECT
              ST_X(location_geo::geometry) AS longitude,
              ST_Y(location_geo::geometry) AS latitude
            FROM worker
            WHERE id = ${b.worker_id}::uuid;
          `;
          return {
            ...b,
            worker: {
              ...b.worker,
              latitude: coords[0]?.latitude || null,
              longitude: coords[0]?.longitude || null,
            },
          };
        } catch (err) {
          console.error(`Failed to get worker coordinates for ${b.worker_id}:`, err);
          return b;
        }
      })
    );

    return populated;
  }
};
