import { Request, Response } from "express";
import { jobService } from "../services/job.services";
import { jobReqService } from "../services/jobReqServices";
import { CreateJobReq, CreateJobRequirementReq } from "../type/api_req.type";
import prisma from "../config/prisma";
import { verifyToken } from "../utils/authUtils";

const getCustomerId = async (req: Request): Promise<string | null> => {
  // 1. Check if req.user is set (e.g. by auth middleware)
  if ((req as any).user?.id) {
    return (req as any).user.id;
  }
  // 2. Decode authorization header if present
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    const decoded = verifyToken(token);
    if (decoded && decoded.id) {
      return decoded.id;
    }
  }
  return null;
};

// this function will connect will create the job and its job requirement it self
export const createJob = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload: CreateJobReq = req.body;
    const authCustomerId = (req as any).user?.id;
    if (authCustomerId) {
      payload.customer_id = authCustomerId;
    }
    if (!payload.customer_id) {
      res.status(400).json({ success: false, message: "Customer ID is required" });
      return;
    }
    const job = await jobService.createJob(payload);
    res.status(201).json({ success: true, data: job });
  } catch (error: any) {
    console.log(error.message)
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getMyJobs = async (req: Request, res: Response): Promise<void> => {
  try {
    const customerId = (req as any).user?.id || String(req.query.customer_id);
    if (!customerId || customerId === "undefined" || customerId === "null") {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }
    const jobs = await jobService.getJobsByCustomer(customerId);
    res.status(200).json({ success: true, data: jobs });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getJobDetail = async (req: Request, res: Response): Promise<void> => {
  try {
    const { jobId } = req.params as any;
    const job = await jobService.getJobDetail(jobId);
    res.status(200).json({ success: true, data: job });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const cancelJob = async (req: Request, res: Response): Promise<void> => {
  try {
    const { jobId } = req.params as any;
    const customerId = await getCustomerId(req);
    if (!customerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const response = await jobService.cancelJob(jobId, customerId);
    res.status(200).json(response);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
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
