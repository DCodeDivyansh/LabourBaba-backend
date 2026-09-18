import { Request, Response } from "express";
import { dispatchService } from "./dispatchServices";
import { AuthenticatedRequest } from "../../middlewares/authMiddleware";
import { UserRole } from "../../type/userRole";

const getWorkerId = (req: Request): string | null => {
  const authReq = req as AuthenticatedRequest;
  if (!authReq.user || authReq.user.role !== UserRole.WORKER) {
    return null;
  }
  return authReq.user.id || null;
};

export const getIncoming = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) {
      res.status(401).json({ success: false, message: "Unauthorized: Worker authentication required" });
      return;
    }
    const incoming = await dispatchService.getIncomingJob(workerId);
    res.status(200).json({ success: true, data: incoming });
  } catch (error: any) {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({ success: false, message: error.message, code: error.code });
  }
};

export const acceptJob = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Unauthorized: Authentication required" });
      return;
    }
    if (authReq.user.role !== UserRole.WORKER) {
      res.status(403).json({ success: false, message: "Forbidden: Worker role required" });
      return;
    }

    // Defense-in-depth: explicitly reject client-supplied worker identity override
    if (
      (req.body as any)?.worker_id ||
      (req.body as any)?.workerId ||
      (req.query as any)?.worker_id ||
      (req.query as any)?.workerId
    ) {
      res.status(400).json({
        success: false,
        message: "Client-controlled worker identity is not permitted",
      });
      return;
    }

    const workerId = authReq.user.id;
    const { requirementId } = req.params as any;
    if (!requirementId) {
      res.status(400).json({ success: false, message: "Requirement ID is required" });
      return;
    }

    const booking = await dispatchService.acceptJob(requirementId, workerId);
    res.status(200).json({ success: true, data: booking });
  } catch (error: any) {
    const statusCode =
      error.statusCode ||
      (error.code === 'REQUIREMENT_NOT_FOUND' ? 404 :
       error.code === 'NO_VALID_DISPATCH' ? 404 :
       error.code === 'DISPATCH_EXPIRED' ? 410 :
       error.code === 'DISPATCH_ALREADY_ACCEPTED' ? 409 :
       error.code === 'SLOTS_FULL' ? 409 :
       error.code === 'BOOKING_ALREADY_EXISTS' ? 409 :
       error.message === 'SLOTS_FULL' ? 409 :
       error.message === 'REQUIREMENT_NOT_FOUND' ? 404 :
       error.message === 'NO_VALID_DISPATCH' ? 404 :
       error.message === 'DISPATCH_EXPIRED' ? 410 :
       error.message === 'DISPATCH_ALREADY_ACCEPTED' ? 409 :
       error.message === 'BOOKING_ALREADY_EXISTS' ? 409 :
       500);
    res.status(statusCode).json({ success: false, message: error.message, code: error.code });
  }
};

export const declineJob = async (req: Request, res: Response): Promise<void> => {
  try {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Unauthorized: Authentication required" });
      return;
    }
    if (authReq.user.role !== UserRole.WORKER) {
      res.status(403).json({ success: false, message: "Forbidden: Worker role required" });
      return;
    }

    if (
      (req.body as any)?.worker_id ||
      (req.body as any)?.workerId ||
      (req.query as any)?.worker_id ||
      (req.query as any)?.workerId
    ) {
      res.status(400).json({
        success: false,
        message: "Client-controlled worker identity is not permitted",
      });
      return;
    }

    const workerId = authReq.user.id;
    const { requirementId } = req.params as any;
    const response = await dispatchService.declineJob(requirementId, workerId);
    res.status(200).json(response);
  } catch (error: any) {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({ success: false, message: error.message, code: error.code });
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
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({ success: false, message: "Unauthorized: Authentication required" });
      return;
    }
    if (authReq.user.role !== UserRole.WORKER) {
      res.status(403).json({ success: false, message: "Forbidden: Worker role required" });
      return;
    }

    const workerId = authReq.user.id;
    const { requirementId } = req.params as any;
    const dispatch = await dispatchService.getDispatchDetail(requirementId, workerId);
    res.status(200).json({ success: true, data: dispatch });
  } catch (error: any) {
    const statusCode = error.statusCode || 404;
    res.status(statusCode).json({ success: false, message: error.message, code: error.code });
  }
};

