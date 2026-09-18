import { Request, Response } from "express";
import { workerService } from "./workerServices";
import { CreateWorkerReq, LoginWorkerReq, UpdateWorkerProfileReq, UpdateWorkerLocationReq, UpdateWorkerOnlineStatusReq, UploadWorkerDocumentReq } from "../../type/api_req.type";
import { AuthenticatedRequest, UserRole } from "../../middlewares/authMiddleware";
import { comparePassword, generateToken } from "../../utils/authUtils";
import prisma from "../../config/prisma";
import { workerPolicy, assertPolicy, AuthorizationError } from "../../policies";

const getWorkerId = (req: Request) => {
  return (req as AuthenticatedRequest).user?.id || null;
};

export const loginWorker = async (req: Request, res: Response): Promise<void> => {
  try {
    const { phone, password }: LoginWorkerReq = req.body;
    const worker = await prisma.worker.findUnique({
      where: { phone },
    });
    if (!worker) {
      res.status(401).json({ success: false, message: "Invalid phone number or password" });
      return;
    }
    const isPasswordValid = await comparePassword(password, worker.password);
    if (!isPasswordValid) {
      res.status(401).json({ success: false, message: "Invalid phone number or password" });
      return;
    }
    const token = generateToken({
      id: worker.id,
      phone: worker.phone,
      role: UserRole.WORKER,
    });
    res.status(200).json({
      success: true,
      message: "Worker logged in successfully",
      data: {
        id: worker.id,
        phone: worker.phone,
        name: worker.name,
        skill_type: worker.skill_type,
        verification_status: worker.verification_status,
      },
      token,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const registerWorker = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload: CreateWorkerReq = req.body;
    const worker = await workerService.register(payload);
    res.status(201).json({ success: true, data: worker });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getMe = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const worker = await workerService.getProfile(workerId);
    res.status(200).json({ success: true, data: worker });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateMe = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const payload: UpdateWorkerProfileReq = req.body;
    const worker = await workerService.updateProfile(workerId, payload);
    res.status(200).json({ success: true, data: worker });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateLocation = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    // Defense-in-depth: reject client-supplied identity in body, query, or params
    if (
      (req.body as any)?.worker_id ||
      (req.body as any)?.workerId ||
      (req.query as any)?.worker_id ||
      (req.query as any)?.workerId ||
      (req.params as any)?.worker_id ||
      (req.params as any)?.workerId
    ) {
      res.status(400).json({
        success: false,
        message: "Client-controlled worker identity is not permitted",
      });
      return;
    }

    const payload: UpdateWorkerLocationReq = req.body;
    const location = await workerService.updateLocation(workerId, payload);
    res.status(200).json({ success: true, data: location });
  } catch (error: any) {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({ success: false, message: error.message });
  }
};

export const updateOnline = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const payload: UpdateWorkerOnlineStatusReq = req.body;
    const worker = await workerService.updateOnlineStatus(workerId, payload);
    res.status(200).json({ success: true, data: worker });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const uploadDocuments = async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    assertPolicy(workerPolicy.canUploadDocuments(actor, actor.id));

    if (req.body?.worker_id && req.body.worker_id !== actor.id) {
      res.status(400).json({ success: false, message: "Client-controlled worker identity is not permitted" });
      return;
    }

    const payload: UploadWorkerDocumentReq = req.body;
    const document = await workerService.uploadDocument(actor.id, payload);
    res.status(201).json({ success: true, data: document });
  } catch (error: any) {
    if (error instanceof AuthorizationError) {
      res.status(error.status).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: error.message });
  }
};

export const requestUploadUrl = async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    assertPolicy(workerPolicy.canUploadDocuments(actor, actor.id));
    const { document_type, file_extension } = req.body;
    const result = await workerService.requestUploadUrl(actor.id, document_type, file_extension);
    res.status(200).json({ success: true, data: result });
  } catch (error: any) {
    if (error instanceof AuthorizationError) {
      res.status(error.status).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getDocuments = async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    assertPolicy(workerPolicy.canReadDocuments(actor, actor.id));
    const documents = await workerService.getDocuments(actor.id);
    res.status(200).json({ success: true, data: documents });
  } catch (error: any) {
    if (error instanceof AuthorizationError) {
      res.status(error.status).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getDocumentAccess = async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = (req as AuthenticatedRequest).user;
    if (!actor?.id) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const { documentId } = req.params as any;
    const accessDto = await workerService.getDocumentAccessUrl(actor, documentId);
    res.status(200).json({ success: true, data: accessDto });
  } catch (error: any) {
    if (error instanceof AuthorizationError) {
      res.status(error.status).json({ success: false, message: error.message });
      return;
    }
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getAnalytics = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const analytics = await workerService.getAnalytics(workerId);
    res.status(200).json({ success: true, data: analytics });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getBookings = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const bookings = await workerService.getBookings(workerId);
    res.status(200).json({ success: true, data: bookings });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getEarnings = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = getWorkerId(req);
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }
    const earnings = await workerService.getEarnings(workerId);
    res.status(200).json({ success: true, data: { earnings } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateDeviceToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = (req as any).user?.id;
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }

    if (req.body?.worker_id && req.body.worker_id !== workerId) {
      res.status(400).json({ success: false, message: "Client-controlled worker identity is not permitted" });
      return;
    }

    const { device_token, device_id, platform } = req.body;
    await workerService.updateDeviceToken(workerId, device_token, device_id, platform);
    res.status(200).json({ success: true, message: "Device token updated" });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const registerDevice = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = (req as any).user?.id;
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }

    if (req.body?.worker_id && req.body.worker_id !== workerId) {
      res.status(400).json({ success: false, message: "Client-controlled worker identity is not permitted" });
      return;
    }

    const device = await workerService.registerDevice(workerId, req.body);
    res.status(201).json({ success: true, data: device });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const revokeDevice = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = (req as any).user?.id;
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }

    const deviceId = (req.params as any)?.deviceId || req.body?.device_id;
    if (!deviceId) {
      res.status(400).json({ success: false, message: "deviceId is required" });
      return;
    }

    const result = await workerService.revokeDevice(workerId, deviceId);
    res.status(200).json({ success: true, data: result, message: "Device revoked successfully" });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getDevices = async (req: Request, res: Response): Promise<void> => {
  try {
    const workerId = (req as any).user?.id;
    if (!workerId) { res.status(401).json({ success: false, message: "Unauthorized" }); return; }

    const devices = await workerService.listDevices(workerId);
    res.status(200).json({ success: true, data: devices });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};
