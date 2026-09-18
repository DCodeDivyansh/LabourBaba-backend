import { Request, Response } from "express";
import { jobService } from "./job.services";
import { jobReqService } from "./jobReqServices";
import { CreateJobReq, CreateJobRequirementReq } from "../../type/api_req.type";
import prisma from "../../config/prisma";
import { AuthenticatedRequest } from "../../middlewares/authMiddleware";

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
    res.status(201).json({ success: true, data: job });
  } catch (error: any) {
    console.error("[createJob] Error:", error);
    res.status(500).json({ success: false, message: "Failed to create job" });
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
    res.status(200).json({ success: true, data: jobs });
  } catch (error: any) {
    console.error("[getMyJobs] Error:", error);
    res.status(500).json({ success: false, message: "Failed to retrieve jobs" });
  }
};

export const getJobDetail = async (req: Request, res: Response): Promise<void> => {
  try {
    const { jobId } = req.params as any;
    const job = await jobService.getJobDetail(jobId);
    res.status(200).json({ success: true, data: job });
  } catch (error: any) {
    if (error.message === "Job not found") {
      res.status(404).json({ success: false, message: "Job not found" });
      return;
    }
    res.status(500).json({ success: false, message: "Failed to retrieve job details" });
  }
};

export const cancelJob = async (req: Request, res: Response): Promise<void> => {
  try {
    const { jobId } = req.params as any;
    const customerId = (req as AuthenticatedRequest).user?.id;
    if (!customerId) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }
    const response = await jobService.cancelJob(jobId, customerId);
    res.status(200).json(response);
  } catch (error: any) {
    if (error.message?.includes("Forbidden") || error.message === "Unauthorized") {
      res.status(403).json({ success: false, message: "Forbidden: You do not own this job" });
      return;
    }
    if (error.message === "Job not found") {
      res.status(404).json({ success: false, message: "Job not found" });
      return;
    }
    res.status(400).json({ success: false, message: error.message || "Failed to cancel job" });
  }
};

export const getJobRequirements = async (req: Request, res: Response): Promise<void> => {
  try {
    const { jobId } = req.params as any;
    const requirements = await jobService.getJobRequirements(jobId);
    res.status(200).json({ success: true, data: requirements });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getJobBookings = async (req: Request, res: Response): Promise<void> => {
  try {
    const { jobId } = req.params as any;
    const bookings = await jobService.getJobBookings(jobId);
    res.status(200).json({ success: true, data: bookings });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const createJobRequirement = async (req: Request, res: Response): Promise<void> => {
  try {
    const { jobId } = req.params as any;
    const payload: CreateJobRequirementReq = req.body;
    const requirement = await jobReqService.createJobReq(jobId, payload);
    res.status(201).json({ success: true, data: requirement });
  } catch (error: any) {
    console.log(error.message)
    res.status(500).json({ success: false, message: error.message });
  }
};
