import prisma from "../../config/prisma";
import { CreateJobRequirementReq } from "../../type/api_req.type";
import { jobPolicy, requirementPolicy, PolicyActor, assertPolicy, AuthorizationError, UserRole } from "../../policies";
import {
  RequirementStatus,
  RequirementInvalidWorkerCountError,
  requirementStateService,
  RequirementAction,
} from "./requirementStateMachine";

export const jobReqService = {
  async createJobReq(jobId: string, payload: CreateJobRequirementReq, actor?: PolicyActor) {
    if (!actor) {
      throw new AuthorizationError("Authentication required", 401, "UNAUTHORIZED");
    }
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) throw new Error("Job not found");
    assertPolicy(jobPolicy.canCreateRequirement(actor, job));

    if (!payload.worker_count_needed || !Number.isInteger(payload.worker_count_needed) || payload.worker_count_needed <= 0) {
      throw new RequirementInvalidWorkerCountError("worker_count_needed must be an integer >= 1");
    }

    return await prisma.job_requirement.create({
      data: {
        job_id: jobId,
        skill_type: payload.skill_type,
        worker_count_needed: payload.worker_count_needed,
        rate_per_day: payload.rate_per_day,
        wave_size: payload.wave_size,
        status: RequirementStatus.OPEN,
        worker_count_filled: 0,
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
        booking: { select: { worker_id: true, status: true } },
      },
    });
    if (!req) throw new Error("Requirement not found");
    assertPolicy(requirementPolicy.canRead(actor, req));
    return req;
  },

  async updateRequirementDemand(
    jobId: string,
    requirementId: string,
    newWorkerCountNeeded: number,
    actor?: PolicyActor
  ) {
    if (!actor) {
      throw new AuthorizationError("Authentication required", 401, "UNAUTHORIZED");
    }

    return await prisma.$transaction(async (tx) => {
      const req = await tx.job_requirement.findFirst({
        where: { id: requirementId, job_id: jobId },
        include: { job: { select: { customer_id: true } } },
      });
      if (!req) throw new Error("Requirement not found");

      assertPolicy(requirementPolicy.canUpdate(actor, req));

      const effectiveActor = {
        id: actor.id,
        role: actor.role,
        phone: actor.phone,
      };

      return await requirementStateService.updateDemand(
        tx,
        requirementId,
        newWorkerCountNeeded,
        effectiveActor
      );
    });
  },
};
