import { Request, Response } from "express";
import { jobService } from "./job.services";
import { jobReqService } from "./jobReqServices";
import { CreateJobReq, CreateJobRequirementReq } from "../../type/api_req.type";
import prisma from "../../config/prisma";
import { AuthenticatedRequest } from "../../middlewares/authMiddleware";
import { AuthorizationError } from "../../policies";
import {
  toJobDTO,
  toJobRequirementDTO,
  toBookingDTO,
} from "../../shared/prismaSelects";
import {
  JobStateError,
  JobNotFoundError,
  JobAuthorizationError,
  JobStateConflictError,
  JobInvalidTransitionError,
} from "./jobStateMachine";
import { logger } from "../../utils/logger";

function handleJobError(error: any, req: Request, res: Response, fallbackMessage: string): void {
  const reqLogger = (req as any).logger || logger;
  if (error instanceof AuthorizationError || error instanceof JobAuthorizationError || error.name === "RequirementAuthorizationError") {
    res.status(error.status || error.statusCode || 403).json({ success: false, code: "FORBIDDEN", message: error.message || "Forbidden" });
    return;
  }
  if (error instanceof JobNotFoundError || error.name === "RequirementNotFoundError" || error.message === "Job not found" || error.message === "Requirement not found") {
    res.status(404).json({ success: false, code: "RESOURCE_NOT_FOUND", message: error.message || "Resource not found" });
    return;
  }
  if (error instanceof JobStateConflictError || error.name === "RequirementCapacityExceededError") {
    res.status(409).json({ success: false, code: error.code || "CONFLICT", message: error.message });
    return;
  }
  if (error instanceof JobInvalidTransitionError || error.name === "RequirementInvalidWorkerCountError" || error.name === "RequirementInvalidTransitionError") {
    res.status(400).json({ success: false, code: error.code || "INVALID_INPUT", message: error.message });
    return;
  }
  if (typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500) {
    res.status(error.statusCode).json({ success: false, code: error.code || "CLIENT_ERROR", message: error.message });
    return;
  }

  reqLogger.error(`[jobController] Unexpected error:`, { error: error?.message, stack: error?.stack });
  res.status(500).json({
    success: false,
    code: "INTERNAL_SERVER_ERROR",
    message: fallbackMessage || "An unexpected internal error occurred.",
  });
}

// Create job and initial requirements strictly scoped to the authenticated customer principal
export const createJob = async (req: Request, res: Response): Promise<void> => {
  try {
    const authCustomerId = (req as AuthenticatedRequest).user?.id;
    if (!authCustomerId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const payload: CreateJobReq = req.body;
    const job = await jobService.createJob(authCustomerId, payload);
    res.status(201).json({ success: true, data: toJobDTO(job) });
  } catch (error: any) {
    handleJobError(error, req, res, "Failed to create job");
  }
};

// Retrieve jobs belonging strictly to the authenticated customer principal
export const getMyJobs = async (req: Request, res: Response): Promise<void> => {
  try {
    const customerId = (req as AuthenticatedRequest).user?.id;
    if (!customerId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const jobs = await jobService.getJobsByCustomer(customerId);
    res.status(200).json({ success: true, data: jobs.map(toJobDTO).filter(Boolean) });
  } catch (error: any) {
    handleJobError(error, req, res, "Failed to retrieve jobs");
  }
};

export const getJobDetail = async (req: Request, res: Response): Promise<void> => {
  try {
    const { jobId } = req.params as any;
    const actor = (req as AuthenticatedRequest).user;
    const job = await jobService.getJobDetail(jobId, actor);
    res.status(200).json({ success: true, data: toJobDTO(job) });
  } catch (error: any) {
    handleJobError(error, req, res, "Failed to retrieve job details");
  }
};

export const cancelJob = async (req: Request, res: Response): Promise<void> => {
  try {
    const { jobId } = req.params as any;
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const response = await jobService.cancelJob(jobId, actor.id, actor);
    res.status(200).json(response);
  } catch (error: any) {
    if (error.message?.includes("Forbidden") || error.message === "Unauthorized") {
      res.status(403).json({ success: false, message: "Forbidden: You do not own this job" });
      return;
    }
    handleJobError(error, req, res, "Failed to cancel job");
  }
};

export const getJobRequirements = async (req: Request, res: Response): Promise<void> => {
  try {
    const { jobId } = req.params as any;
    const actor = (req as AuthenticatedRequest).user;
    const requirements = await jobService.getJobRequirements(jobId, actor);
    res.status(200).json({ success: true, data: requirements.map(toJobRequirementDTO).filter(Boolean) });
  } catch (error: any) {
    handleJobError(error, req, res, "Failed to retrieve job requirements");
  }
};

export const getJobBookings = async (req: Request, res: Response): Promise<void> => {
  try {
    const { jobId } = req.params as any;
    const actor = (req as AuthenticatedRequest).user;
    const bookings = await jobService.getJobBookings(jobId, actor);
    res.status(200).json({ success: true, data: bookings.map((b) => toBookingDTO(b, actor)).filter(Boolean) });
  } catch (error: any) {
    handleJobError(error, req, res, "Failed to retrieve job bookings");
  }
};

export const createJobRequirement = async (req: Request, res: Response): Promise<void> => {
  try {
    const { jobId } = req.params as any;
    const actor = (req as AuthenticatedRequest).user;
    const payload: CreateJobRequirementReq = req.body;
    const requirement = await jobReqService.createJobReq(jobId, payload, actor);
    res.status(201).json({ success: true, data: toJobRequirementDTO(requirement) });
  } catch (error: any) {
    handleJobError(error, req, res, "Failed to create job requirement");
  }
};

export const getRequirementDetail = async (req: Request, res: Response): Promise<void> => {
  try {
    const { jobId, requirementId } = req.params as any;
    const actor = (req as AuthenticatedRequest).user;
    const requirement = await jobReqService.getRequirementDetail(jobId, requirementId, actor);
    res.status(200).json({ success: true, data: toJobRequirementDTO(requirement) });
  } catch (error: any) {
    handleJobError(error, req, res, "Failed to retrieve requirement details");
  }
};

export const updateRequirementDemand = async (req: Request, res: Response): Promise<void> => {
  try {
    const { jobId, requirementId } = req.params as any;
    const actor = (req as AuthenticatedRequest).user;
    const { worker_count_needed } = req.body;
    const result = await jobReqService.updateRequirementDemand(
      jobId,
      requirementId,
      worker_count_needed,
      actor
    );
    res.status(200).json({
      success: true,
      data: {
        requirement: toJobRequirementDTO(result.requirement),
        capacity: result.capacity,
      },
    });
  } catch (error: any) {
    handleJobError(error, req, res, "Failed to update requirement demand");
  }
};
