import { Request, Response } from "express";
import { adminService } from "./adminServices";
import { VerifyWorkerDocumentReq, SuspendWorkerReq } from "../../type/api_req.type";

const isAdmin = (req: Request) => {
  // Verify that the request has been authenticated via JWT
  return !!(req as any).user;
};

export const getWorkers = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isAdmin(req)) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const workers = await adminService.getWorkers();
    res.status(200).json({ success: true, data: workers });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const verifyWorker = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isAdmin(req)) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const { id } = req.params as any;
    const payload: VerifyWorkerDocumentReq = req.body;
    const worker = await adminService.verifyWorkerDocument(id, payload);
    res.status(200).json({ success: true, data: worker });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const getAllJobs = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isAdmin(req)) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const jobs = await adminService.getAllJobs();
    res.status(200).json({ success: true, data: jobs });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getFlaggedWorkers = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isAdmin(req)) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const workers = await adminService.getFlaggedWorkers();
    res.status(200).json({ success: true, data: workers });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const suspendWorker = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isAdmin(req)) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const { id } = req.params as any;
    const payload: SuspendWorkerReq = req.body;
    const result = await adminService.suspendWorker(id, payload);
    res.status(200).json({ success: true, data: result });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
};
