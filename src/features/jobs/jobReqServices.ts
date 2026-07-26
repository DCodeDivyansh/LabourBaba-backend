import prisma from "../../config/prisma";
import { CreateJobRequirementReq } from "../../type/api_req.type";

export const jobReqService = {
    async createJobReq(jobId: string, payload: CreateJobRequirementReq) {
        try {
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
}
