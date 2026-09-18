import prisma from "../../config/prisma";
import { CreateJobRequirementReq } from "../../type/api_req.type";
import { jobPolicy, requirementPolicy, PolicyActor, assertPolicy, AuthorizationError } from "../../policies";

export const jobReqService = {
  async createJobReq(jobId: string, payload: CreateJobRequirementReq, actor?: PolicyActor) {
    if (!actor) {
      throw new AuthorizationError("Authentication required", 401, "UNAUTHORIZED");
    }
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new Error("Job not found");
    assertPolicy(jobPolicy.canCreateRequirement(actor, job));

    return await prisma.job_requirement.create({
      data: {
        job_id: jobId,
        skill_type: payload.skill_type,
        worker_count_needed: payload.worker_count_needed,
        rate_per_day: payload.rate_per_day,
        wave_size: payload.wave_size,
        status: "OPEN",
      },
    });
  },

  async getRequirementDetail(jobId: string, requirementId: string, actor?: PolicyActor) {
    if (!actor) {
      throw new AuthorizationError("Authentication required", 401, "UNAUTHORIZED");
    }
    const req = await prisma.job_requirement.findFirst({
      where: { id: requirementId, job_id: jobId },
      include: {
        job: { select: { customer_id: true } },
        job_dispatch: { select: { worker_id: true } },
        booking: { select: { worker_id: true } },
      },
    });
    if (!req) throw new Error("Requirement not found");
    assertPolicy(requirementPolicy.canRead(actor, req));
    return req;
  },
};
