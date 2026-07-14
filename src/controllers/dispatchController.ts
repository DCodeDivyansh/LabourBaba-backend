import { Request, Response } from "express";
import { dispatchService } from "../services/dispatchServices";
import { AuthenticatedRequest } from "../middlewares/authMiddleware";

const getWorkerId = (req: Request) => {
  return (req as AuthenticatedRequest).user?.id || null;
};

export const getIncoming = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const incoming = await dispatchService.getIncomingJob(workerId);
    res.status(200).json({ success: true, data: incoming });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const acceptJob = async (req: Request, res: Response): Promise<void> => {
  try {
    const { requirementId } = req.params as any;
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const booking = await dispatchService.acceptJob(requirementId, workerId);
    res.status(200).json({ success: true, data: booking });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const declineJob = async (req: Request, res: Response): Promise<void> => {
  try {
    const { requirementId } = req.params as any;
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const response = await dispatchService.declineJob(requirementId, workerId);
    res.status(200).json(response);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getWaves = async (req: Request, res: Response): Promise<void> => {
  try {
    const { requirementId } = req.params as any;
    const waves = await dispatchService.getWaves(requirementId);
    res.status(200).json({ success: true, data: waves });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};


export const getDispatchDetail = async (req: Request, res: Response): Promise<void> => {
  try {
    const { requirementId } = req.params as any;
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const dispatch = await dispatchService.getDispatchDetail(requirementId, workerId);
    res.status(200).json({ success: true, data: dispatch });
  } catch (error: any) {
    res.status(404).json({ success: false, message: error.message });
  }
};