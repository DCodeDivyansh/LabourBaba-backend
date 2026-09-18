import prisma from "../../config/prisma";
import { CreateJobRequirementReq } from "../../type/api_req.type";
import { jobPolicy, PolicyActor, assertPolicy } from "../../policies";

export const jobReqService = {
    async createJobReq(jobId: string, payload: CreateJobRequirementReq, actor?: PolicyActor) {
        try {
            if (actor) {
                const job = await prisma.job.findUnique({ where: { id: jobId } });
                if (!job) throw new Error("Job not found");
                assertPolicy(jobPolicy.canCreateRequirement(actor, job));
            }
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
        } catch (error) {
            throw error;
        }
    }
};
