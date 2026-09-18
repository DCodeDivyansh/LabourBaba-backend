import { Request, Response } from "express";
import { adminService } from "./adminServices";
import { VerifyWorkerDocumentReq, SuspendWorkerReq } from "../../type/api_req.type";
import { AuthenticatedRequest } from "../../middlewares/authMiddleware";

export const getWorkers = async (req: Request, res: Response): Promise<void> => {
  try {
    const workers = await adminService.getWorkers();
    res.status(200).json({ success: true, data: workers });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const verifyWorker = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params as any;
    const payload: VerifyWorkerDocumentReq = req.body;
    const adminId = (req as AuthenticatedRequest).user?.id;

    const worker = await adminService.verifyWorkerDocument(id, payload);

    console.log(`[AUDIT] Admin ${adminId} verified worker ${id} with status ${payload.status} at ${new Date().toISOString()}`);
    res.status(200).json({ success: true, data: worker });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getAllJobs = async (req: Request, res: Response): Promise<void> => {
  try {
    const jobs = await adminService.getAllJobs();
    res.status(200).json({ success: true, data: jobs });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getFlaggedWorkers = async (req: Request, res: Response): Promise<void> => {
  try {
    const workers = await adminService.getFlaggedWorkers();
    res.status(200).json({ success: true, data: workers });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const suspendWorker = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params as any;
    const payload: SuspendWorkerReq = req.body;
    const adminId = (req as AuthenticatedRequest).user?.id;

    const result = await adminService.suspendWorker(id, payload);

    console.log(`[AUDIT] Admin ${adminId} suspended worker ${id} at ${new Date().toISOString()}`);
    res.status(200).json({ success: true, data: result });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
};

