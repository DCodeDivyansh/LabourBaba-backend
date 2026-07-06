import prisma from '../config/prisma';
import { CreateJobReq } from '../type/api_req.type';
import { dispatchJobSimple } from './simpleDispatch';
// BullMQ import kept for reference — uncomment to switch back:
// import { dispatchQueue } from '../config/bullmq'

export const jobService = {
  async createJob(payload: CreateJobReq) {
    const job = await prisma.$transaction(async (tx) => {
      const job = await tx.job.create({
        data: {
          customer_id: payload.customer_id,
          latitude: payload.latitude,
          longitude: payload.longitude,
          location: payload.location,
          status: 'OPEN',
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

      if (payload.requirements && payload.requirements.length > 0) {
        for (const req of payload.requirements) {
          await tx.job_requirement.create({
            data: {
              job_id: job.id,
              skill_type: req.skill_type,
              worker_count_needed: req.worker_count_needed,
              rate_per_day: req.rate_per_day,
              status: 'OPEN',
            },
          });
        }
      }
      return job;
    });

    // Fetch created requirements with fields needed for dispatch
    const createdRequirements = await prisma.job_requirement.findMany({
      where: { job_id: job.id },
      select: { id: true, skill_type: true, rate_per_day: true },
    });
    console.log("[jobService] requirements", createdRequirements);

    // Fire dispatch for all requirements in parallel — no await needed
    // Runs in background, doesn't slow down API response
    // Problem 4: pass job object directly — no extra DB query inside dispatch
    dispatchJobSimple(job, createdRequirements)
      .catch((err) => console.error('[dispatch] error:', err));

    return job;
  },

  async getJobsByCustomer(customerId: string) {
    return await prisma.job.findMany({
      where: { customer_id: customerId },
      include: { job_requirement: true }
    });
  },

  async getJobDetail(jobId: string) {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: {
        job_requirement: { include: { job_dispatch: true } }
      }
    });
    if (!job) throw new Error("Job not found");
    return job;
  },

  async cancelJob(jobId: string, customerId: string) {
    return await prisma.$transaction(async (tx) => {
      const job = await tx.job.findUnique({ where: { id: jobId } });
      if (!job) throw new Error("Job not found");
      if (job.customer_id !== customerId) throw new Error("Unauthorized");
      if (job.status === "COMPLETED") throw new Error("Cannot cancel a completed job");

      await tx.job.update({
        where: { id: jobId },
        data: { status: "CANCELLED" }
      });

      await tx.job_requirement.updateMany({
        where: { job_id: jobId },
        data: { status: "CANCELLED" }
      });

      // Also cancel pending dispatches
      const reqs = await tx.job_requirement.findMany({ where: { job_id: jobId } });
      for (const r of reqs) {
        await tx.job_dispatch.updateMany({
          where: { requirement_id: r.id, status: "PENDING" },
          data: { status: "CANCELLED" }
        });
      }

      return { success: true, message: "Job cancelled" };
    });
  },

  async getJobRequirements(jobId: string) {
    return await prisma.job_requirement.findMany({
      where: { job_id: jobId }
    });
  },

  async getJobBookings(jobId: string) {
    // Only select safe, displayable worker fields — never the password
    // hash or other sensitive data — since this is what the customer's
    // website renders directly as "worker details" once a booking exists.
    return await prisma.booking.findMany({
      where: { job_id: jobId },
      include: {
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
  }
};
